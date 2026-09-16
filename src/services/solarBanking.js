/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Banks cheap solar into the car when today is strong and the days ahead are not.
//
// On a good day the roof makes more than the house and the car can absorb at the
// owner's usual charge limit, and the excess is exported for a few cents. If the
// next several days are forecast to be poor, that exported energy is precisely
// what will be bought back from the grid at retail. Lifting the charge limit for
// one strong day stores it in the car instead.
//
// This service does NOT participate in the diversion algorithm and deliberately
// shares no code with it. Every place the controller decides to stop charging
// compares the battery percentage against the car's own charge_limit_soc, so the
// only thing needed here is to move that ceiling and put it back afterwards. The
// controller carries on allocating surplus exactly as it did before, against a
// higher number. Nothing in controller.js changes.
//
// Two failure modes drive most of the design.
//
// Leaving the car boosted is far worse than never boosting. A limit raised and
// never restored is a silent, permanent change to something the owner set, and
// it holds the pack at a high state of charge indefinitely. So the baseline is
// written to the database BEFORE the command is sent, restore is attempted from
// several independent triggers, and a boost recorded by a previous process is
// picked up after a restart.
//
// Absence of data is not the same fact as the car being unplugged. A sleeping
// car reports no charging state at all, and PLUGGED_IN.has(null) is false, so
// treating "not plugged" as "unplugged" would tear the boost down every time the
// car dozed off in the driveway, mid-afternoon, with sun still going. Restore
// happens only on an explicitly reported disconnect.

const db       = require('../db');
const logger   = require('../utils/logger');
const solcast  = require('./solcast');
const charging = require('./charging');
const { decrypt } = require('../utils/crypto');

const CHECK_INTERVAL_MS    = 60 * 60 * 1000;  // hourly: weather moves slowly
const FIRST_CHECK_DELAY_MS = 60 * 1000;       // let telemetry settle after boot
const FORECAST_MAX_AGE_MS  = 24 * 60 * 60 * 1000;

// How many full days ahead are averaged to judge the week.
const HORIZON_DAYS = 4;

// There has to be enough sun left today for banking to be worth a command.
// Below this the car cannot absorb a useful amount before sunset anyway.
const MIN_REMAINING_KWH = 5;

// Tesla rejects anything outside this band.
const LIMIT_MIN = 50;
const LIMIT_MAX = 100;

const DEFAULT_CEILING_PCT    = 90;
const DEFAULT_WEAK_RATIO_PCT = 60;

// Mirrors the controller's own set. Duplicated rather than imported because
// controller.js does not export it, and reaching into that module for one
// constant would couple this service to the charging loop.
const PLUGGED_IN = new Set(['Stopped', 'NoPower', 'Charging', 'Complete']);

let _timer   = null;
let _started = false;

function _localDay(ms) {
  // en-CA renders as YYYY-MM-DD, which sorts lexically and matches the day
  // strings getSolcastDailyTotals() produces.
  return new Date(ms).toLocaleDateString('en-CA');
}

function _round(n) { return Math.round(n * 10) / 10; }

// Settings are matched strictly rather than parsed leniently. parseInt('90.5')
// is 90 and parseInt('abc') is NaN, and both would be acted on as though the
// owner had typed something sensible. Anything unrecognised falls back to the
// documented default, because these values are writable through the settings
// API and can arrive from a restored backup.
function _intSetting(key, fallback, min, max) {
  const raw = String(db.getSetting(key) ?? '').trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function isEnabled()   { return db.getSetting('opportunistic_charge_limit_enabled') === 'true'; }
function boostCeiling() { return _intSetting('opportunistic_charge_limit_pct', DEFAULT_CEILING_PCT, LIMIT_MIN, LIMIT_MAX); }
function weakRatioPct() { return _intSetting('opportunistic_weak_ratio_pct', DEFAULT_WEAK_RATIO_PCT, 1, 99); }

/**
 * The full-day forecast totals for the days after today, in kWh.
 *
 * The last day of a Solcast window is always truncated: the fetch covers a fixed
 * number of hours from the moment it ran, so its final calendar day stops
 * partway through and reports a fraction of its real total. Averaging that in
 * would drag the week down and trigger a boost on an artefact of when the fetch
 * happened, so it is dropped. Today is excluded too and handled separately,
 * because the window's first day is truncated at the other end.
 */
function futureFullDays(rows, todayStr) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  return rows
    .slice(0, -1)
    .filter((r) => r && typeof r.day === 'string' && r.day > todayStr)
    .map((r) => Number(r.kwh) || 0);
}

/**
 * Is today strong enough, and the week ahead weak enough, to be worth banking?
 *
 * Today's figure is what actually happened up to now plus what is still forecast
 * to come, rather than the forecast row for today, which only covers from the
 * last fetch onwards and therefore understates a day that is already half over.
 */
function decideBoost({
  todayCompletedKwh,
  todayRemainingKwh,
  futureDayKwh,
  weakRatioPct: ratio,
  minRemainingKwh = MIN_REMAINING_KWH,
  horizonDays = HORIZON_DAYS,
}) {
  const remaining = Number(todayRemainingKwh) || 0;
  if (remaining < minRemainingKwh) {
    return { boost: false, reason: `only ${_round(remaining)} kWh of sun left today` };
  }

  const days = Array.isArray(futureDayKwh) ? futureDayKwh.slice(0, horizonDays) : [];
  if (days.length < horizonDays) {
    return { boost: false, reason: `only ${days.length} full forecast days ahead, need ${horizonDays}` };
  }

  const todayFull = (Number(todayCompletedKwh) || 0) + remaining;
  if (todayFull <= 0) {
    return { boost: false, reason: 'no generation figure for today' };
  }

  const nextAvg   = days.reduce((a, b) => a + b, 0) / days.length;
  const threshold = todayFull * (ratio / 100);
  const detail    = `today ${_round(todayFull)} kWh, next ${days.length} days average `
                  + `${_round(nextAvg)} kWh (weak below ${_round(threshold)} kWh)`;

  return nextAvg < threshold
    ? { boost: true,  reason: detail, todayFullKwh: _round(todayFull), nextAvgKwh: _round(nextAvg) }
    : { boost: false, reason: `week ahead is not weak: ${detail}`, todayFullKwh: _round(todayFull), nextAvgKwh: _round(nextAvg) };
}

/**
 * The whole decision, as a pure function of the world.
 *
 * Kept separate from the code that talks to the car so that every branch,
 * including the ones that are awkward to reach in real life (a sleeping car, a
 * boost left behind by a previous process, an untrustworthy limit), can be
 * asserted directly in tests rather than mocked.
 */
function planAction({
  enabled,
  backendIsOcpp,
  chargingState,
  activeBoost,
  today,
  atHome,
  limitTrustworthy,
  forecastFresh,
  currentLimit,
  ceiling,
  forecast,
}) {
  // An OCPP charge point has no vehicle charge limit to move. Nothing to do,
  // and nothing to restore, because nothing was ever set.
  if (backendIsOcpp) return { action: 'none', reason: 'OCPP backend has no vehicle charge limit' };

  if (!enabled) {
    return activeBoost
      ? { action: 'restore', reason: 'feature turned off' }
      : { action: 'none',    reason: 'feature is off' };
  }

  // Explicitly reported as not plugged in. A null state means the car is asleep
  // or has not reported yet, which is not evidence of anything.
  const knownUnplugged = chargingState != null && !PLUGGED_IN.has(chargingState);

  if (activeBoost) {
    if (knownUnplugged)                                  return { action: 'restore', reason: 'car unplugged' };
    if (activeBoost.day && activeBoost.day !== today)    return { action: 'restore', reason: 'boost day ended' };
    return { action: 'none', reason: 'boost already active' };
  }

  if (chargingState == null)              return { action: 'none', reason: 'no charge state yet' };
  if (!PLUGGED_IN.has(chargingState))     return { action: 'none', reason: 'car is not plugged in' };
  if (!atHome)                            return { action: 'none', reason: 'car is not at home' };
  if (!limitTrustworthy)                  return { action: 'none', reason: 'charge limit not confirmed by the car' };
  if (!forecastFresh)                     return { action: 'none', reason: 'solar forecast is stale or missing' };

  if (!Number.isFinite(currentLimit) || currentLimit < LIMIT_MIN || currentLimit > LIMIT_MAX) {
    return { action: 'none', reason: `current charge limit (${currentLimit}) is outside ${LIMIT_MIN}-${LIMIT_MAX}` };
  }
  if (currentLimit >= ceiling) {
    return { action: 'none', reason: `charge limit is already at or above ${ceiling}%` };
  }
  if (!forecast || !forecast.boost) {
    return { action: 'none', reason: (forecast && forecast.reason) || 'no forecast decision' };
  }

  return { action: 'boost', reason: forecast.reason, from: currentLimit, to: ceiling };
}

/**
 * A boost this service believes is in effect, or null.
 *
 * Read back from the database rather than kept in memory so a restart mid-boost
 * still knows what the owner's limit was.
 */
function activeBoost() {
  const baseline = _intSetting('opportunistic_boost_baseline_pct', 0, LIMIT_MIN, LIMIT_MAX);
  if (!baseline) return null;
  return {
    baseline,
    day:       String(db.getSetting('opportunistic_boost_day') || ''),
    startedAt: Number(db.getSetting('opportunistic_boost_started_at')) || null,
  };
}

function _recordBoost(baseline, day) {
  db.setSetting('opportunistic_boost_baseline_pct', String(baseline));
  db.setSetting('opportunistic_boost_day',          day);
  db.setSetting('opportunistic_boost_started_at',   String(Date.now()));
}

function _clearBoost() {
  db.setSetting('opportunistic_boost_baseline_pct', '');
  db.setSetting('opportunistic_boost_day',          '');
  db.setSetting('opportunistic_boost_started_at',   '');
}

function _haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Permissive in the same way the controller's geofence is: no configured home
// and no GPS fix both mean "cannot tell", and a car that is plugged in is
// overwhelmingly likely to be on its own charger. BLE mode has no GPS at all.
function isAtHome(state) {
  const lat = parseFloat(db.getSetting('home_latitude')  || '');
  const lon = parseFloat(db.getSetting('home_longitude') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
  if (state.latitude == null || state.longitude == null) return true;
  const radius = parseFloat(db.getSetting('home_radius_km') || '0.5') || 0.5;
  return _haversineKm(lat, lon, state.latitude, state.longitude) <= radius;
}

/**
 * Whether the charge limit we hold came from the car this boot.
 *
 * Age deliberately is not the test. Fleet Telemetry only pushes ChargeLimitSoc
 * when it changes, so a limit the owner set months ago is legitimately old and
 * perfectly correct. What matters is the source: a value restored from the
 * persisted cache is exactly the one that has been observed disagreeing with
 * Tesla, and capturing that as the baseline would later "restore" the car to a
 * number the owner never chose.
 */
function limitTrustworthy(state) {
  if (!Number.isFinite(charging.telemetry.getChargeLimitAge())) return false;
  return state.chargeLimitSource === 'telemetry' || state.chargeLimitSource === 'api';
}

function forecastFresh() {
  const row  = db.getLastSolcastFetch();
  const last = row && row.last_fetch;
  return !!last && (Date.now() - Number(last)) < FORECAST_MAX_AGE_MS;
}

function _commandContext() {
  const vin = db.getSetting('tesla_vin');
  if (!vin) return null;

  let accessToken = null;
  try {
    const row = db.getToken('tesla');
    if (row) accessToken = JSON.parse(decrypt(row.token_data)).access_token;
  } catch (_e) {
    accessToken = null;
  }

  // BLE commands are signed by the local proxy and carry no Fleet token, which
  // is how the controller's own _canSendCommands() treats them.
  if (!accessToken && !charging.useBleCommands()) return null;
  return { vin, accessToken };
}

async function _writeLimit(pct) {
  const ctx = _commandContext();
  if (!ctx) throw new Error('no VIN or usable command credentials');
  const { setChargeLimit } = require('./tesla');
  await setChargeLimit(ctx.vin, pct, ctx.accessToken);
  // Keep our own cache in step immediately. Tesla has accepted the value, so
  // continuing to report the old one would make the controller stop against a
  // ceiling that no longer exists.
  charging.telemetry.setChargeLimitLocal(pct, 'command');
}

async function _restore(reason) {
  const active = activeBoost();
  if (!active) return false;
  try {
    await _writeLimit(active.baseline);
    _clearBoost();
    logger.logEvent('command', `[solar-banking] Charge limit restored to ${active.baseline}% (${reason})`);
    return true;
  } catch (err) {
    // The record stays. Being wrong about having restored is the one mistake
    // that leaves the owner's limit permanently changed, so the next tick tries
    // again rather than forgetting the baseline.
    logger.logEvent('api_error',
      `[solar-banking] Could not restore charge limit to ${active.baseline}%: ${err.message}`);
    return false;
  }
}

async function tick() {
  try {
    const state = charging.telemetry.getState() || {};
    const today = _localDay(Date.now());

    let forecast = null;
    const rows = (typeof db.getSolcastDailyTotals === 'function' ? db.getSolcastDailyTotals() : []) || [];
    const todayRow = rows.find((r) => r && r.day === today);
    if (todayRow) {
      forecast = decideBoost({
        todayCompletedKwh: solcast.getTodayCompletedGeneration(),
        todayRemainingKwh: todayRow.remaining_kwh,
        futureDayKwh:      futureFullDays(rows, today),
        weakRatioPct:      weakRatioPct(),
      });
    }

    const plan = planAction({
      enabled:          isEnabled(),
      backendIsOcpp:    db.getSetting('charging_backend') === 'ocpp',
      chargingState:    state.chargingState,
      activeBoost:      activeBoost(),
      today,
      atHome:           isAtHome(state),
      limitTrustworthy: limitTrustworthy(state),
      forecastFresh:    forecastFresh(),
      currentLimit:     Number(state.chargeLimit),
      ceiling:          boostCeiling(),
      forecast,
    });

    if (plan.action === 'restore') { await _restore(plan.reason); return plan; }
    if (plan.action !== 'boost')   { return plan; }

    // Recorded before the command is sent, not after. If the write turns out to
    // have landed despite reporting an error, the baseline is already safe on
    // disk and the limit will still be put back.
    _recordBoost(plan.from, today);
    try {
      await _writeLimit(plan.to);
      logger.logEvent('command',
        `[solar-banking] Charge limit raised ${plan.from}% to ${plan.to}% to bank solar: ${plan.reason}`);
    } catch (err) {
      logger.logEvent('api_error',
        `[solar-banking] Could not raise charge limit to ${plan.to}%: ${err.message}`);
    }
    return plan;
  } catch (err) {
    logger.logEvent('api_error', `[solar-banking] Check failed: ${err.message}`);
    return { action: 'none', reason: `error: ${err.message}` };
  }
}

function start() {
  if (_started) return;
  _started = true;
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  _timer = setInterval(tick, CHECK_INTERVAL_MS);
  logger.logEvent('info', '[solar-banking] Service started (checks hourly)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
}

module.exports = {
  start, stop, tick,
  // Exported for tests and for the settings UI to stay honest about defaults.
  planAction, decideBoost, futureFullDays, activeBoost,
  isEnabled, boostCeiling, weakRatioPct, isAtHome, limitTrustworthy, forecastFresh,
  PLUGGED_IN, HORIZON_DAYS, MIN_REMAINING_KWH, DEFAULT_CEILING_PCT, DEFAULT_WEAK_RATIO_PCT,
};
