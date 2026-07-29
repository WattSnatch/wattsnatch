/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../db');
const logger = require('../utils/logger');
const myenergi = require('./myenergi');
const melcloud = require('./melcloud');
const weatherGrid = require('./weatherGrid');

// Current outside temperature from the weather service's cache (°C), or null
// if no forecast has been fetched yet - callers must treat null as "unknown",
// never as a real temperature.
function _outsideTempC() {
  const t = weatherGrid.getWeather()?.data?.current?.temp;
  return typeof t === 'number' ? t : null;
}

let _interval = null;
const RECORD_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BASELINE_LEARNING_DAYS = 14;
const ANOMALY_THRESHOLD = 1.4; // 40% above baseline

/**
 * Determine if an AC unit is on.
 */
function isAcOn() {
  const acState = melcloud.getState();
  return (acState.devices || []).some(d => d.is_on);
}

/**
 * Record current house load snapshot.
 * House load = consumption - EV - Hot Water - AC
 */
async function recordLoadSnapshot(readings) {
  if (!readings) return;

  const eddi = myenergi.getState();
  const acState = melcloud.getState();

  // Calculate AC load
  let acLoadW = 0;
  if ((acState.devices || []).some(d => d.is_on)) {
    const totalDailyKwh = acState.devices.reduce((sum, d) => sum + (d.daily_energy_kwh || 0), 0);
    acLoadW = Math.round((totalDailyKwh / 24) * 1000);
  }

  // Pure house load = consumption - all other loads
  const houseLoadW = Math.max(0, readings.consumptionW - (0) - (eddi.divertW || 0) - acLoadW);

  db.insertLoadHistory({
    recorded_at: Date.now(),
    solar_w: readings.solarW,
    house_w: houseLoadW,
    ac_on: isAcOn() ? 1 : 0,
    outside_temp_approx: _outsideTempC(),
  });
}

/**
 * Check for anomalies based on learned baselines.
 * Returns { isAnomaly: boolean, message: string | null }
 */
function checkAnomaly(readings) {
  const stats = db.getBaselineStats();
  if (!stats.baseline_ac_off) {
    return { isAnomaly: false, message: null }; // Not enough data yet
  }

  const eddi = myenergi.getState();
  const acState = melcloud.getState();

  // Calculate AC load
  let acLoadW = 0;
  if ((acState.devices || []).some(d => d.is_on)) {
    const totalDailyKwh = acState.devices.reduce((sum, d) => sum + (d.daily_energy_kwh || 0), 0);
    acLoadW = Math.round((totalDailyKwh / 24) * 1000);
  }

  // Pure house load
  const houseLoadW = Math.max(0, readings.consumptionW - (0) - (eddi.divertW || 0) - acLoadW);

  // Check if AC is on - skip anomaly flagging if it's hot (>28°C) and AC is
  // running, since high load then is expected cooling, not a fault. Unknown
  // temperature (no weather data yet) deliberately does NOT suppress - the
  // AC-on baseline below already accounts for normal AC load.
  const acOn = isAcOn();
  const outsideTemp = _outsideTempC();
  const isHotDay = outsideTemp != null && outsideTemp > 28;
  if (acOn && isHotDay) {
    return { isAnomaly: false, message: null };
  }

  // Select appropriate baseline based on AC state
  const relevantBaseline = acOn ? stats.baseline_ac_on : stats.baseline_ac_off;
  const threshold = relevantBaseline * ANOMALY_THRESHOLD;

  // Check for anomaly
  if (houseLoadW > threshold) {
    const excess = houseLoadW - relevantBaseline;
    const msg = `House load is ${Math.round(excess)}W above your typical baseline - something may be on that shouldn't be.`;
    return { isAnomaly: true, message: msg };
  }

  return { isAnomaly: false, message: null };
}

function start(readings) {
  if (_interval) return;

  logger.logEvent('info', 'baseline: starting load recording every 5 minutes');

  // Record immediately if readings available, then on interval
  if (readings) recordLoadSnapshot(readings).catch(() => {});
  _interval = setInterval(() => {
    // Readings are provided externally - for now, we store nulls
    // This will be updated when integrated with the controller
  }, RECORD_INTERVAL_MS);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = {
  start,
  stop,
  recordLoadSnapshot,
  checkAnomaly,
  getBaselineStats: () => db.getBaselineStats(),
};
