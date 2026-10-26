'use strict';

// SolarEdge Monitoring API V2 adapter (OAuth 2.0, "SolarEdge ONE" platform).
//
// Why this exists alongside solaredge.js: the V1 API that solaredge.js speaks
// (monitoringapi.solaredge.com/site/{id}/currentPowerFlow.json?api_key=) is
// deprecated on November 3, 2026, and SolarEdge removed self-service API-key
// generation in 2025 - a site owner without installer-granted admin rights
// cannot obtain a V1 key at all any more. V2 replaces the key with an OAuth
// grant the homeowner issues against their own site, which needs no installer.
//
// ── The constraint that shapes this whole file ────────────────────────────────
//
// The Basic Monitoring API's finest resolution is QUARTER_HOUR, and each value
// is the AVERAGE of the raw samples in that 15-minute window, timestamped at the
// window's START. Live instantaneous power (/sites/{id}/power-flow) is Advanced
// Monitoring - Business Pro or Enterprise only.
//
// Two consequences drive the design:
//
//   1. Polling faster than every 15 minutes buys nothing - the same window comes
//      back until the next one closes. So we poll ONCE per quarter-hour window,
//      shortly after it closes, and serve a cache in between. That is also what
//      keeps us inside the Free tier's 2,000 credits/month (1 credit per call):
//      daylight-only, one call per window is ~1,440/month.
//
//   2. The number is an average, not a present value. Matching the charge rate to
//      a 15-minute mean overshoots for every part of the window that sat below it,
//      and the difference comes from the grid. Nothing here can fix that - it is a
//      property of the data - so the provider reports honestly and leaves the
//      margin to the caller.
//
// ── Why this never fabricates a reading ───────────────────────────────────────
//
// controller.js computes  rawExcess = solarW - consumptionW + chargerWatts,
// where chargerWatts is added back because the car's own draw is inside
// consumptionW. Returning synthetic zeroes when we have no data would make that
// arithmetic read  0 - 0 + 3680 = 3680W of "surplus"  while the car charges at
// night off the grid. So when there is no fresh window this module THROWS, which
// controller.js already handles correctly: it forces rawExcess to 0 after a short
// grace period and lets the hold timer stop the charge.

const SunCalc = require('suncalc');
const db      = require('../../db');
const logger  = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/crypto');

const API_BASE     = 'https://monitoringapi.solaredge.com/v2';
const TOKEN_URL    = 'https://monitoringapi.solaredge.com/v2/oauth2/token';
const AUTHORIZE_URL = 'https://connect.solaredge.com/authorize';

// Wait this long after a quarter-hour boundary before asking for the window that
// just closed - SolarEdge needs a moment to aggregate it. Asking at :00:00 sharp
// tends to return the previous window and waste the call.
const WINDOW_SETTLE_MS = 90 * 1000;

// A cached reading older than this is not served - it is a hard failure instead.
// One 15-min window + settle time + a missed poll still fits inside this; beyond
// it we genuinely do not know what the roof is doing.
const MAX_READING_AGE_MS = 40 * 60 * 1000;

// Refresh the access token this long before it actually expires (they last 2h).
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

// Poll only while the sun is above this elevation, rather than between sunrise and
// sunset. Two reasons. Below roughly this angle a panel makes a few percent of its
// rating - under the diversion threshold, so those windows could never start a
// charge anyway. And the shoulders are expensive: at a French latitude, nominal
// daylight in June runs past 16 hours, which at one call per quarter-hour is ~2,010
// calls a month - just over the Free tier's 2,000. Gating on elevation instead
// trims midsummer to about 14 hours and keeps the whole year inside the allowance.
const MIN_SUN_ELEVATION_RAD = 7 * Math.PI / 180;

let _cache = null;          // { solarW, consumptionW, gridW, windowStartMs, fetchedAt }
let _lastWindowPolled = 0;  // window-start ms of the last window we actually asked for
let _refreshInFlight = null;
let _budgetWarned = false;

// ── Config ────────────────────────────────────────────────────────────────────

function _cfg() {
  return {
    clientId:     db.getSetting('solaredge_client_id')     || '',
    clientSecret: db.getSetting('solaredge_client_secret') || '',
    siteId:       db.getSetting('solaredge_site_id')       || '',
    // Free tier is 2,000 credits/month with no overage - once spent, calls are
    // blocked until the next billing cycle. Default leaves headroom for the
    // setup wizard's test calls and any manual poking.
    budget: parseInt(db.getSetting('solaredge_monthly_budget') || '1900', 10),
  };
}

function isConfigured() {
  const c = _cfg();
  return !!(c.clientId && c.clientSecret && c.siteId && db.getToken('solaredge'));
}

// ── Credit budget ─────────────────────────────────────────────────────────────
//
// Counts calls inside the current calendar month. SolarEdge resets on the billing
// anniversary rather than the 1st, so this is an approximation - deliberately a
// conservative one, since the default budget sits below the real allowance.

function _budgetState() {
  const cycle = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (db.getSetting('solaredge_budget_cycle') !== cycle) {
    db.setSetting('solaredge_budget_cycle', cycle);
    db.setSetting('solaredge_calls_used', '0');
    _budgetWarned = false;
  }
  return parseInt(db.getSetting('solaredge_calls_used') || '0', 10);
}

function _countCall() {
  db.setSetting('solaredge_calls_used', String(_budgetState() + 1));
}

function getBudgetStatus() {
  const used = _budgetState();
  const { budget } = _cfg();
  return { used, budget, remaining: Math.max(0, budget - used) };
}

// ── Daylight window ───────────────────────────────────────────────────────────

function _isDaylight(now = new Date()) {
  const lat = parseFloat(db.getSetting('home_latitude')  || '');
  const lon = parseFloat(db.getSetting('home_longitude') || '');
  // No coordinates configured: we cannot tell night from day, so never skip a
  // poll on that basis. Costs credits - the budget guard is then the only thing
  // standing between this and the monthly cliff - but silently refusing to read
  // the meter because a location field is blank would be far worse.
  if (isNaN(lat) || isNaN(lon)) return true;

  return SunCalc.getPosition(now, lat, lon).altitude > MIN_SUN_ELEVATION_RAD;
}

/** Start of the most recently CLOSED quarter-hour window, in ms. */
function _lastClosedWindowStart(nowMs) {
  const q = 15 * 60 * 1000;
  return Math.floor(nowMs / q) * q - q;
}

function _shouldPoll(nowMs) {
  if (!_isDaylight(new Date(nowMs))) return false;

  const windowStart = _lastClosedWindowStart(nowMs);
  if (windowStart <= _lastWindowPolled) return false;           // already have it
  if (nowMs - (windowStart + 15 * 60 * 1000) < WINDOW_SETTLE_MS) return false;

  const { used, budget } = getBudgetStatus();
  if (used >= budget) {
    if (!_budgetWarned) {
      _budgetWarned = true;
      logger.logEvent('api_error',
        `SolarEdge monthly credit budget reached (${used}/${budget}) - polling paused until next cycle`);
    }
    return false;
  }
  return true;
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

function _readToken() {
  const row = db.getToken('solaredge');
  if (!row) return null;
  try {
    return { ...JSON.parse(decrypt(row.token_data)), expiresAt: row.expires_at };
  } catch (err) {
    logger.logEvent('api_error', `SolarEdge token unreadable: ${err.message}`);
    return null;
  }
}

function _saveToken(data) {
  // Every refresh returns a NEW refresh token and invalidates the old one, so the
  // pair must be written together and immediately - losing the new one locks the
  // install out and forces a manual re-authorise.
  const expiresAt = Date.now() + (parseInt(data.expires_in, 10) || 7200) * 1000;
  db.setToken(
    'solaredge',
    encrypt(JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token })),
    expiresAt,
    null,
  );
  return { access_token: data.access_token, refresh_token: data.refresh_token, expiresAt };
}

async function _postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SolarEdge token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Exchange an authorization code for the first token pair. Called from the auth route. */
async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = _cfg();
  const data = await _postToken({
    grant_type:    'authorization_code',
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
  });
  return _saveToken(data);
}

/**
 * A valid access token, refreshing if it is close to expiry.
 * Refreshes are serialised: two concurrent refreshes would each rotate the
 * refresh token and invalidate the other's, locking the install out.
 */
async function _accessToken() {
  const tok = _readToken();
  if (!tok) throw new Error('SolarEdge not authorised - connect it in Settings');
  if (tok.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return tok.access_token;

  if (!_refreshInFlight) {
    const { clientId, clientSecret } = _cfg();
    _refreshInFlight = _postToken({
      grant_type:    'refresh_token',
      refresh_token: tok.refresh_token,
      client_id:     clientId,
      client_secret: clientSecret,
    })
      .then((data) => {
        const saved = _saveToken(data);
        logger.logEvent('token', 'SolarEdge access token refreshed');
        return saved.access_token;
      })
      .finally(() => { _refreshInFlight = null; });
  }
  return _refreshInFlight;
}

// ── Readings ──────────────────────────────────────────────────────────────────

/**
 * Pull the newest value of one metric out of the /meters/telemetry envelope.
 * Metrics are spread across meters - a production meter carries productionPower,
 * a consumption meter carries consumptionPower/importPower/exportPower - so this
 * scans every meter rather than assuming which one holds what.
 * Returns { value, timestampMs } or null.
 */
function _newestMetric(meters, metric) {
  let best = null;
  for (const meter of Object.values(meters || {})) {
    const series = meter && meter[metric];
    for (const point of (series && series.values) || []) {
      const ts = Date.parse(point.timestamp);
      if (isNaN(ts) || point.value == null) continue;
      if (!best || ts > best.timestampMs) best = { value: Number(point.value), timestampMs: ts };
    }
  }
  return best;
}

async function _pollApi() {
  const { siteId } = _cfg();
  const token = await _accessToken();

  // QUARTER_HOUR allows up to 12h per query; 90 minutes is enough to cover the
  // window we want plus a couple of missed polls, and keeps the response small.
  const to   = new Date();
  const from = new Date(to.getTime() - 90 * 60 * 1000);
  const url  = `${API_BASE}/sites/${encodeURIComponent(siteId)}/meters/telemetry`
             + `?resolution=QUARTER_HOUR&from=${from.toISOString()}&to=${to.toISOString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  _countCall();

  if (res.status === 401) throw new Error('401 SolarEdge token rejected');
  if (res.status === 429) throw new Error('429 SolarEdge rate limit or credit allowance exhausted');
  if (!res.ok) throw new Error(`SolarEdge API returned ${res.status}`);

  const data = await res.json();
  const meters = data && data.meters;
  if (!meters) throw new Error('SolarEdge response missing `meters` - unexpected API shape');

  const production  = _newestMetric(meters, 'productionPower');
  const consumption = _newestMetric(meters, 'consumptionPower');
  const importPower = _newestMetric(meters, 'importPower');
  const exportPower = _newestMetric(meters, 'exportPower');

  // V1 reported grid as a magnitude plus a direction to infer; V2 gives import and
  // export as separate explicit series, so the sign needs no guessing. WattSnatch's
  // convention is positive = importing.
  const gridW = importPower || exportPower
    ? Math.round((importPower ? importPower.value : 0) - (exportPower ? exportPower.value : 0))
    : null;

  // Which metrics exist depends on what meters are fitted, and a single grid meter
  // at the connection point is a common installation - it reports only import and
  // export, no production or consumption series at all.
  //
  // That is still enough to drive diversion, because the quantity controller.js
  // actually needs is  solarW - consumptionW,  and physically
  //
  //     production - consumption  ==  export - import
  //
  // so the grid meter measures the surplus directly, in one call. Mapping export to
  // solarW and import to consumptionW makes that identity fall out of the existing
  // arithmetic untouched. The cost is cosmetic: the dashboard's "solar" figure then
  // reads as surplus rather than gross production, and drops toward zero once the
  // car is consuming it all. Reading production too would need a second endpoint
  // (/inverters/telemetry) and double the credits, which does not fit the Free tier.
  let solarW, consumptionW, windowStartMs;
  if (production && consumption) {
    solarW        = Math.round(production.value);
    consumptionW  = Math.round(consumption.value);
    windowStartMs = production.timestampMs;
  } else if (importPower || exportPower) {
    solarW        = Math.round(exportPower ? exportPower.value : 0);
    consumptionW  = Math.round(importPower ? importPower.value : 0);
    windowStartMs = (exportPower || importPower).timestampMs;
  } else {
    // Nothing measurable came back. Never invent numbers here - see the header.
    throw new Error('SolarEdge returned no usable power metrics for this site');
  }

  _cache = {
    solarW,
    consumptionW,
    gridW: gridW == null ? consumptionW - solarW : gridW,
    windowStartMs,
    fetchedAt: Date.now(),
  };
  _lastWindowPolled = _lastClosedWindowStart(Date.now());
  return _cache;
}

async function fetchReadings() {
  if (!isConfigured()) throw new Error('SolarEdge V2 not configured');

  const now = Date.now();
  if (_shouldPoll(now)) {
    try {
      await _pollApi();
    } catch (err) {
      // A failed poll must not retry every tick - that would burn the monthly
      // budget in minutes. Mark this window as attempted and fall through to the
      // cache, which throws on its own if it has gone stale.
      _lastWindowPolled = _lastClosedWindowStart(now);
      if (!_cache) throw err;
      logger.logEvent('api_error', `SolarEdge poll failed, serving cached window: ${err.message}`);
    }
  }

  if (!_cache) throw new Error('SolarEdge: no reading yet (outside solar window or awaiting first poll)');

  const age = now - _cache.windowStartMs;
  if (age > MAX_READING_AGE_MS) {
    throw new Error(`SolarEdge: newest window is ${Math.round(age / 60000)} min old - treating as no data`);
  }

  return {
    solarW:       _cache.solarW,
    consumptionW: _cache.consumptionW,
    gridW:        _cache.gridW,
    // /meters/telemetry at QUARTER_HOUR exposes no lifetime accumulator; the daily
    // production baseline in controller.js simply skips when this is null.
    solarActEnergyDlvdWh: null,
    timestamp: _cache.windowStartMs,
  };
}

async function testConnection() {
  try {
    // Bypass the cadence gate - a human pressed Test and wants a live answer.
    const readings = await _pollApi();
    return { ok: true, readings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function handleFetchError(err) {
  const msg = String(err && err.message);
  if (msg.includes('401')) {
    // Force a refresh on the next call by expiring what we hold.
    const tok = _readToken();
    if (tok) db.setToken('solaredge', encrypt(JSON.stringify({
      access_token: tok.access_token, refresh_token: tok.refresh_token,
    })), 0, null);
    logger.logEvent('token', 'SolarEdge returned 401 - will refresh token on next poll');
    return true;
  }
  // Night and the pre-first-poll gap are expected states, not faults worth a log
  // line every tick. The controller still treats them as "no data", which is the
  // behaviour we want; it just stops shouting about it.
  if (msg.includes('outside solar window') || msg.includes('treating as no data')) return true;
  return false;
}

/** Build the consent URL the owner visits to authorise their own site. */
function buildAuthorizeUrl(redirectUri, state) {
  const { clientId } = _cfg();
  const params = new URLSearchParams({
    client_id:       clientId,
    scope:           'SITE_DATA DEVICE_DATA',
    redirect_uri:    redirectUri,
    state,
    access_duration: '24', // months - a 2-year grant, the documented maximum
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

module.exports = {
  id: 'solaredge_v2',
  label: 'SolarEdge (API V2)',
  authType: 'oauth',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
  // Used by the auth route and the settings page, not part of the meter contract.
  buildAuthorizeUrl,
  exchangeCode,
  getBudgetStatus,
};
