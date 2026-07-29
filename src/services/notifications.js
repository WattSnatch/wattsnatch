/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const http = require('http');
const https = require('https');
const url = require('url');
const db = require('../db');

function httpPost(targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: 10000,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(body);
    req.end();
  });
}

async function sendNotification(title, message, priority = 'default', actions = []) {
  if (db.getSetting('notifications_enabled') !== 'true') {
    return { sent: false, reason: 'disabled' };
  }

  const baseUrl = db.getSetting('ntfy_base_url');
  const topic = db.getSetting('ntfy_topic');

  if (!baseUrl || !topic) {
    return { sent: false, reason: 'ntfy not configured' };
  }

  const targetUrl = `${baseUrl}/${topic}`;
  // HTTP headers must be ASCII - strip non-ASCII chars from title
  const safeTitle = title.replace(/[^\x20-\x7E]/g, '').trim();
  const headers = { Title: safeTitle, Priority: priority };

  if (actions.length > 0) {
    headers['Actions'] = actions.map(a => `view, ${a.label}, ${a.url}`).join('; ');
  }

  try {
    const result = await httpPost(targetUrl, message, headers);
    if (result.status >= 200 && result.status < 300) {
      return { sent: true, status: result.status };
    } else {
      return { sent: false, status: result.status, error: result.body };
    }
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

async function notifyTripNeedsGridTopUp(destination, gridKwh, estimatedCost) {
  const app = db.getSetting('app_base_url') || 'http://localhost:3001';
  const title = 'Grid top-up needed';
  const message = `Can't make it to ${destination} and back above 20% on solar alone. Need ${gridKwh.toFixed(1)} kWh from grid (~$${estimatedCost.toFixed(2)}). Approve?`;
  return sendNotification(title, message, 'high', [
    { label: 'Approve', url: `${app}/api/approve-grid-topup` },
    { label: 'Dismiss', url: app },
  ]);
}

async function notifyPanelUnderperformance(panelId, pctBelow) {
  const app = db.getSetting('app_base_url') || 'http://localhost:3001';
  const title = 'Panel underperformance alert';
  const message = `Panel ${panelId} producing ${pctBelow.toFixed(0)}% below neighbours on clear days - possible fault`;
  return sendNotification(title, message, 'default', [
    { label: 'View', url: `${app}/` },
  ]);
}

async function notifyHouseLoadAnomaly(loadW, durationHours) {
  const app = db.getSetting('app_base_url') || 'http://localhost:3001';
  const title = 'House load anomaly detected';
  const message = `House load ${loadW.toFixed(0)}W above baseline for ${durationHours}+ hours - something may be on`;
  return sendNotification(title, message, 'default', [
    { label: 'View', url: `${app}/` },
  ]);
}

async function notifySolarMilestone(kwhGenerated) {
  const title = '☀️ Solar Milestone';
  const message = `Best solar day ever - ${kwhGenerated.toFixed(1)} kWh generated`;
  return sendNotification(title, message, 'low');
}

async function notifyTeslaFullyChargedOnSolar() {
  const title = '🚗 Charged on Sunshine';
  const message = 'Tesla fully charged on solar alone - 0 grid kWh used';
  return sendNotification(title, message, 'low');
}

async function notifyGridFreeStreak(hours) {
  const title = '⚡ Grid-Free Streak';
  const message = `Grid-free for ${hours} hours straight`;
  return sendNotification(title, message, 'low');
}

function getBatteryPct() {
  const telemetry = require('./telemetry');
  const live = telemetry.getState()?.batteryPct;
  if (live) return live;
  // getLastTelemetry can return battery_pct=0 - find the last non-zero reading instead
  const row = db.getDb().prepare(
    'SELECT battery_pct FROM telemetry_log WHERE battery_pct > 0 ORDER BY recorded_at DESC LIMIT 1'
  ).get();
  return row?.battery_pct || null;
}

async function notifyMorningBrief() {
  const tripPlanner = require('./tripPlanner');
  const solcast     = require('./solcast');

  const { assessments } = tripPlanner.getAssessments();
  const todayStart  = new Date(); todayStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000);

  const upcomingTrips = assessments
    .filter(({ trip }) => trip.departureTime >= Date.now() && trip.departureTime < tomorrowEnd.getTime())
    .slice(0, 3);

  const solarToday    = solcast.getRemainingTodayForecast();
  const solarTomorrow = solcast.getTomorrowForecast();
  const batteryPct    = getBatteryPct();
  const lines = [];

  // ── Solar ──────────────────────────────────────────────────────────────────
  lines.push(`Solar: ${solarToday.toFixed(1)} kWh today, ${solarTomorrow.toFixed(1)} kWh tomorrow`);

  // ── Car + charge recommendation ────────────────────────────────────────────
  if (batteryPct != null) {
    const pct = Math.round(batteryPct);
    const needsAttention = upcomingTrips.some(({ assessment }) => assessment.status === 'NEEDS_ATTENTION');
    let note;
    if (needsAttention)            note = 'plug in - trip needs a top-up';
    else if (pct < 30)             note = 'getting low, worth charging today';
    else if (pct < 70 && solarToday >= 20) note = 'good solar day to top up';
    else if (pct < 70 && solarToday >= 15) note = 'decent solar if you want to charge';
    else if (pct >= 80)            note = 'no charge needed';
    lines.push(`Car: ${pct}%${note ? ` - ${note}` : ''}`);
  }

  // ── Trips ──────────────────────────────────────────────────────────────────
  for (const { trip, assessment } of upcomingTrips) {
    const time = new Date(trip.departureTime).toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit',
    });
    const dayLabel = trip.departureTime < todayStart.getTime() + 24 * 60 * 60 * 1000 ? 'Today' : 'Tomorrow';
    const cover = assessment.status === 'SOLAR_WILL_COVER' ? 'solar covered'
                : assessment.status === 'NEEDS_ATTENTION'  ? `needs ${assessment.solarShortfall?.toFixed(1) ?? '?'} kWh from grid`
                : 'battery fine';
    lines.push(`Trip: ${dayLabel} ${time} - ${trip.summary} (${cover})`);
  }

  // ── Laundry ────────────────────────────────────────────────────────────────
  if (solarToday >= 15) {
    lines.push(`Laundry: great day - ${solarToday.toFixed(1)} kWh forecast`);
  } else {
    lines.push(`Laundry: low solar today (${solarToday.toFixed(1)} kWh) - maybe tomorrow`);
  }

  return sendNotification('WattSnatch Morning Brief', lines.join('\n'), 'default');
}

async function notifyEveningSummary() {
  const solcast = require('./solcast');

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const nowMs      = Date.now();

  // Today's actuals from telemetry + charge sessions
  const todayStats = db.getTodayStats();
  const evStats    = db.getPeriodStats(todayStart.getTime(), nowMs);
  const hwStats    = db.getEddiPeriodStats(todayStart.getTime(), nowMs);

  // Enphase accumulator for true solar generation
  const baselineWh = parseFloat(db.getSetting('enphase_energy_baseline_wh') || '0');
  const currentWh  = parseFloat(db.getSetting('enphase_energy_current_wh')  || '0');
  const solarKwh   = baselineWh > 0 ? Math.max(0, (currentWh - baselineWh) / 1000) : (todayStats?.solar_kwh || 0);

  const evSolarKwh  = db.getSolarKwhCharged(todayStart.getTime(), nowMs);
  const evGridKwh   = evStats?.grid_kwh  || 0;
  const evTotalKwh  = evSolarKwh + evGridKwh;
  const hwKwh       = hwStats?.total_kwh || 0;

  const solarTomorrow = solcast.getTomorrowForecast();
  const batteryPct    = getBatteryPct();
  const lines = [];

  // Today's headline
  lines.push(`Today: ${solarKwh.toFixed(1)} kWh solar generated`);
  if (evTotalKwh > 0.1) {
    const solarPct = evTotalKwh > 0 ? Math.round((evSolarKwh / evTotalKwh) * 100) : 0;
    lines.push(`Car charged: ${evTotalKwh.toFixed(1)} kWh (${solarPct}% solar)`);
  } else {
    lines.push('Car: not charged today');
  }
  if (hwKwh > 0.1) lines.push(`Hot water: ${hwKwh.toFixed(1)} kWh diverted`);

  // Tomorrow outlook
  lines.push(`Tomorrow: ${solarTomorrow.toFixed(1)} kWh forecast`);

  // Tonight's car recommendation
  if (batteryPct != null) {
    const pct = Math.round(batteryPct);
    let note;
    if      (pct < 30)                             note = 'low - charge tonight';
    else if (pct < 70 && solarTomorrow >= 20)      note = 'top up tomorrow on solar';
    else if (pct < 70 && solarTomorrow < 10)       note = 'low solar tomorrow - charge tonight';
    else                                            note = 'no charge needed';
    lines.push(`Car: ${pct}% - ${note}`);
  }

  // Laundry tomorrow
  if (solarTomorrow >= 15) {
    lines.push(`Laundry tomorrow: yes - ${solarTomorrow.toFixed(1)} kWh forecast`);
  }

  return sendNotification('WattSnatch Day Summary', lines.join('\n'), 'default');
}

async function notifyMidnightChargeScheduled(chains, fromSoc, toSoc, firstDepartureMs, totalTripKwh) {
  const depTime  = new Date(firstDepartureMs).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  const journeys = chains.map(c =>
    c.length === 1 ? c[0].summary : c.map(t => t.summary).join(' → ')
  ).join(', ');
  const title   = 'Overnight charge scheduled';
  const message = `Tomorrow: ${journeys}. Charging ${fromSoc}% → ${toSoc}% (${totalTripKwh.toFixed(1)} kWh for trips). Ready by ${depTime}.`;
  return sendNotification(title, message, 'default');
}

module.exports = {
  sendNotification,
  notifyTripNeedsGridTopUp,
  notifyMidnightChargeScheduled,
  notifyPanelUnderperformance,
  notifyHouseLoadAnomaly,
  notifySolarMilestone,
  notifyTeslaFullyChargedOnSolar,
  notifyGridFreeStreak,
  notifyMorningBrief,
  notifyEveningSummary,
};
