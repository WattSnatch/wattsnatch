/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// ElectricityMaps grid-carbon-intensity provider (best-effort).
//
// IMPORTANT: implemented from ElectricityMaps' publicly documented free-tier
// API (v3 "carbon intensity, latest" endpoint), WITHOUT a live API key to
// test against. The request/response shape may have changed since this was
// written - if this stops working, check https://static.electricitymaps.com/api/docs/index.html
// and update accordingly. Fails loudly (logs clearly) rather than silently
// returning a plausible-looking but wrong value.
//
// Expected response shape (per public docs):
//   GET https://api.electricitymap.org/v3/carbon-intensity/latest?zone=<zone>
//   Header: auth-token: <api key>
//   { zone, carbonIntensity, datetime, updatedAt, emissionFactorType, isEstimated }
// `carbonIntensity` is already gCO2eq/kWh - no fuel-mix arithmetic needed,
// unlike AEMO.

const db = require('../../db');

const FETCH_TIMEOUT_MS = 15 * 1000;
const BASE_URL = 'https://api.electricitymap.org/v3/carbon-intensity/latest';

function isConfigured() {
  return !!(db.getSetting('electricitymaps_api_key') && db.getSetting('grid_intensity_region'));
}

async function fetchGridIntensity() {
  const apiKey = db.getSetting('electricitymaps_api_key');
  const zone = db.getSetting('grid_intensity_region');
  if (!apiKey || !zone) {
    throw new Error('not configured - electricitymaps_api_key and grid_intensity_region are required');
  }

  const url = `${BASE_URL}?zone=${encodeURIComponent(zone)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'auth-token': apiKey, 'Accept': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`ElectricityMaps auth failed (${res.status}) - check electricitymaps_api_key`);
  }
  if (!res.ok) throw new Error(`ElectricityMaps API ${res.status}`);
  const raw = await res.json();

  if (typeof raw.carbonIntensity !== 'number') {
    throw new Error('ElectricityMaps response missing expected carbonIntensity field - API shape may have changed');
  }

  return {
    renewablePct:      null,   // not provided by this endpoint (a separate "power-breakdown" endpoint has it)
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
}

module.exports = { id: 'electricitymaps', label: 'ElectricityMaps', isConfigured, fetchGridIntensity };
