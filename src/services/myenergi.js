/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const logger = require('../utils/logger');

// ── Status code labels ────────────────────────────────────────────────────────
const STATUS_LABELS = {
  1: 'Solar Mode',       // eco mode, waiting for solar surplus
  2: 'Solar Mode',       // waiting for export
  3: 'Diverting',        // actively diverting solar to heat water
  4: 'Boosting',         // timed boost in progress
  5: 'Max Temp Reached', // boost ran to maximum temperature
  6: 'Boosting',         // hot water boost (same treatment as timed boost)
  7: 'Stopped',          // fully off
};

// ── Module-level state ────────────────────────────────────────────────────────
let _state = {
  divertW:          0,
  status:           'Unknown',
  ok:               false,
  energyTodayKwh:   0,
  boostTodayKwh:    0,
  temp1:            null,
  temp2:            null,
  lastUpdated:      null,
};

let _interval        = null;
let _cachedServer    = null;   // e.g. 's18.myenergi.net'

// ── Boost energy accumulator ──────────────────────────────────────────────────
// The myenergi live API's `che` field is solar-divert energy only - no separate
// field for grid-boost energy in the status endpoint. We accumulate boost kWh
// in memory by tracking elapsed time while sta indicates Boosting (codes 4/6).
// Persists across server restarts by reading today's last recorded DB value.

let _boostTodayKwh  = 0;
let _boostAccumDate = null;   // YYYY-MM-DD; resets at midnight
let _lastPollMs     = null;

function _initBoostAccum() {
  const todayStr = new Date().toLocaleDateString('en-CA');
  _boostAccumDate = todayStr;
  try {
    const row = db.getDb().prepare(
      `SELECT MAX(boost_today_kwh) AS kwh FROM eddi_telemetry
       WHERE date(recorded_at / 1000, 'unixepoch', 'localtime') = ?`
    ).get(todayStr);
    _boostTodayKwh = row?.kwh || 0;
  } catch (_) {
    _boostTodayKwh = 0;
  }
}

// ── HTTP Digest Auth ──────────────────────────────────────────────────────────

/**
 * Parses the WWW-Authenticate header into a plain object.
 * e.g. Digest realm="...", nonce="...", qop="auth"
 */
function parseWwwAuthenticate(header) {
  const result = {};
  const re = /(\w+)="([^"]+)"/g;
  let m;
  while ((m = re.exec(header)) !== null) {
    result[m[1]] = m[2];
  }
  return result;
}

/**
 * Sends a GET request using HTTP Digest Authentication.
 * Performs a 401-probe first to extract nonce/realm/qop, then resends with
 * the computed Authorization header.
 *
 * @param {string} url
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ body: any, server: string|null }>}
 */
async function digestGet(url, username, password) {
  // ── Phase 1: unauthenticated probe ──────────────────────────────────────
  let probeRes;
  try {
    probeRes = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new Error(`myenergi probe request failed: ${err.message}`);
  }

  if (probeRes.status !== 401) {
    // Some responses come back 200 directly (shouldn't happen but handle it)
    if (probeRes.ok) {
      const body = await probeRes.json();
      return { body, server: null };
    }
    throw new Error(`myenergi unexpected status ${probeRes.status} on probe`);
  }

  // Capture the server hint from the 401 response
  const serverHeader = probeRes.headers.get('x-myenergi-server') || null;
  if (serverHeader) _cachedServer = serverHeader;

  const wwwAuth = probeRes.headers.get('www-authenticate') || '';
  const params  = parseWwwAuthenticate(wwwAuth);

  const { realm, nonce, qop } = params;
  if (!realm || !nonce) {
    throw new Error('myenergi WWW-Authenticate missing realm or nonce');
  }

  // ── Phase 2: compute Digest response ────────────────────────────────────
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

  const ha1    = md5(`${username}:${realm}:${password}`);
  const ha2    = md5(`GET:${new URL(url).pathname}`);
  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  let response;
  if (qop === 'auth') {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  } else {
    // qop absent or 'auth-int' - fall back to simple digest
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  const authHeader = [
    `Digest username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${new URL(url).pathname}"`,
    qop ? `qop=auth` : '',
    qop ? `nc=${nc}` : '',
    qop ? `cnonce="${cnonce}"` : '',
    `response="${response}"`,
  ].filter(Boolean).join(', ');

  // ── Phase 3: authenticated request ──────────────────────────────────────
  let authRes;
  try {
    authRes = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
  } catch (err) {
    throw new Error(`myenergi authenticated request failed: ${err.message}`);
  }

  if (!authRes.ok) {
    throw new Error(`myenergi API returned ${authRes.status}`);
  }

  const body = await authRes.json();
  return { body, server: serverHeader };
}

// ── Parse the Eddi array returned by the API ─────────────────────────────────

/**
 * myenergi API returns either:
 *   [{"eddi":[...]}, {"asn":"s18..."}]
 *   or
 *   {"eddi":[...], "asn":"..."}
 *
 * This function normalises both forms and returns the first eddi device object.
 */
function extractEddi(raw) {
  let eddiArray = null;
  let asn       = null;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item.eddi)  eddiArray = item.eddi;
      if (item.asn)   asn       = item.asn;
    }
  } else if (raw && typeof raw === 'object') {
    eddiArray = raw.eddi || null;
    asn       = raw.asn  || null;
  }

  if (asn) _cachedServer = asn;

  if (!eddiArray || !eddiArray.length) return null;
  return eddiArray[0];
}

// ── Daily history fetch ───────────────────────────────────────────────────────
// /cgi-jday-E{serial}-{Y}-{M}-{D} returns per-minute records.
// Energy values (h1d, h1b, h2d, h2b, imp, exp) are in Watt-seconds (Joules).
// Divide by 3,600,000 to convert to kWh.

async function fetchEddiDayHistory(year, month, day) {
  const serial = db.getSetting('myenergi_serial') || '';
  const apiKey = db.getSetting('myenergi_api_key') || '';
  if (!serial || !apiKey) throw new Error('myenergi serial/API key not configured');

  const host = _cachedServer || 'director.myenergi.net';
  const url  = `https://${host}/cgi-jday-E${serial}-${year}-${month}-${day}`;

  const { body } = await digestGet(url, serial, apiKey);

  // Response: { "U{serial}": [...minute records...], "asn": "..." }
  let rows = [];
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) { rows = v; break; }
    if (k === 'asn' && typeof v === 'string') _cachedServer = v;
  }

  let boostJ = 0;
  let solarJ = 0;
  for (const r of rows) {
    boostJ += (r.h1b || 0) + (r.h2b || 0);
    solarJ += (r.h1d || 0) + (r.h2d || 0);
  }

  return {
    boostKwh: Math.round((boostJ / 3_600_000) * 1000) / 1000,
    solarKwh: Math.round((solarJ / 3_600_000) * 1000) / 1000,
  };
}

// ── Backfill boost history ────────────────────────────────────────────────────
// For each of the past `daysBack` days, fetches the myenergi daily history
// and writes the correct boost_today_kwh into eddi_telemetry.
// Strategy: find the last telemetry row for the day and UPDATE it with the
// true boost total; getEddiPeriodStats uses MAX(boost_today_kwh) per day so
// updating the final record is sufficient.

async function backfillBoostHistory(daysBack = 30) {
  const results = [];
  const now     = new Date();

  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const year  = d.getFullYear();
    const month = d.getMonth() + 1;
    const day   = d.getDate();

    const localDate = d.toLocaleDateString('en-CA'); // YYYY-MM-DD

    // Check if this day already has non-zero boost data (skip if already backfilled)
    const existing = db.getDb().prepare(
      `SELECT MAX(boost_today_kwh) AS kwh FROM eddi_telemetry
       WHERE date(recorded_at / 1000, 'unixepoch', 'localtime') = ?`
    ).get(localDate);

    if ((existing?.kwh || 0) > 0) {
      results.push({ date: localDate, skipped: true, boostKwh: existing.kwh });
      continue;
    }

    // Check if there's any Eddi data for this day (only backfill if Eddi was logging)
    const hasData = db.getDb().prepare(
      `SELECT COUNT(*) AS cnt FROM eddi_telemetry
       WHERE date(recorded_at / 1000, 'unixepoch', 'localtime') = ?`
    ).get(localDate);

    if (!hasData?.cnt) {
      results.push({ date: localDate, skipped: true, reason: 'no telemetry' });
      continue;
    }

    try {
      const hist = await fetchEddiDayHistory(year, month, day);

      if (hist.boostKwh > 0) {
        // Update the last telemetry row for this day with the boost total
        db.getDb().prepare(
          `UPDATE eddi_telemetry SET boost_today_kwh = ?
           WHERE recorded_at = (
             SELECT MAX(recorded_at) FROM eddi_telemetry
             WHERE date(recorded_at / 1000, 'unixepoch', 'localtime') = ?
           )`
        ).run(hist.boostKwh, localDate);
      }

      results.push({ date: localDate, boostKwh: hist.boostKwh, solarKwh: hist.solarKwh });
    } catch (err) {
      results.push({ date: localDate, error: err.message });
    }

    // Brief pause to avoid hammering the myenergi API
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

// ── Main fetch ────────────────────────────────────────────────────────────────

async function fetchEddi() {
  const serial  = db.getSetting('myenergi_serial') || '';
  const apiKey  = db.getSetting('myenergi_api_key') || '';

  if (!serial || !apiKey) throw new Error('myenergi serial/API key not configured');

  // Use cached server hostname if available, otherwise director
  const host = _cachedServer || 'director.myenergi.net';
  const url  = `https://${host}/cgi-jstatus-E${serial}`;

  const { body } = await digestGet(url, serial, apiKey);

  const eddi = extractEddi(body);
  if (!eddi) throw new Error('No Eddi device found in API response');

  const staCode = eddi.sta;
  const status  = STATUS_LABELS[staCode] || 'Unknown';
  const divertW = eddi.div  || 0;
  const che     = eddi.che  || 0;                         // energy today kWh
  // 127 (0x7F) is myenergi's sentinel for "probe not connected" - treat as null
  const temp1   = (eddi.tp1 > 0 && eddi.tp1 !== 127) ? eddi.tp1 : null;
  const temp2   = (eddi.tp2 > 0 && eddi.tp2 !== 127) ? eddi.tp2 : null;

  return { status, divertW, energyTodayKwh: che, temp1, temp2 };
}

// ── Command helper (myenergi uses GET for writes too) ─────────────────────────

/**
 * Send a command to the Eddi hub. The myenergi API uses GET requests for
 * both reads and writes; the response JSON confirms the command was accepted.
 */
async function sendCommand(path) {
  const serial = db.getSetting('myenergi_serial') || '';
  const apiKey = db.getSetting('myenergi_api_key') || '';
  if (!apiKey) throw new Error('myenergi API key not configured');

  const host = _cachedServer || 'director.myenergi.net';
  const url  = `https://${host}${path}`;
  const { body } = await digestGet(url, serial, apiKey);
  return body;
}

/**
 * Set the Eddi's operating mode.
 * Mode 1 = Eco (solar divert, the normal auto mode)
 * Mode 0 = Stopped (fully off - no divert, no boost)
 * ref: /cgi-eddi-mode-E{serial}-{mode}
 */
async function setMode(mode) {
  const serial = db.getSetting('myenergi_serial') || '';
  return sendCommand(`/cgi-eddi-mode-E${serial}-${mode}`);
}

/**
 * Start a manual hot-water boost.
 * @param {number} heater - 1 or 2 (heater relay number, default 1)
 * @param {number} minutes - how long to boost (e.g. 60)
 * ref: /cgi-eddi-boost-E{serial}-{heater}-{minutes}  (0 minutes = stop boost)
 */
async function boost(heater = 1, minutes = 60) {
  const serial = db.getSetting('myenergi_serial') || '';
  return sendCommand(`/cgi-eddi-boost-E${serial}-${heater}-${minutes}`);
}

/**
 * Stop any active manual boost and return to solar-divert mode.
 */
async function stopBoost(heater = 1) {
  const serial = db.getSetting('myenergi_serial') || '';
  // Setting boost minutes to 0 cancels the boost
  return sendCommand(`/cgi-eddi-boost-E${serial}-${heater}-0`);
}

// ── Public API ────────────────────────────────────────────────────────────────

function getState() {
  return { ..._state };
}

function isConfigured() {
  const serial = db.getSetting('myenergi_serial');
  const key    = db.getSetting('myenergi_api_key');
  return !!(serial && key);
}

async function poll() {
  try {
    const nowMs    = Date.now();
    const todayStr = new Date().toLocaleDateString('en-CA');

    // Reset accumulator at midnight (day rollover)
    if (_boostAccumDate !== todayStr) {
      _boostTodayKwh  = 0;
      _boostAccumDate = todayStr;
      _lastPollMs     = null;
    }

    const data = await fetchEddi();

    // Accumulate boost kWh when Eddi is in boost mode (sta 4 or 6 → 'Boosting')
    if (data.status === 'Boosting' && _lastPollMs != null) {
      const elapsedHrs = (nowMs - _lastPollMs) / 3_600_000;
      _boostTodayKwh += (data.divertW / 1000) * elapsedHrs;
    }
    _lastPollMs = nowMs;

    const boostKwh = Math.round(_boostTodayKwh * 1000) / 1000;

    _state = {
      divertW:          data.divertW,
      status:           data.status,
      ok:               true,
      energyTodayKwh:   data.energyTodayKwh,
      boostTodayKwh:    boostKwh,
      temp1:            data.temp1,
      temp2:            data.temp2,
      lastUpdated:      nowMs,
    };

    db.insertEddiTelemetry({
      recorded_at:      nowMs,
      diverted_w:       data.divertW,
      status:           data.status,
      energy_today_kwh: data.energyTodayKwh,
      boost_today_kwh:  boostKwh,
      temp1:            data.temp1,
      temp2:            data.temp2,
    });
  } catch (err) {
    _state = { ..._state, ok: false, lastUpdated: Date.now() };
    logger.logEvent('api_error', `myenergi poll failed: ${err.message}`);
  }
}

function start() {
  if (!isConfigured()) {
    logger.logEvent('info', 'myenergi: not configured - skipping start');
    return;
  }

  // Restore today's boost accumulator from DB so a server restart doesn't lose progress
  _initBoostAccum();

  const pollSecs = parseInt(db.getSetting('myenergi_poll_seconds') || '30', 10);
  const pollMs   = Math.max(10, pollSecs) * 1000;

  logger.logEvent('info', `myenergi: starting poll every ${pollSecs}s`);

  // Poll immediately, then on interval
  poll().catch(() => {});
  _interval = setInterval(() => poll().catch(() => {}), pollMs);
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

function restart() {
  stop();
  _cachedServer = null;
  start();
}

module.exports = { start, stop, restart, poll, getState, isConfigured, setMode, boost, stopBoost, fetchEddiDayHistory, backfillBoostHistory };
