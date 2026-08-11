/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// ElectricityMaps grid-carbon-intensity provider.
//
// ElectricityMaps serves the SAME endpoint path from two different hosts, and
// which one your key works against depends on which product you signed up for:
//
//   Free tier   https://api-access.electricitymaps.com/free-tier/carbon-intensity/latest
//   Commercial  https://api.electricitymap.org/v3/carbon-intensity/latest
//
// A free-tier token sent to the commercial host is rejected with 401. This
// provider originally only knew about the commercial host, so every self-hosted
// user - who will almost always have a free-tier key - got
// "auth failed (401) - check electricitymaps_api_key" and understandably went
// looking for a problem with their key. That was reported as issue #8.
//
// Rather than making people know which tier they are on, both hosts are tried
// and the one that answers is remembered. Auth header is `auth-token` on both.
//
// Response shape (identical on both hosts):
//   { zone, carbonIntensity, datetime, updatedAt, emissionFactorType, isEstimated }
// `carbonIntensity` is already gCO2eq/kWh - no fuel-mix arithmetic needed,
// unlike AEMO.
//
// The free tier allows 50 requests an hour and one zone. WattSnatch polls grid
// intensity every 5 minutes (12/hour), so a single probe of the second host on
// first use is comfortably within budget.

const db = require('../../db');

const FETCH_TIMEOUT_MS = 15 * 1000;

// Free tier first: it is what a self-hosted install almost always has, so the
// common case costs one request and the fallback is the rare path.
const BASE_URLS = [
  { tier: 'free',       url: 'https://api-access.electricitymaps.com/free-tier/carbon-intensity/latest' },
  { tier: 'commercial', url: 'https://api.electricitymap.org/v3/carbon-intensity/latest' },
];

// Which host this key authenticated against, so later polls go straight there.
// Persisted so the answer survives a restart; the in-memory copy avoids a
// settings read per poll.
const TIER_SETTING = 'electricitymaps_api_tier';
let _knownTier = null;

function isConfigured() {
  return !!(db.getSetting('electricitymaps_api_key') && db.getSetting('grid_intensity_region'));
}

/** Single attempt against one host. Returns the parsed body or throws. */
async function _fetchFrom(baseUrl, apiKey, zone) {
  const res = await fetch(`${baseUrl}?zone=${encodeURIComponent(zone)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'auth-token': apiKey, 'Accept': 'application/json' },
  });

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`auth rejected (${res.status})`);
    err.isAuthError = true;
    throw err;
  }
  if (res.status === 404) {
    // Wrong host for this key, or a zone this product does not cover.
    const err = new Error('not found (404)');
    err.isAuthError = true; // treat as "try the other host"
    throw err;
  }
  if (res.status === 429) {
    throw new Error('rate limited (429) - the free tier allows 50 requests an hour');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const raw = await res.json();
  if (typeof raw.carbonIntensity !== 'number') {
    throw new Error('response missing the carbonIntensity field - the API shape may have changed');
  }
  return raw;
}

async function fetchGridIntensity() {
  const apiKey = db.getSetting('electricitymaps_api_key');
  const zone = db.getSetting('grid_intensity_region');
  if (!apiKey || !zone) {
    throw new Error('not configured - electricitymaps_api_key and grid_intensity_region are required');
  }

  if (_knownTier === null) _knownTier = db.getSetting(TIER_SETTING) || null;

  // Known tier first, then the others. On a fresh key this is just BASE_URLS
  // in order; once one works it is tried first every time after.
  const ordered = _knownTier
    ? [...BASE_URLS].sort((a, b) => (a.tier === _knownTier ? -1 : b.tier === _knownTier ? 1 : 0))
    : BASE_URLS;

  const failures = [];
  for (const { tier, url } of ordered) {
    try {
      const raw = await _fetchFrom(url, apiKey, zone);
      if (_knownTier !== tier) {
        _knownTier = tier;
        try { db.setSetting(TIER_SETTING, tier); } catch (_e) { /* cosmetic - retried next poll */ }
      }
      return {
        renewablePct:      null,   // a separate "power-breakdown" endpoint has this
        carbonIntensityG:  Math.round(raw.carbonIntensity),
        solarMw:           null,
        windMw:            null,
        coalMw:            null,
        gasMw:             null,
        hydroMw:           null,
        totalDemandMw:     null,
        spotPriceAuMwh:    null,
        settlementDate:    raw.datetime || null,
      };
    } catch (err) {
      failures.push(`${tier}: ${err.message}`);
      // Only an auth/404 failure means "wrong host, try the other one". A
      // timeout or a 500 says nothing about the key, so stop and report it
      // rather than burning the second request and blaming the wrong thing.
      if (!err.isAuthError) {
        throw new Error(`ElectricityMaps ${tier} endpoint: ${err.message}`);
      }
    }
  }

  // Rejected by both hosts - almost always a bad or inactive key, or a zone the
  // key is not entitled to. Name both attempts so the cause is visible without
  // reading the source.
  throw new Error(
    `ElectricityMaps rejected the API key for zone "${zone}" on both endpoints `
    + `(${failures.join('; ')}). Check the key is copied correctly and still active at `
    + `portal.electricitymaps.com, and that it covers this zone - the free tier allows one zone only.`
  );
}

/**
 * Configuration check for the Settings "Test" button.
 *
 * Returns a plain result rather than throwing so the UI can show the real
 * reason at the point of configuration, instead of the user having to save,
 * navigate to the dashboard, notice nothing changed, and go digging in the
 * server log to find a 401 (which is exactly what happened in issue #8).
 */
async function testConnection() {
  try {
    const payload = await fetchGridIntensity();
    return {
      ok: true,
      tier: _knownTier,
      carbonIntensityG: payload.carbonIntensityG,
      zone: db.getSetting('grid_intensity_region'),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  id: 'electricitymaps',
  label: 'ElectricityMaps',
  isConfigured,
  fetchGridIntensity,
  testConnection,
};
