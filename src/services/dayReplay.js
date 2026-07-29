/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../db');
const SunCalc = require('suncalc');

/**
 * Phase 8 - Day Replay Service
 *
 * Aggregates 5-minute snapshots of energy flow data at sunset each day.
 * Data includes: solar_w, house_w, tesla_w, hotwater_w, ac_w, grid_w
 *
 * Stored as JSON blob in day_replays table for animated playback.
 */

// Get next sunset time for aggregation task
function getNextSunset() {
  try {
    const homeLat = parseFloat(db.getSetting('home_latitude') || '-33.8688');
    const homeLng = parseFloat(db.getSetting('home_longitude') || '151.2093');

    const times = SunCalc.getTimes(new Date(), homeLat, homeLng);
    let sunsetTime = times.sunset;

    // If sunset has passed today, use tomorrow's sunset
    if (sunsetTime < new Date()) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowTimes = SunCalc.getTimes(tomorrow, homeLat, homeLng);
      sunsetTime = tomorrowTimes.sunset;
    }

    return sunsetTime;
  } catch (err) {
    console.error('[dayReplay] getSunset error:', err.message);
    // Fallback: 6pm AEST
    const now = new Date();
    const fallback = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
    if (fallback < now) {
      fallback.setDate(fallback.getDate() + 1);
    }
    return fallback;
  }
}

/**
 * Aggregate telemetry data for a given date into 5-minute snapshots.
 * Returns array of { recorded_at, solar_w, house_w, tesla_w, hotwater_w, ac_w, grid_w }
 */
function aggregateDayData(dateStr) {
  // dateStr format: YYYY-MM-DD
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0).getTime();
  const dayEnd = new Date(y, m - 1, d, 23, 59, 59).getTime();

  // Get all telemetry entries for the day
  const rows = db.getDb().prepare(`
    SELECT
      recorded_at,
      solar_w,
      consumption_w,
      ev_w,
      eddi_w,
      grid_w
    FROM telemetry_log
    WHERE recorded_at >= ? AND recorded_at <= ?
    ORDER BY recorded_at ASC
  `).all(dayStart, dayEnd);

  if (rows.length === 0) return [];

  // Group by 5-minute buckets
  const buckets = {};
  for (const row of rows) {
    // Round down to nearest 5-minute interval
    const interval = Math.floor(row.recorded_at / (5 * 60 * 1000)) * (5 * 60 * 1000);

    if (!buckets[interval]) {
      buckets[interval] = [];
    }
    buckets[interval].push(row);
  }

  // Average each bucket
  const snapshots = [];
  for (const [interval, bucket] of Object.entries(buckets)) {
    const ts = parseInt(interval, 10);
    const avg = bucket.reduce((acc, r) => ({
      solar_w: acc.solar_w + (r.solar_w || 0),
      consumption_w: acc.consumption_w + (r.consumption_w || 0),
      ev_w: acc.ev_w + (r.ev_w || 0),
      eddi_w: acc.eddi_w + (r.eddi_w || 0),
      grid_w: acc.grid_w + (r.grid_w || 0),
    }), { solar_w: 0, consumption_w: 0, ev_w: 0, eddi_w: 0, grid_w: 0 });

    const count = bucket.length;
    snapshots.push({
      recorded_at: ts,
      solar_w: Math.round(avg.solar_w / count),
      house_w: Math.round((avg.consumption_w - avg.ev_w - avg.eddi_w) / count),
      tesla_w: Math.round(avg.ev_w / count),
      hotwater_w: Math.round(avg.eddi_w / count),
      ac_w: 0, // TODO: Add AC telemetry integration (Phase 1 completed, not yet integrated here)
      grid_w: Math.round(avg.grid_w / count),
    });
  }

  return snapshots;
}

/**
 * Generate a day replay for the given date.
 * Called at sunset each day (or manually for historical dates).
 */
function generateDayReplay(dateStr) {
  try {
    const snapshots = aggregateDayData(dateStr);

    if (snapshots.length === 0) {
      console.log(`[dayReplay] No data for ${dateStr}, skipping replay generation`);
      return null;
    }

    const dataJson = JSON.stringify({
      date: dateStr,
      generated_at: Date.now(),
      snapshot_count: snapshots.length,
      snapshots,
    });

    db.insertDayReplay({ date: dateStr, dataJson });
    console.log(`[dayReplay] Generated replay for ${dateStr} (${snapshots.length} snapshots)`);

    return JSON.parse(dataJson);
  } catch (err) {
    console.error(`[dayReplay] Error generating replay for ${dateStr}:`, err.message);
    return null;
  }
}

/**
 * Get yesterday's date as YYYY-MM-DD string.
 */
function getYesterdayDate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

/**
 * Trigger replay generation for yesterday at 6:01 AM (assuming yesterday's data is complete).
 * This is a fire-and-forget background job that runs when the service starts.
 */
let aggregationTimeout = null;

function scheduleAggregation() {
  if (aggregationTimeout) clearTimeout(aggregationTimeout);

  const nextSunset = getNextSunset();
  const now = new Date();
  const msUntilSunset = nextSunset.getTime() - now.getTime();

  // Schedule for 1 minute after sunset to ensure all day's data has arrived
  const scheduleMs = Math.max(0, msUntilSunset + (60 * 1000));

  console.log(`[dayReplay] Next aggregation scheduled for ${nextSunset.toISOString()} (in ${Math.round(scheduleMs / 1000 / 60)} minutes)`);

  aggregationTimeout = setTimeout(() => {
    // Generate today's replay at sunset (end of the solar day)
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local time

    const existing = db.getDayReplayByDate(today);
    if (existing) {
      console.log(`[dayReplay] Replay already exists for ${today}, skipping`);
    } else {
      generateDayReplay(today);
    }

    // Reschedule for next sunset
    scheduleAggregation();
  }, scheduleMs);
}

/**
 * Start the background aggregation task.
 */
function startAggregationTask() {
  console.log('[dayReplay] Starting aggregation task');
  scheduleAggregation();
}

/**
 * Stop the aggregation task.
 */
function stopAggregationTask() {
  if (aggregationTimeout) {
    clearTimeout(aggregationTimeout);
    aggregationTimeout = null;
  }
}

module.exports = {
  getNextSunset,
  aggregateDayData,
  generateDayReplay,
  getYesterdayDate,
  startAggregationTask,
  stopAggregationTask,
};
