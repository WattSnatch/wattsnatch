/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Lets departure charging reach a target above the car's own charge limit.
//
// Departure charging (the overnight trip check, or a trip's "charge to N%" button) starts and
// stops the charge on its own target, but the car still stops itself at its own charge limit.
// So a trip that needs 100% on a car limited to 80% left at 80%, while the overnight
// notification promised 100%. Found 2026-10-23, the night before a long round trip that a
// full battery only just covers.
//
// When a departure's charging window is open and its target is above the car's limit, the
// limit is raised to the target and put back afterwards. The same discipline as solar banking,
// because leaving it raised is the worse failure: a silent, permanent change to something the
// owner set, holding the pack high indefinitely.
//   - The owner's limit is written to the database BEFORE the raise is sent, and read back
//     after a restart, so a raise is never forgotten.
//   - It is read fresh from the car at the moment of raising, not taken from the cache, which
//     can be a stale value carried over from before a restart.
//   - Restore is retried until the car accepts it. It happens as soon as the departure is over
//     (target reached, time passed, cancelled) or the car is unplugged, and only while the car
//     is home, since Bluetooth cannot reach it anywhere else.
//   - Local pairing (the Charging Manager key) cannot set a charge limit at all, so it never
//     tries, and the owner is told once to raise the limit themselves.

const db       = require('../db');
const logger   = require('../utils/logger');
const charging = require('./charging');
const { decrypt } = require('../utils/crypto');

const TICK_MS          = 60 * 1000;      // the departure window opens 6 h out; a minute is plenty
const RETRY_MS         = 5 * 60 * 1000;  // between attempts after a failed raise or restore
const LIMIT_MIN = 50;                    // Tesla rejects anything outside this band
const LIMIT_MAX = 100;
const PLUGGED_IN = new Set(['Stopped', 'NoPower', 'Charging', 'Complete']);

let _timer = null;
let _started = false;
let _busy = false;
let _lastAttemptAt = 0;
let _warnedFor = null;                   // departure time we already warned about (local pairing)

function _int(key) {
  const n = parseInt(db.getSetting(key), 10);
  return Number.isFinite(n) ? n : 0;
}

/** The raise this service believes is in effect, or null. Read from the database. */
function activeRaise() {
  const baseline = _int('departure_limit_baseline_pct');
  if (baseline < LIMIT_MIN || baseline > LIMIT_MAX) return null;
  return {
    baseline,
    raisedTo:      _int('departure_limit_raised_to_pct') || null,
    departureTime: Number(db.getSetting('departure_limit_departure_time')) || null,
  };
}

function _record(baseline, raisedTo, departureTime) {
  db.setSetting('departure_limit_baseline_pct',   String(baseline));
  db.setSetting('departure_limit_raised_to_pct',  String(raisedTo));
  db.setSetting('departure_limit_departure_time', String(departureTime));
}

function _clear() {
  db.setSetting('departure_limit_baseline_pct',   '');
  db.setSetting('departure_limit_raised_to_pct',  '');
  db.setSetting('departure_limit_departure_time', '');
}

/**
 * Decide what to do. Pure, so every branch can be tested directly.
 *
 * decision      - departureScheduler.getDepartureDecision() result
 * raise         - activeRaise()
 * chargingState - car's reported state (null = asleep / unknown, NOT unplugged)
 * currentLimit  - car's limit as we last know it (only used to decide whether to look closer)
 */
function plan({ decision, raise, chargingState, currentLimit, atHome, localPairing, backendIsOcpp, now }) {
  if (backendIsOcpp) return { action: 'none', reason: 'OCPP charge points have no vehicle charge limit' };

  const knownUnplugged = chargingState != null && !PLUGGED_IN.has(chargingState);

  if (raise) {
    const departureOver = !decision || !decision.active || decision.targetReached
      || (raise.departureTime && now >= raise.departureTime)
      || (decision.departureTime && raise.departureTime && decision.departureTime !== raise.departureTime);
    if (departureOver || knownUnplugged) {
      if (!atHome) return { action: 'none', reason: 'restore due, waiting for the car to be home' };
      return { action: 'restore', reason: knownUnplugged ? 'car unplugged' : 'departure over',
        to: raise.baseline };
    }
    return { action: 'none', reason: 'raised for this departure' };
  }

  if (!decision || !decision.active || decision.targetReached) return { action: 'none', reason: 'no departure charging due' };
  if (!decision.needsGridCharge) return { action: 'none', reason: 'departure charging window not open yet' };
  const target = Math.min(LIMIT_MAX, Math.ceil(decision.targetSoc));
  if (Number.isFinite(currentLimit) && currentLimit >= target) {
    return { action: 'none', reason: `charge limit ${currentLimit}% already covers the ${target}% target` };
  }
  if (localPairing) {
    return { action: 'warn', reason: 'local pairing cannot set the charge limit', target };
  }
  if (chargingState == null) return { action: 'none', reason: 'car state unknown (asleep?) - will retry' };
  if (knownUnplugged)        return { action: 'none', reason: 'car is not plugged in' };
  if (!atHome)               return { action: 'none', reason: 'car is not at home' };
  return { action: 'raise', target, departureTime: decision.departureTime };
}

function _commandContext() {
  const vin = db.getSetting('tesla_vin');
  if (!vin) return null;
  let accessToken = null;
  try {
    const row = db.getToken('tesla');
    if (row) accessToken = JSON.parse(decrypt(row.token_data)).access_token;
  } catch (_e) { accessToken = null; }
  if (!accessToken && !charging.useBleCommands()) return null;
  return { vin, accessToken };
}

/** The car's limit right now, asked of the car itself. */
async function _readLimitFromCar(ctx) {
  if (charging.useBleCommands()) {
    const d = await charging.getVehicleDataBle(ctx.vin);
    return Number(d && d.chargeLimit);
  }
  const { chargeState } = await charging.getVehicleData(ctx.vin, ctx.accessToken);
  return Number(chargeState && chargeState.charge_limit_soc);
}

async function _writeLimit(ctx, pct) {
  const { setChargeLimit } = require('./tesla');
  await setChargeLimit(ctx.vin, pct, ctx.accessToken);
  charging.telemetry.setChargeLimitLocal(pct, 'command');
}

function _notify(title, msg) {
  try { require('./notifications').sendNotification(title, msg, 'high').catch(() => {}); } catch (_e) { /* none */ }
}

function _atHome(state) {
  // Same rule solar banking uses: GPS geofence when there is one, otherwise assume home.
  try { return require('./solarBanking').isAtHome(state); } catch (_e) { return true; }
}

async function tick() {
  if (_busy) return { action: 'none', reason: 'busy' };
  _busy = true;
  try {
    const state = charging.telemetry.getState() || {};
    const departureScheduler = require('./departureScheduler');
    const decision = departureScheduler.getDepartureDecision(state.batteryPct, 0);
    const p = plan({
      decision,
      raise:         activeRaise(),
      chargingState: state.chargingState ?? null,
      currentLimit:  Number(state.chargeLimit),
      atHome:        _atHome(state),
      localPairing:  db.getSetting('tesla_pairing_mode') === 'local',
      backendIsOcpp: db.getSetting('charging_backend') === 'ocpp',
      now:           Date.now(),
    });

    if (p.action === 'warn') {
      if (_warnedFor !== decision.departureTime) {
        _warnedFor = decision.departureTime;
        const msg = `This trip needs ${p.target}%, above your car's ${state.chargeLimit}% charge limit, and `
          + `local Bluetooth pairing cannot change the limit. Raise it in the Tesla app, or the car will stop at `
          + `${state.chargeLimit}%.`;
        logger.logEvent('api_error', `[departure] ${msg}`);
        _notify('WattSnatch: raise your charge limit for this trip', msg);
      }
      return p;
    }
    if (p.action !== 'raise' && p.action !== 'restore') return p;
    if (Date.now() - _lastAttemptAt < RETRY_MS) return { action: 'none', reason: 'waiting to retry' };
    _lastAttemptAt = Date.now();

    const ctx = _commandContext();
    if (!ctx) {
      logger.logEvent('api_error', '[departure] Cannot change the charge limit: no VIN or usable command credentials');
      return { action: 'none', reason: 'no command context' };
    }

    if (p.action === 'restore') {
      try {
        await _writeLimit(ctx, p.to);
        _clear();
        logger.logEvent('command', `[departure] Charge limit restored to ${p.to}% (${p.reason})`);
      } catch (err) {
        // The record stays, so the next attempt still knows what to put back.
        logger.logEvent('api_error', `[departure] Could not restore charge limit to ${p.to}%: ${err.message}`);
      }
      return p;
    }

    // Raise. Ask the car for its limit first: that is the owner's real setting, and the one
    // to put back. The cache can hold a value carried over from before a restart.
    let fromCar;
    try {
      fromCar = await _readLimitFromCar(ctx);
    } catch (err) {
      logger.logEvent('info', `[departure] Could not read the charge limit from the car yet: ${err.message}`);
      return { action: 'none', reason: 'could not read limit from car' };
    }
    if (!Number.isFinite(fromCar) || fromCar < LIMIT_MIN || fromCar > LIMIT_MAX) {
      logger.logEvent('api_error', `[departure] Car reported an unusable charge limit (${fromCar}) - not changing it`);
      return { action: 'none', reason: 'unusable limit from car' };
    }
    if (fromCar >= p.target) {
      charging.telemetry.setChargeLimitLocal(fromCar, 'command');
      return { action: 'none', reason: `car's limit ${fromCar}% already covers the target` };
    }
    _record(fromCar, p.target, p.departureTime);   // before the command, never after
    try {
      await _writeLimit(ctx, p.target);
      logger.logEvent('command',
        `[departure] Charge limit raised ${fromCar}% to ${p.target}% for the departure at `
        + `${new Date(p.departureTime).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}; `
        + `it will be put back to ${fromCar}% afterwards`);
    } catch (err) {
      logger.logEvent('api_error', `[departure] Could not raise charge limit to ${p.target}%: ${err.message}`);
      // The baseline stays recorded. If the write did land, it still gets put back; if it did
      // not, restoring the owner's own value is harmless.
    }
    return p;
  } catch (err) {
    logger.logEvent('api_error', `[departure] Charge limit check failed: ${err.message}`);
    return { action: 'none', reason: `error: ${err.message}` };
  } finally {
    _busy = false;
  }
}

/** For the overnight notification: what will happen to a target above the car's limit. */
function limitNote(targetSoc, carLimit) {
  if (!Number.isFinite(carLimit) || carLimit >= targetSoc) return '';
  if (db.getSetting('tesla_pairing_mode') === 'local') {
    return `Your charge limit is ${carLimit}%, which local pairing cannot change: raise it in the Tesla app or the car will stop at ${carLimit}%.`;
  }
  return `The charge limit will be raised from ${carLimit}% to ${Math.min(100, Math.ceil(targetSoc))}% for this trip and put back afterwards.`;
}

function start() {
  if (_started) return;
  _started = true;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 30 * 1000);
  logger.logEvent('info', '[departure] Charge limit helper started (checks every minute)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
}

module.exports = {
  start, stop, tick, plan, activeRaise, limitNote,
  _resetForTests: () => { _lastAttemptAt = 0; _warnedFor = null; _busy = false; },
};
