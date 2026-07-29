/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../db');
const notifications = require('./notifications');
const baseline = require('./baseline');

const ANOMALY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MILESTONE_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const GRID_FREE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _lastAnomalyCheckAt = 0;
let _lastMilestoneCheckAt = 0;
let _lastGridFreeCheckAt = 0;
let _lastDayRecorded = null;
let _lastGridFreeTime = null;
let _gridFreeStreakStartAt = null;
let _lastSolarGeneration = 0;

function getLastTelemetry() {
  return db.getLastTelemetry();
}

// ── House load anomaly monitoring ──────────────────────────────────────────

async function checkLoadAnomaly() {
  const now = Date.now();
  if (now - _lastAnomalyCheckAt < ANOMALY_CHECK_INTERVAL_MS) return;
  _lastAnomalyCheckAt = now;

  const lastTelem = getLastTelemetry();
  if (!lastTelem) return;

  const readings = {
    solarW: lastTelem.solar_w || 0,
    consumptionW: lastTelem.consumption_w || 0,
    gridW: lastTelem.grid_w || 0,
  };

  try {
    const anomaly = baseline.checkAnomaly(readings);
    if (anomaly.isAnomaly && anomaly.message) {
      const houseW = readings.consumptionW - (lastTelem.eddi_w || 0) - (lastTelem.ev_w || 0);
      // Only notify if sustained for 3+ readings (15 minutes at 5-min poll)
      notifications.notifyHouseLoadAnomaly(Math.max(0, houseW), 1)
        .catch(err => console.warn('[notificationMonitor] anomaly notification failed:', err.message));
    }
  } catch (err) {
    console.warn('[notificationMonitor] anomaly check failed:', err.message);
  }
}

// ── Solar generation milestone tracking ────────────────────────────────────

async function checkSolarMilestone() {
  const now = Date.now();
  if (now - _lastMilestoneCheckAt < MILESTONE_CHECK_INTERVAL_MS) return;
  _lastMilestoneCheckAt = now;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayStartMs = startOfDay.getTime();

  try {
    const todayTelem = db.getDb().prepare(`
      SELECT SUM(solar_w * ?) as total_kwh
      FROM telemetry_log
      WHERE recorded_at >= ?
    `).get(15 / 3600 / 1000, todayStartMs); // 15-sec interval in hours

    const todayKwh = (todayTelem?.total_kwh || 0);

    // Check if today's generation exceeds all previous days
    const allDays = db.getDb().prepare(`
      SELECT CAST((recorded_at - ?) / 86400000 AS INTEGER) AS day_idx,
             SUM(solar_w * ?) as daily_kwh
      FROM telemetry_log
      WHERE recorded_at >= ?
      GROUP BY day_idx
      ORDER BY daily_kwh DESC
      LIMIT 1
    `).get(todayStartMs, 15 / 3600 / 1000, todayStartMs - 90 * 24 * 60 * 60 * 1000);

    const bestPrevKwh = (allDays?.daily_kwh || 0);

    if (todayKwh > 10 && todayKwh > bestPrevKwh * 1.05) {
      // 5% margin to avoid repeated notifications for same achievement
      if (_lastSolarGeneration < todayKwh) {
        _lastSolarGeneration = todayKwh;
        notifications.notifySolarMilestone(todayKwh / 1000)
          .catch(err => console.warn('[notificationMonitor] milestone notification failed:', err.message));
      }
    }
  } catch (err) {
    console.warn('[notificationMonitor] milestone check failed:', err.message);
  }
}

// ── Grid-free streak tracking ──────────────────────────────────────────────

async function checkGridFreeStreak() {
  const now = Date.now();
  if (now - _lastGridFreeCheckAt < GRID_FREE_CHECK_INTERVAL_MS) return;
  _lastGridFreeCheckAt = now;

  try {
    const lastTelem = getLastTelemetry();
    if (!lastTelem) return;

    const importingFromGrid = lastTelem.grid_w > 50; // threshold: importing >50W

    if (!importingFromGrid) {
      if (!_gridFreeStreakStartAt) {
        _gridFreeStreakStartAt = now;
      }
      _lastGridFreeTime = now;
    } else {
      // Grid import detected - reset streak
      if (_gridFreeStreakStartAt) {
        const streakHours = Math.round((now - _gridFreeStreakStartAt) / (60 * 60 * 1000));
        if (streakHours >= 24) {
          notifications.notifyGridFreeStreak(streakHours)
            .catch(err => console.warn('[notificationMonitor] grid-free notification failed:', err.message));
        }
      }
      _gridFreeStreakStartAt = null;
    }
  } catch (err) {
    console.warn('[notificationMonitor] grid-free check failed:', err.message);
  }
}

// ── Session completion - Tesla fully charged on solar ─────────────────────

async function notifySessionCompleted(session) {
  try {
    // If session was completed and had 0 grid kwh, send celebration notification
    if (session.ended_at && session.kwh_from_grid === null || session.kwh_from_grid === 0) {
      if (session.kwh_solar > 0) {
        notifications.notifyTeslaFullyChargedOnSolar()
          .catch(err => console.warn('[notificationMonitor] session notification failed:', err.message));
      }
    }
  } catch (err) {
    console.warn('[notificationMonitor] session notification failed:', err.message);
  }
}

// ── Main check function (call periodically from controller) ────────────────

async function checkAll() {
  try {
    await checkLoadAnomaly();
    await checkSolarMilestone();
    await checkGridFreeStreak();
  } catch (err) {
    console.warn('[notificationMonitor] checkAll failed:', err.message);
  }
}

module.exports = {
  checkAll,
  notifySessionCompleted,
};
