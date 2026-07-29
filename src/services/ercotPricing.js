/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// ERCOT (Texas) real-time wholesale price - a SUPPLEMENTARY signal, not a
// rate-resolver mode. Most Texas residential retail plans aren't 1:1
// wholesale pass-through, so this is deliberately kept separate from
// createRateResolver()/the TOU rate architecture - conflating a live
// wholesale price with "the rate you actually pay" would risk wrong cost
// math for most users. This is off by default (ercot_pricing_enabled) and
// only ever consulted as an optional advisory input, never a hard block.
//
// IMPORTANT: implemented from ERCOT's publicly documented Public API
// (api.ercot.com) WITHOUT a live account to test against. Unlike AEMO's
// fully open endpoint, ERCOT has historically required a registered account
// even for "public" market data (subscription key + OAuth2), so the exact
// auth flow/endpoint/report ID below may not be current - if this stops
// working, check https://developer.ercot.com and update accordingly. Fails
// loudly (logs clearly) rather than silently returning a plausible-looking
// but wrong price.

const db = require('../db');
const logger = require('../utils/logger');

const FETCH_TIMEOUT_MS = 15 * 1000;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min, matching the grid-intensity cadence
// Real-Time Settlement Point Prices report, per ERCOT's public API catalog.
const SPP_URL = 'https://api.ercot.com/api/public-reports/np6-905-cd/spp_node_zone_hub';

let _timer = null;
let _started = false;
let _cache = null; // { recordedAt, priceUsdMwh, settlementPoint } | { recordedAt, notConfigured: true }

function isConfigured() {
  return db.getSetting('ercot_pricing_enabled') === 'true'
    && !!db.getSetting('ercot_api_username')
    && !!db.getSetting('ercot_api_password')
    && !!db.getSetting('ercot_settlement_point');
}

async function fetchCurrentPrice() {
  const username = db.getSetting('ercot_api_username');
  const password = db.getSetting('ercot_api_password');
  const settlementPoint = db.getSetting('ercot_settlement_point');

  const url = `${SPP_URL}?settlementPoint=${encodeURIComponent(settlementPoint)}&size=1`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      'Accept': 'application/json',
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`ERCOT auth failed (${res.status}) - check ercot_api_username/ercot_api_password`);
  }
  if (!res.ok) throw new Error(`ERCOT API ${res.status}`);
  const raw = await res.json();

  const row = raw.data && raw.data[0];
  if (!row || typeof row.settlementPointPrice !== 'number') {
    throw new Error('ERCOT response missing expected settlementPointPrice field - API shape may have changed');
  }

  return {
    priceUsdMwh:      row.settlementPointPrice,
    settlementPoint,
    intervalEndingAt: row.intervalEnding || null,
  };
}

async function _poll() {
  if (!isConfigured()) {
    _cache = { recordedAt: Date.now(), notConfigured: true };
    return;
  }
  try {
    const data = await fetchCurrentPrice();
    _cache = { recordedAt: Date.now(), ...data };
  } catch (err) {
    logger.logEvent('api_error', `[ercotPricing] Fetch failed: ${err.message}`);
    // Keep serving the last good cache rather than clearing it on a
    // transient failure - a stale-but-real price is more useful than none.
  }
}

function start() {
  if (_started) return;
  _started = true;
  _poll();
  _timer = setInterval(_poll, POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
}

function getCachedPrice() {
  return _cache;
}

// Advisory-only helper for scheduling logic (e.g. departureScheduler) to
// optionally consult. Returns false whenever unconfigured/no data, so any
// caller using this as a gate is safe-by-default (never blocks/delays
// anything unless the feature is explicitly enabled and has real data).
// Also returns false when the cached price is stale (fetches failing) -
// a spike observed 3 polls ago says nothing about the price now, and
// acting on it would delay charging off dead data.
const SPIKE_MAX_AGE_MS = 15 * 60 * 1000;

function isPriceSpiking(thresholdUsdMwh = 200) {
  if (!_cache || _cache.notConfigured || typeof _cache.priceUsdMwh !== 'number') return false;
  if (Date.now() - _cache.recordedAt > SPIKE_MAX_AGE_MS) return false;
  return _cache.priceUsdMwh >= thresholdUsdMwh;
}

module.exports = { start, stop, isConfigured, fetchCurrentPrice, getCachedPrice, isPriceSpiking };
