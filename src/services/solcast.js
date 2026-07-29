/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const https = require('https');
const db = require('../db');

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout: 15000,
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    }).on('error', reject).on('timeout', (err) => {
      reject(new Error('Request timed out'));
    }).end();
  });
}

/**
 * Fetch 48-hour forecast from Solcast.
 * Returns array of 30-min interval readings: [{ period_start, period_end, pv_estimate }]
 */
async function fetchForecast() {
  const apiKey = db.getSetting('solcast_api_key');
  const resourceId = db.getSetting('solcast_resource_id');

  if (!apiKey || !resourceId) {
    throw new Error('Solcast API key or resource ID not configured');
  }

  const url = `https://api.solcast.com.au/rooftop_sites/${resourceId}/forecasts?format=json&hours=168`; // 7 days
  const headers = { 'Authorization': `Bearer ${apiKey}` };

  try {
    const res = await httpsGet(url, headers);
    if (res.status !== 200) {
      throw new Error(`Solcast API returned status ${res.status}`);
    }

    const data = JSON.parse(res.body);
    if (!data.forecasts || !Array.isArray(data.forecasts)) {
      throw new Error('Invalid Solcast response format');
    }

    const fetchedAt = Date.now();

    // Replace all previous forecast data - only the latest fetch is valid.
    // Keeping multiple batches caused 4× inflation of kWh estimates.
    db.getDb().prepare('DELETE FROM solcast_forecasts').run();

    // Insert new forecasts
    const insertStmt = db.getDb().prepare(`
      INSERT INTO solcast_forecasts (fetched_at, period_start, period_end, pv_estimate_kw)
      VALUES (?, ?, ?, ?)
    `);

    for (const forecast of data.forecasts) {
      const periodStart = new Date(forecast.period_end).getTime() - 30 * 60 * 1000; // 30-min interval
      const periodEnd = new Date(forecast.period_end).getTime();
      const pvEstimate = parseFloat(forecast.pv_estimate) || 0;

      insertStmt.run(fetchedAt, periodStart, periodEnd, pvEstimate);
    }

    // Track that we made a fetch today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fetchCountKey = `solcast_fetch_count_${today.getTime()}`;
    let fetchCount = parseInt(db.getSetting(fetchCountKey) || '0', 10);
    db.setSetting(fetchCountKey, String(++fetchCount));

    console.log(`[solcast] Fetched ${data.forecasts.length} forecast intervals, fetch count: ${fetchCount}/4`);

    return data.forecasts;
  } catch (err) {
    console.error('[solcast] Fetch failed:', err.message);
    throw err;
  }
}

/**
 * Get total expected kWh in a time window from latest forecast.
 * Uses 30-min interval data, sums pv_estimate for intervals within [startTime, endTime].
 */
function getExpectedKwhInWindow(startMs, endMs) {
  const rows = db.getSolcastForecastInWindow(startMs, endMs);
  const totalKw = rows.reduce((sum, r) => sum + (r.pv_estimate_kw || 0), 0);
  const intervalHours = (endMs - startMs) / (30 * 60 * 1000);
  const expectedKwh = Math.round(totalKw * (intervalHours / 48) * 100) / 100; // Rough hourly average
  return expectedKwh;
}

/**
 * Get tomorrow's total expected generation in kWh.
 * Tomorrow = from 00:00 to 23:59 local time tomorrow.
 */
function getTomorrowForecast() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const tomorrowStart = tomorrow.getTime();
  const tomorrowEnd = tomorrowStart + 24 * 60 * 60 * 1000;

  const rows = db.getSolcastForecastInWindow(tomorrowStart, tomorrowEnd);
  const totalKwh = rows.reduce((sum, r) => sum + (r.pv_estimate_kw || 0) * (30 / 60), 0);
  return Math.round(totalKwh * 100) / 100;
}

/**
 * Get today's remaining expected generation from now until 23:59.
 */
function getRemainingTodayForecast() {
  const now = Date.now();
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const todayEnd = today.getTime();

  const rows = db.getSolcastForecastInWindow(now, todayEnd);
  const totalKwh = rows.reduce((sum, r) => sum + (r.pv_estimate_kw || 0) * (30 / 60), 0);
  return Math.round(totalKwh * 100) / 100;
}

/**
 * Get today's completed generation from 00:00 to now (from telemetry_log).
 */
function getTodayCompletedGeneration() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const now = Date.now();

  const row = db.getDb().prepare(`
    SELECT COALESCE(SUM(solar_w), 0) as total_solar_w FROM telemetry_log
    WHERE recorded_at >= ? AND recorded_at < ?
  `).get(todayStart, now);

  const pollingSecs = parseFloat(db.getSetting('polling_interval_seconds') || '15');
  const intervalHours = pollingSecs / 3600;
  const completedKwh = Math.round((row.total_solar_w || 0) * intervalHours / 1000 * 100) / 100;
  return completedKwh;
}

/**
 * Calculate intraday forecast accuracy ratio.
 * accuracy_ratio = actual_completed / forecast_for_same_period
 * Returns { ratio, forecast_completed, actual_completed }
 */
function calculateForecastAccuracy() {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  // Actual completed
  const actual = getTodayCompletedGeneration();

  // Forecast for same period (00:00 to now)
  const rows = db.getSolcastForecastInWindow(todayStart, now);
  const forecastKwh = rows.reduce((sum, r) => sum + (r.pv_estimate_kw || 0) * (30 / 60), 0);

  const ratio = forecastKwh > 0 ? actual / forecastKwh : 1.0;

  return {
    ratio: Math.round(ratio * 1000) / 1000,
    forecast_completed: Math.round(forecastKwh * 100) / 100,
    actual_completed: actual,
  };
}

/**
 * Track intraday forecast and apply accuracy ratio to remaining forecast.
 * Returns adjusted forecast for rest of day.
 */
function trackAndAdjustForecast() {
  const { ratio, forecast_completed, actual_completed } = calculateForecastAccuracy();
  const forecastRemaining = getRemainingTodayForecast();
  const adjustedRemaining = Math.round(forecastRemaining * ratio * 100) / 100;

  // Log the tracking
  db.insertIntradayTracking({
    tracked_at: Date.now(),
    forecast_accuracy_ratio: ratio,
    forecast_remaining_kwh: forecastRemaining,
    adjusted_remaining_kwh: adjustedRemaining,
  });

  return {
    forecast_accuracy_ratio: ratio,
    forecast_remaining_kwh: forecastRemaining,
    adjusted_remaining_kwh: adjustedRemaining,
    message: ratio > 1.15
      ? `✨ Generating better than expected! On track for ${Math.round((actual_completed + adjustedRemaining) * 10) / 10} kWh total today.`
      : ratio < 0.85
      ? `⛅ Generating less than expected. Adjusted forecast: ${adjustedRemaining} kWh remaining.`
      : `Forecast tracking: ${adjustedRemaining} kWh remaining today.`,
  };
}

/**
 * Check if we can fetch. Max 4 calls per day.
 * Returns true if fetch is allowed, false otherwise.
 */
function canFetch() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fetchCountKey = `solcast_fetch_count_${today.getTime()}`;
  const fetchCount = parseInt(db.getSetting(fetchCountKey) || '0', 10);
  return fetchCount < 10; // Solcast free tier: 10 calls/day max
}

/**
 * Get all 48-hour forecast intervals.
 */
function getAllForecasts() {
  const rows = db.getSolcastForecastBatch();
  return rows.map(r => ({
    period_start: r.period_start,
    period_end: r.period_end,
    pv_estimate_kw: r.pv_estimate_kw,
  }));
}

module.exports = {
  fetchForecast,
  getExpectedKwhInWindow,
  getTomorrowForecast,
  getRemainingTodayForecast,
  getTodayCompletedGeneration,
  calculateForecastAccuracy,
  trackAndAdjustForecast,
  canFetch,
  getAllForecasts,
};
