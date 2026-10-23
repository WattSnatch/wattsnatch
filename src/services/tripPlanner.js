/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../db');
const notifications = require('./notifications');

// Fallback only. The real value is the user's configured Tesla Battery Capacity (kWh) from
// Settings - a Model Y LR is 82, but a 2021 M3 SR+ is ~55, so hardcoding 82 mis-sized trip
// energy for everyone who is not on a Long Range (issue #16). Read per call via
// `_batteryCapacityKwh()` so a Settings change takes effect without a restart.
const MODEL_Y_LR_CAPACITY_KWH = 82;
function _batteryCapacityKwh() {
  const v = parseFloat(db.getSetting('tesla_battery_kwh'));
  return Number.isFinite(v) && v > 0 ? v : MODEL_Y_LR_CAPACITY_KWH;
}
const FLOOR_SOC_PCT = 20;      // never go below 20%
const BUFFER_FRACTION = 0;     // floor SoC (20%) already covers the safety margin
const SENTRY_DEFAULT_KWH_PER_HOUR = 0.20; // fallback if TeslaMate has no data
const EFFICIENCY_DEFAULT_KWH_PER_KM = 0.155;

let _assessments = [];
let _lastRun = null;
let _plannerTimer = null;
let _started = false;

// ── Trip energy calculation ───────────────────────────────────────────────────

async function calculateTripRequirement(destinationKm, destinationHours) {
  const teslamate = require('./teslamate');

  const effResult  = await teslamate.getEfficiencyKwhPerKm();
  const sentryResult = await teslamate.getSentryDrainRateKwhPerHour();
  const healthResult = await teslamate.getBatteryHealthPercent();

  const efficiency    = effResult    ? effResult.kwh_per_km           : EFFICIENCY_DEFAULT_KWH_PER_KM;
  const sentryRate    = sentryResult ? sentryResult.kwh_per_hour       : SENTRY_DEFAULT_KWH_PER_HOUR;
  const healthPct     = healthResult ? healthResult.health_pct         : 100;
  const usableCapacity = _batteryCapacityKwh() * (healthPct / 100);

  const driveOut  = destinationKm * efficiency;
  const driveHome = destinationKm * efficiency;
  // Sentry only while parked at destination (not while waiting at home - user has sentry off at home)
  const sentry    = sentryRate * destinationHours;
  const buffer    = usableCapacity * BUFFER_FRACTION;
  const total     = driveOut + driveHome + sentry + buffer;

  const minimumSocRequired = ((total / usableCapacity) * 100) + FLOOR_SOC_PCT;

  return {
    driveOut:            Math.round(driveOut  * 100) / 100,
    driveHome:           Math.round(driveHome * 100) / 100,
    sentry:              Math.round(sentry    * 100) / 100,
    buffer:              Math.round(buffer    * 100) / 100,
    total:               Math.round(total     * 100) / 100,
    usableCapacity:      Math.round(usableCapacity * 100) / 100,
    minimumSocRequired:  Math.min(100, Math.round(minimumSocRequired * 10) / 10),
    efficiency,
    sentryRate,
    healthPct,
  };
}

// ── Feasibility assessment ────────────────────────────────────────────────────

async function assessTripFeasibility(trip) {
  const telemetry = require('./telemetry');
  // Prefer live Fleet Telemetry; fall back to last non-zero DB reading.
  // getLastTelemetry() can return battery_pct=0 because the controller logs 0 until
  // Fleet Telemetry pushes the first battery update after startup.
  let currentSocPct = telemetry.getState().batteryPct;
  if (!currentSocPct) {
    const lastRow = db.getDb().prepare(
      'SELECT battery_pct FROM telemetry_log WHERE battery_pct > 0 ORDER BY recorded_at DESC LIMIT 1'
    ).get();
    currentSocPct = lastRow?.battery_pct || 0;
  }

  const teslamate = require('./teslamate');
  const healthResult   = await teslamate.getBatteryHealthPercent();
  const healthPct      = healthResult ? healthResult.health_pct : 100;
  const usableCapacity = _batteryCapacityKwh() * (healthPct / 100);

  const currentSocKwh  = (currentSocPct / 100) * usableCapacity;
  const required       = await calculateTripRequirement(trip.distanceKm, trip.eventDurationHours ?? 2);
  const minimumSocKwh  = usableCapacity * (FLOOR_SOC_PCT / 100);
  const availableKwh   = currentSocKwh - minimumSocKwh;
  const deficit        = required.total - availableKwh;
  // What the battery can still take before it is full. No plan can add more than this, so a
  // deficit larger than it means the trip cannot be done on one charge at all, however much
  // grid or solar is available beforehand: it needs a charging stop on the way (issue #27,
  // where a 78.6 kWh trip on a smaller pack was told to take 18.6 kWh from the grid into a
  // battery with room for about 6).
  const roomKwh        = Math.max(0, usableCapacity - currentSocKwh);
  const exceedsBattery = deficit > roomKwh;
  const chargeStopKwh  = exceedsBattery ? deficit - roomKwh : 0;

  if (deficit <= 0) {
    return {
      status: 'OK',
      message: null,
      currentSocPct,
      currentSocKwh: Math.round(currentSocKwh * 100) / 100,
      required,
      deficit: 0,
    };
  }

  // Check expected solar contribution before departure
  let expectedDiversion = 0;
  try {
    const solcastKey = db.getSetting('solcast_api_key');
    if (solcastKey) {
      const solcast = require('./solcast');
      const forecast = await solcast.getExpectedKwhInWindow(Date.now(), trip.departureTime);
      expectedDiversion = (forecast || 0) * 0.7; // 70% of forecast likely to charge EV
    }
  } catch (_) {}

  const destName = trip.location || trip.summary || 'destination';

  if (exceedsBattery) {
    // Best possible preparation is a full battery. Solar fills what it can of the room left,
    // the grid the rest, and the remainder has to come from charging on the way.
    const gridKwh = Math.max(0, roomKwh - Math.min(expectedDiversion, roomKwh));
    const gridRate = db.getRateAtTimestamp(trip.departureTime || Date.now());
    const cost = Math.round(gridKwh * gridRate * 100) / 100;
    return {
      status: 'NEEDS_ATTENTION',
      exceedsBattery: true,
      chargeStopKwh: Math.round(chargeStopKwh * 100) / 100,
      message: `Even charged to 100%, ${destName} and back needs about ${chargeStopKwh.toFixed(1)} kWh `
        + `more than the battery holds above 20%, so plan a charging stop on the way. `
        + (gridKwh > 0
          ? `Charging to 100% before you leave needs ${gridKwh.toFixed(1)} kWh from the grid (~$${cost}).`
          : 'Solar should fill the battery before you leave.'),
      currentSocPct,
      currentSocKwh:  Math.round(currentSocKwh  * 100) / 100,
      required,
      deficit:        Math.round(deficit         * 100) / 100,
      solarShortfall: Math.round(gridKwh         * 100) / 100,
      estimatedCost:  cost,
      expectedSolar:  Math.round(expectedDiversion * 100) / 100,
    };
  }

  if (expectedDiversion >= deficit) {
    return {
      status: 'SOLAR_WILL_COVER',
      message: null,
      currentSocPct,
      currentSocKwh: Math.round(currentSocKwh * 100) / 100,
      required,
      deficit: Math.round(deficit * 100) / 100,
      expectedSolar: Math.round(expectedDiversion * 100) / 100,
    };
  }

  const solarShortfall = deficit - expectedDiversion;
  const gridRate       = db.getRateAtTimestamp(trip.departureTime || Date.now());
  const cost           = Math.round(solarShortfall * gridRate * 100) / 100;

  const depDate  = new Date(trip.departureTime).toLocaleString('en-AU', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });

  return {
    status: 'NEEDS_ATTENTION',
    // No "Approve?" here: this text is shown on the dashboard, where scheduling is done with the
    // trip's own charge button. The push notification keeps its question, because it carries
    // an Approve action.
    message: `Can't reach ${destName} and back above 20% on solar alone. ` +
             `About ${solarShortfall.toFixed(1)} kWh needs to come from the grid (~$${cost}).`,
    currentSocPct,
    currentSocKwh:  Math.round(currentSocKwh  * 100) / 100,
    required,
    deficit:        Math.round(deficit         * 100) / 100,
    solarShortfall: Math.round(solarShortfall  * 100) / 100,
    estimatedCost:  cost,
    expectedSolar:  Math.round(expectedDiversion * 100) / 100,
    depDate,
  };
}

// ── Run all upcoming trip assessments ────────────────────────────────────────

async function assessAll() {
  try {
    const calendar = require('./calendar');
    if (!calendar.isConfigured()) return;

    const { trips } = calendar.getState();
    const results = [];

    for (const trip of trips) {
      const assessment = await assessTripFeasibility(trip);
      results.push({ trip, assessment });
    }

    _assessments = results;
    _lastRun = Date.now();

    // Log any NEEDS_ATTENTION trips to trip_log (deduped by departure time)
    for (const { trip, assessment } of results) {
      if (assessment.status !== 'NEEDS_ATTENTION') continue;
      const existing = db.getPendingTripLogs().find(
        (t) => t.departure_time === trip.departureTime && t.destination_name === trip.location
      );
      if (!existing) {
        db.insertTripLog({
          destination_name: trip.location,
          destination_id:   trip.destId,
          distance_km:      trip.distanceKm,
          departure_time:   trip.departureTime,
          predicted_kwh:    assessment.required.total,
        });
        // Send push notification for trip that needs grid top-up. Not when solar alone will
        // fill the battery: "need 0.0 kWh from grid, approve?" would be noise.
        if (assessment.solarShortfall > 0) {
          notifications.notifyTripNeedsGridTopUp(
            trip.location || 'destination',
            assessment.solarShortfall,
            assessment.estimatedCost,
            assessment.exceedsBattery
              ? `Even at 100% you will need about ${assessment.chargeStopKwh.toFixed(1)} kWh from a charging stop on the way.`
              : ''
          ).catch(err => console.warn('[tripPlanner] notification failed:', err.message));
        }
      }
    }
  } catch (err) {
    console.warn('[tripPlanner] assessAll error:', err.message);
  }
}

// ── Trip completion logging ───────────────────────────────────────────────────

async function checkTripCompletions() {
  try {
    const pending = db.getPendingTripLogs();
    if (pending.length === 0) return;

    const telemetry = require('./telemetry');
    const isAtHome  = telemetry.getState().latitude != null; // basic check

    const teslamate = require('./teslamate');
    const homeLat = parseFloat(db.getSetting('home_latitude') || '0');
    const homeLng = parseFloat(db.getSetting('home_longitude') || '0');
    if (!homeLat || !homeLng) return;

    // Get drives completed in last 8 hours
    const recentDrives = await teslamate.getRecentDrivesNearHome(homeLat, homeLng, 0.5);
    if (!recentDrives || recentDrives.length === 0) return;

    const { haversineKm } = require('./calendar');
    const calendar = require('./calendar');

    for (const logEntry of pending) {
      // Find a completed drive that matches this trip (departure time within 4 hours)
      const matchingDrive = recentDrives.find((drive) => {
        const driveStart = new Date(drive.start_date).getTime();
        return Math.abs(driveStart - logEntry.departure_time) < 4 * 60 * 60 * 1000;
      });

      if (!matchingDrive) continue;

      const actualKwh = matchingDrive.charge_energy_added || null;
      const endSocPct = matchingDrive.end_battery_level   || 0;
      const floorMaintained = endSocPct >= FLOOR_SOC_PCT;

      db.completeTripLog(logEntry.id, {
        actual_kwh: actualKwh,
        floor_maintained: floorMaintained,
      });

      // Update avg_kwh for this destination
      if (logEntry.destination_id && actualKwh) {
        db.updateDestinationAvgKwh(logEntry.destination_id, actualKwh);
      }

      console.log(`[tripPlanner] Completed trip to "${logEntry.destination_name}" - actual ${actualKwh} kWh, floor ${floorMaintained ? 'maintained' : 'BREACHED'}`);
    }
  } catch (err) {
    console.warn('[tripPlanner] checkTripCompletions error:', err.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function getAssessments() {
  return { assessments: _assessments, lastRun: _lastRun };
}

// Return the soonest trip departing within the next 18 hours (any status), with
// the fields the controller needs to decide whether to lower the solar-diversion
// threshold. Returns null when no trip is imminent. Read-only - reads the
// in-memory assessments computed by assessAll(), no I/O.
const TRIP_LOOKAHEAD_MS = 18 * 60 * 60 * 1000;

function getNextTripRequirement() {
  const now = Date.now();
  const upcoming = _assessments
    .filter(({ trip }) => trip.departureTime > now && (trip.departureTime - now) <= TRIP_LOOKAHEAD_MS)
    .sort((a, b) => a.trip.departureTime - b.trip.departureTime);
  if (upcoming.length === 0) return null;

  const { trip, assessment } = upcoming[0];
  return {
    status:             assessment.status,
    location:           trip.location,
    summary:            trip.summary,
    departureTime:      trip.departureTime,
    hoursAway:          trip.hoursAway,
    currentSocPct:      assessment.currentSocPct,
    minimumSocRequired: assessment.required ? assessment.required.minimumSocRequired : null,
    deficit:            assessment.deficit,
  };
}

async function runOnce() {
  await assessAll();
  await checkTripCompletions();
}

function start() {
  if (_started) return;
  _started = true;

  // Run immediately, then every 5 minutes
  runOnce().catch(() => {});
  _plannerTimer = setInterval(() => runOnce().catch(() => {}), 5 * 60 * 1000);
}

function stop() {
  if (_plannerTimer) { clearInterval(_plannerTimer); _plannerTimer = null; }
  _started = false;
}

// ── Multi-stop journey chaining ───────────────────────────────────────────────

// If the gap between event end and the next event start is under this threshold,
// treat them as one continuous journey (home → A → B → home) rather than separate
// round trips. Covers "back-to-back" events with only a short drive between venues.
const CHAIN_GAP_MS = 90 * 60 * 1000;

function groupIntoChains(trips) {
  const chains = [];
  let current = [];
  for (const trip of trips) {
    if (current.length === 0) {
      current.push(trip);
      continue;
    }
    const prev    = current[current.length - 1];
    const prevEnd = prev.departureTime + (prev.eventDurationHours || 2) * 3600000;
    if (trip.departureTime - prevEnd < CHAIN_GAP_MS) {
      current.push(trip);
    } else {
      chains.push([...current]);
      current = [trip];
    }
  }
  if (current.length > 0) chains.push(current);
  return chains;
}

function getDestCoords(destId) {
  if (!destId) return null;
  const row = db.getDb().prepare('SELECT lat, lng FROM known_destinations WHERE id = ?').get(destId);
  return row?.lat != null ? { lat: row.lat, lng: row.lng } : null;
}

async function calcChainEnergy(chain, efficiency, sentryRate) {
  const { haversineKm } = require('./calendar');

  if (chain.length === 1) {
    const trip = chain[0];
    return 2 * trip.distanceKm * efficiency + sentryRate * (trip.eventDurationHours || 2);
  }

  // Multi-stop: home → dest1 → dest2 → … → home
  let totalKm = chain[0].distanceKm; // home → first destination
  for (let i = 1; i < chain.length; i++) {
    const a = getDestCoords(chain[i - 1].destId);
    const b = getDestCoords(chain[i].destId);
    if (a && b) {
      // Round up - same small safety buffer as the home<->destination
      // distances, so an under-estimated leg can't leave the car short.
      totalKm += Math.ceil(haversineKm(a.lat, a.lng, b.lat, b.lng));
    } else {
      // No coords for one of the stops - conservative fallback: add its distance from home
      totalKm += chain[i].distanceKm;
    }
  }
  totalKm += chain[chain.length - 1].distanceKm; // last destination → home

  const sentryKwh = chain.reduce((s, t) => s + sentryRate * (t.eventDurationHours || 2), 0);
  return totalKm * efficiency + sentryKwh;
}

// ── Midnight charge check ─────────────────────────────────────────────────────

async function runMidnightTripCheck() {
  const logger = require('../utils/logger');
  try {
    // On by default - a single early gate, so the calculation/scheduling
    // logic below is completely untouched when this runs normally.
    if (db.getSetting('auto_trip_charging_enabled') === 'false') {
      logger.logEvent('info', '[tripPlanner] Midnight check: automatic overnight trip charging is turned off in Settings - skipping');
      return;
    }

    const calendar = require('./calendar');
    if (!calendar.isConfigured()) return;

    // Refresh calendar so we have the latest events
    await calendar.poll().catch(err =>
      logger.logEvent('warn', `[tripPlanner] Midnight calendar refresh failed: ${err.message}`)
    );

    // Collect tomorrow's driving events
    const tomorrowStart = new Date();
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

    const { trips: allTrips } = calendar.getState();
    const tomorrowTrips = allTrips
      .filter(t => t.departureTime >= tomorrowStart.getTime() && t.departureTime < tomorrowEnd.getTime())
      .sort((a, b) => a.departureTime - b.departureTime);

    if (tomorrowTrips.length === 0) {
      logger.logEvent('info', '[tripPlanner] Midnight check: no driving events tomorrow');
      return;
    }

    // Battery + efficiency data
    const teslamate = require('./teslamate');
    const telemetry = require('./telemetry');

    const [effResult, sentryResult, healthResult] = await Promise.all([
      teslamate.getEfficiencyKwhPerKm().catch(() => null),
      teslamate.getSentryDrainRateKwhPerHour().catch(() => null),
      teslamate.getBatteryHealthPercent().catch(() => null),
    ]);

    const efficiency     = effResult    ? effResult.kwh_per_km     : EFFICIENCY_DEFAULT_KWH_PER_KM;
    const sentryRate     = sentryResult ? sentryResult.kwh_per_hour : SENTRY_DEFAULT_KWH_PER_HOUR;
    const healthPct      = healthResult ? healthResult.health_pct   : 100;
    const usableCapacity = _batteryCapacityKwh() * (healthPct / 100);

    let currentSocPct = telemetry.getState().batteryPct;
    if (!currentSocPct) {
      const row = db.getDb()
        .prepare('SELECT battery_pct FROM telemetry_log WHERE battery_pct > 0 ORDER BY recorded_at DESC LIMIT 1')
        .get();
      currentSocPct = row?.battery_pct || 0;
    }

    if (!currentSocPct) {
      logger.logEvent('warn', '[tripPlanner] Midnight check: battery SOC unknown - skipping');
      return;
    }

    // Group into journey chains, calculate total energy needed
    const chains    = groupIntoChains(tomorrowTrips);
    let totalTripKwh = 0;
    for (const chain of chains) {
      totalTripKwh += await calcChainEnergy(chain, efficiency, sentryRate);
    }

    const currentKwh = (currentSocPct / 100) * usableCapacity;
    const floorKwh   = usableCapacity * (FLOOR_SOC_PCT / 100);
    const neededKwh  = totalTripKwh + floorKwh;
    const chargeKwh  = neededKwh - currentKwh;

    const chainLabels = chains.map(c =>
      c.length === 1 ? c[0].summary : c.map(t => t.summary).join(' → ')
    ).join('; ');

    logger.logEvent('info',
      `[tripPlanner] Midnight check: ${chains.length} journey(s) - ${chainLabels}. ` +
      `Trips need ${totalTripKwh.toFixed(1)} kWh + ${floorKwh.toFixed(1)} kWh floor = ` +
      `${neededKwh.toFixed(1)} kWh total. Have ${currentKwh.toFixed(1)} kWh. ` +
      `Charge deficit: ${chargeKwh.toFixed(1)} kWh.`
    );

    if (chargeKwh < 0.5) {
      logger.logEvent('info', '[tripPlanner] Midnight check: battery sufficient - no grid charge needed');
      return;
    }

    const targetSocPct   = Math.min(100, Math.round(((currentKwh + chargeKwh) / usableCapacity) * 100));
    const firstDeparture = tomorrowTrips[0].departureTime;

    logger.logEvent('info',
      `[tripPlanner] Midnight check: scheduling grid charge to ${targetSocPct}% before ` +
      `${new Date(firstDeparture).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`
    );

    const departureScheduler = require('./departureScheduler');
    departureScheduler.setDeparture(firstDeparture, targetSocPct, `Overnight: ${chainLabels}`);

    // Say what will happen to a target above the car's own charge limit, instead of promising
    // a number the car would stop short of.
    const carLimit  = Number(telemetry.getState().chargeLimit);
    const limitNote = require('./departureLimit').limitNote(targetSocPct, carLimit);
    if (limitNote) logger.logEvent('info', `[tripPlanner] Midnight check: ${limitNote}`);
    // Even a full battery may not be enough; say so rather than implying 100% covers it.
    const shortAtFull = totalTripKwh + floorKwh - usableCapacity;
    const fullNote = shortAtFull > 0.5
      ? `Even at 100% you will be about ${shortAtFull.toFixed(1)} kWh short of keeping 20%, so plan a charging stop.`
      : '';
    if (fullNote) logger.logEvent('info', `[tripPlanner] Midnight check: ${fullNote}`);

    await notifications.notifyMidnightChargeScheduled(
      chains, currentSocPct, targetSocPct, firstDeparture, totalTripKwh,
      [limitNote, fullNote].filter(Boolean).join(' ')
    ).catch(() => {});

  } catch (err) {
    const logger = require('../utils/logger');
    logger.logEvent('api_error', `[tripPlanner] Midnight check failed: ${err.message}`);
    console.error('[tripPlanner] Midnight check failed:', err.message);
  }
}

module.exports = {
  start, stop, getAssessments, getNextTripRequirement, runOnce,
  calculateTripRequirement, assessTripFeasibility,
  runMidnightTripCheck,
};
