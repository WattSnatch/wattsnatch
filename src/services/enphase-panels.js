/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const https = require('https');
const { execFile } = require('child_process');
const db = require('../db');
const { decrypt } = require('../utils/crypto');
const notifications = require('./notifications');

// Self-signed cert is expected on Enphase IQ Gateway
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const DAYLIGHT_START_HOUR = 6;    // 6am local time
const DAYLIGHT_END_HOUR = 20;     // 8pm local time
const CLEAR_THRESHOLD_W = 50;     // median must exceed this to count as a clear-condition sample
const UNDERPERFORM_RATIO = 0.80;  // panel < 80% of median = underperforming
const MIN_CLEAR_SAMPLES = 5;      // need at least this many clear samples to flag
const BAD_SAMPLE_RATIO = 0.50;    // flag if underperforming in >50% of clear samples
const NOTIFY_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000; // once per week per panel
const POLL_INTERVAL_MS = 5 * 60 * 1000;              // every 5 minutes (inverters report on ~5 min PLC cycle)

let _pollTimer = null;
let _nightlyTimer = null;
let _started = false;
let _lastPollAt = 0;
let _lastAnalysisDate = null; // 'YYYY-MM-DD' of last nightly run

// ── Credentials ───────────────────────────────────────────────────────────────

function getCredentials() {
  const gatewayIp = db.getSetting('gateway_ip');
  if (!gatewayIp) return null;

  const row = db.getToken('enphase');
  if (!row) return null;

  try {
    const jwt = JSON.parse(decrypt(row.token_data)).jwt;
    if (!jwt) return null;
    return { gatewayIp, jwt };
  } catch (_) {
    return null;
  }
}

// ── Fetch from local gateway ──────────────────────────────────────────────────

function fetchInverters(gatewayIp, jwt) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: gatewayIp,
      path: '/api/v1/production/inverters',
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
      agent: insecureAgent,
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          const err = new Error('Enphase JWT expired or invalid');
          err.code = 'ENPHASE_JWT_EXPIRED';
          return reject(err);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Inverters endpoint returned HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error('Non-JSON response from inverters endpoint'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Inverter request timed out')); });
    req.end();
  });
}

// ── Polling ───────────────────────────────────────────────────────────────────

function isDaylightHour() {
  const h = new Date().getHours();
  return h >= DAYLIGHT_START_HOUR && h < DAYLIGHT_END_HOUR;
}

async function pollAndStore() {
  if (!isDaylightHour()) return;

  const creds = getCredentials();
  if (!creds) return;

  let inverters;
  try {
    inverters = await fetchInverters(creds.gatewayIp, creds.jwt);
  } catch (err) {
    if (err.code !== 'ENPHASE_JWT_EXPIRED') {
      console.warn('[enphase-panels] Poll failed:', err.message);
    }
    return;
  }

  if (!Array.isArray(inverters) || inverters.length === 0) return;

  const now = Date.now();
  _lastPollAt = now;

  // Median watts across all panels serves as irradiance proxy
  const watts = inverters.map(inv => Math.max(0, inv.lastReportWatts || 0));
  const sorted = [...watts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  const rows = inverters.map(inv => ({
    recorded_at:      now,
    panel_id:         inv.serialNumber || String(inv.devType || 'unknown'),
    wh_produced:      Math.max(0, inv.lastReportWatts || 0),
    irradiance_approx: median,
  }));

  db.insertPanelProductionBatch(rows);
  console.log(`[enphase-panels] Polled ${inverters.length} panels, median ${Math.round(median)}W`);
}

// ── Health analysis ───────────────────────────────────────────────────────────

function computeHealthStatus() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = db.getPanelProductionWindow(sevenDaysAgo, Date.now());

  if (rows.length === 0) return { panels: [], last_poll_at: _lastPollAt };

  // Group rows by panel, track clear-condition performance
  const panelMap = new Map();
  for (const row of rows) {
    if (!panelMap.has(row.panel_id)) {
      panelMap.set(row.panel_id, { clearSamples: 0, badSamples: 0, totalPctBelow: 0 });
    }
    const p = panelMap.get(row.panel_id);
    if ((row.irradiance_approx || 0) < CLEAR_THRESHOLD_W) continue; // nighttime / overcast, skip

    p.clearSamples++;
    const ratio = row.irradiance_approx > 0 ? row.wh_produced / row.irradiance_approx : 1;
    if (ratio < UNDERPERFORM_RATIO) {
      p.badSamples++;
      p.totalPctBelow += (1 - ratio) * 100;
    }
  }

  // Build per-day averages for the 7-day trend
  const dayAvgMap = new Map(); // key: `${panel_id}:YYYY-MM-DD`
  for (const row of rows) {
    const dayKey = new Date(row.recorded_at).toLocaleDateString('en-CA');
    const key = row.panel_id + ':' + dayKey;
    if (!dayAvgMap.has(key)) dayAvgMap.set(key, { sum: 0, count: 0, date: dayKey, panel_id: row.panel_id });
    const e = dayAvgMap.get(key);
    e.sum += row.wh_produced || 0;
    e.count++;
  }

  const panels = [];
  let idx = 1;

  for (const [panelId, data] of panelMap) {
    const badRatio = data.clearSamples > 0 ? data.badSamples / data.clearSamples : 0;
    const avgPctBelow = data.badSamples > 0 ? data.totalPctBelow / data.badSamples : 0;

    let health = 'green';
    if (data.clearSamples >= MIN_CLEAR_SAMPLES) {
      if (badRatio > BAD_SAMPLE_RATIO && avgPctBelow > 20) health = 'red';
      else if (badRatio > 0.3 && avgPctBelow > 10) health = 'amber';
    }

    // Build 7-day trend array (newest last)
    const trend = [];
    for (let d = 6; d >= 0; d--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - d);
      const dayKey = dt.toLocaleDateString('en-CA');
      const e = dayAvgMap.get(panelId + ':' + dayKey);
      trend.push({ date: dayKey, avg_watts: e ? Math.round(e.sum / e.count) : null });
    }

    panels.push({
      panel_id:       panelId,
      serial_short:   panelId.length >= 6 ? panelId.slice(-6) : panelId,
      label:          `Panel ${idx++}`,
      health,
      pct_below_median: Math.round(avgPctBelow * 10) / 10,
      clear_samples:  data.clearSamples,
      bad_samples:    data.badSamples,
      bad_ratio:      Math.round(badRatio * 100),
      trend,
    });
  }

  // Stable ordering by panel_id so label numbers don't shuffle between calls
  panels.sort((a, b) => a.panel_id.localeCompare(b.panel_id));
  panels.forEach((p, i) => { p.label = `Panel ${i + 1}`; });

  return { panels, last_poll_at: _lastPollAt };
}

// Public wrapper - called by API route
function getHealthStatus() {
  return computeHealthStatus();
}

// ── Nightly analysis + notifications ─────────────────────────────────────────

function sendNotification(label, pctBelow, clearDayEstimate) {
  return new Promise((resolve) => {
    const days = Math.max(1, clearDayEstimate);
    const msg = `${label} has produced ${pctBelow}% less than adjacent panels over the last ${days} clear day${days !== 1 ? 's' : ''} - possible soiling, shading or fault. Worth checking.`;
    const script = `display notification "${msg.replace(/"/g, '\\"')}" with title "WattSnatch - Panel Health"`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) console.warn('[enphase-panels] macOS notification failed:', err.message);
      resolve();
    });
  });
}

async function analyzeAndAlert() {
  const h = new Date().getHours();
  if (h < 22) return; // only run after 10pm

  const today = new Date().toLocaleDateString('en-CA');
  if (_lastAnalysisDate === today) return; // already ran tonight
  _lastAnalysisDate = today;

  const { panels } = computeHealthStatus();
  const now = Date.now();

  for (const panel of panels) {
    if (panel.health !== 'red') continue;
    if (panel.clear_samples < MIN_CLEAR_SAMPLES) continue;

    // Throttle: max once per week per panel
    const alert = db.getPanelHealthAlert(panel.panel_id);
    if (alert && (now - alert.last_notified_at) < NOTIFY_THROTTLE_MS) continue;

    // Estimate clear days as samples / ~8 hourly readings per clear day
    const clearDayEstimate = Math.round(panel.clear_samples / 8);

    // Send push notification via ntfy
    notifications.notifyPanelUnderperformance(panel.label, Math.round(panel.pct_below_median))
      .catch(err => console.warn('[enphase-panels] ntfy notification failed:', err.message));

    // Also send macOS notification for local visibility
    await sendNotification(panel.label, Math.round(panel.pct_below_median), clearDayEstimate);

    db.upsertPanelHealthAlert(panel.panel_id, now, panel.pct_below_median);
    console.log(`[enphase-panels] Alerted on ${panel.label} (${panel.panel_id}): ${panel.pct_below_median}% below median`);
  }
}

// ── Service lifecycle ─────────────────────────────────────────────────────────

function start() {
  if (_started) return;
  _started = true;

  // Immediate poll on startup (no-op if nighttime)
  pollAndStore().catch(() => {});

  // Hourly polling
  _pollTimer = setInterval(() => pollAndStore().catch(() => {}), POLL_INTERVAL_MS);

  // Check every 5 minutes whether it's time for nightly analysis (runs at 22:00)
  _nightlyTimer = setInterval(() => analyzeAndAlert().catch(() => {}), 5 * 60 * 1000);
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_nightlyTimer) { clearInterval(_nightlyTimer); _nightlyTimer = null; }
  _started = false;
}

module.exports = { start, stop, getHealthStatus, pollAndStore, analyzeAndAlert };
