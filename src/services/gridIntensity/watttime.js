/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// WattTime grid-carbon-intensity provider (best-effort).
//
// IMPORTANT: implemented from WattTime's publicly documented API WITHOUT a
// live API key/account to test against. WattTime has changed API versions
// before (v2 -> v3) - if this stops working, check https://www.watttime.org/api-documentation/
// and update accordingly. Fails loudly (logs clearly) rather than silently
// returning a plausible-looking but wrong value.
//
// Auth model: WattTime requires a short-lived bearer token obtained via
// HTTP Basic Auth against a /login endpoint, then used on the actual data
// request - this is heavier than ElectricityMaps' single-header-key model,
// so this provider caches the token in memory for its stated TTL rather than
// logging in on every poll.
//
// Expected response shape (per public docs, v3 "signal-index" endpoint):
//   GET https://api.watttime.org/v3/signal-index?region=<ba>&signal_type=co2_moer
//   Header: Authorization: Bearer <token>
//   { data: [{ point_time, value }], meta: { region, signal_type, units } }
// `value` here is a MOER (Marginal Operating Emissions Rate) in the unit
// given by `meta.units` - typically lbs/MWh, which this converts to
// gCO2eq/kWh (the unit the rest of the app uses) via a fixed conversion
// factor. If WattTime's units differ from what's assumed here, the
// conversion below will be wrong - this is exactly the kind of thing that
// can't be caught without a live account, hence the loud logging on any
// unexpected shape rather than a silent bad value.

const db = require('../../db');
const logger = require('../../utils/logger');

const FETCH_TIMEOUT_MS = 15 * 1000;
const LOGIN_URL = 'https://api.watttime.org/login';
const INDEX_URL = 'https://api.watttime.org/v3/signal-index';
const LBS_PER_MWH_TO_G_PER_KWH = 453.592 / 1000; // 1 lb = 453.592 g; per MWh -> per kWh is /1000

let _token = null;
let _tokenExpiresAt = 0;

function isConfigured() {
  return !!(db.getSetting('watttime_username') && db.getSetting('watttime_password') && db.getSetting('grid_intensity_region'));
}

async function _login() {
  const username = db.getSetting('watttime_username');
  const password = db.getSetting('watttime_password');
  const res = await fetch(LOGIN_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`WattTime login failed (${res.status}) - check watttime_username/watttime_password`);
  }
  if (!res.ok) throw new Error(`WattTime login API ${res.status}`);
  const raw = await res.json();
  if (!raw.token) throw new Error('WattTime login response missing expected token field - API shape may have changed');
  _token = raw.token;
  _tokenExpiresAt = Date.now() + 25 * 60 * 1000; // WattTime tokens are historically ~30min-lived; refresh a bit early
  return _token;
}

async function fetchGridIntensity() {
  const region = db.getSetting('grid_intensity_region');
  if (!isConfigured()) {
    throw new Error('not configured - watttime_username, watttime_password and grid_intensity_region are required');
  }

  if (!_token || Date.now() >= _tokenExpiresAt) {
    await _login();
  }

  let res = await fetch(`${INDEX_URL}?region=${encodeURIComponent(region)}&signal_type=co2_moer`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Authorization': `Bearer ${_token}` },
  });

  // Token may have been rejected server-side even though we thought it was
  // still valid (e.g. clock skew) - one retry after a forced re-login.
  if (res.status === 401) {
    logger.logEvent('api_error', '[gridIntensity/watttime] Token rejected, re-authenticating');
    await _login();
    res = await fetch(`${INDEX_URL}?region=${encodeURIComponent(region)}&signal_type=co2_moer`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Authorization': `Bearer ${_token}` },
    });
  }

  if (!res.ok) throw new Error(`WattTime index API ${res.status}`);
  const raw = await res.json();

  const point = raw.data && raw.data[0];
  if (!point || typeof point.value !== 'number') {
    throw new Error('WattTime response missing expected data[0].value field - API shape may have changed');
  }

  const units = raw.meta?.units || 'lbs_per_mwh';
  const carbonIntensityG = units === 'lbs_per_mwh'
    ? Math.round(point.value * LBS_PER_MWH_TO_G_PER_KWH)
    : Math.round(point.value); // assume already gCO2/kWh if units differ from the documented default

  return {
    renewablePct:      null, // not provided by this endpoint
    carbonIntensityG,
    solarMw:           null,
    windMw:            null,
    coalMw:            null,
    gasMw:             null,
    hydroMw:           null,
    totalDemandMw:     null,
    spotPriceAuMwh:    null,
    settlementDate:    point.point_time || null,
  };
}

module.exports = { id: 'watttime', label: 'WattTime', isConfigured, fetchGridIntensity };
