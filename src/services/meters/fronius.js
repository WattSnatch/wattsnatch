/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Fronius Solar API v1 adapter (local network, no cloud account, no auth - same
// "just talk to it on the LAN" model as the Enphase gateway).
//
// NOTE: built to Fronius's publicly documented Solar API v1 spec
// (GetPowerFlowRealtimeData.fcgi), but has not been verified against real Fronius
// hardware - I don't have a Fronius system to test against. Field names and sign
// conventions below match Fronius's own documentation; please open an issue/PR if
// your inverter returns something different and this needs adjusting.

const db = require('../../db');

async function _httpGetJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Fronius returned status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isConfigured() {
  return !!db.getSetting('fronius_ip');
}

async function fetchReadings() {
  const ip = db.getSetting('fronius_ip');
  if (!ip) throw new Error('Fronius inverter IP not configured');

  const url = `http://${ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`;
  const data = await _httpGetJson(url);

  const site = data && data.Body && data.Body.Data && data.Body.Data.Site;
  if (!site) throw new Error('Fronius response missing Body.Data.Site - unexpected API shape');

  // Fronius sign convention: P_Grid positive = importing (matches WattSnatch's own
  // convention already, no flip needed). P_Load is reported negative (consumption);
  // P_PV is positive production, null/0 if not producing.
  const gridW        = typeof site.P_Grid === 'number' ? site.P_Grid : 0;
  const consumptionW = typeof site.P_Load === 'number' ? Math.abs(site.P_Load) : 0;
  const solarW       = typeof site.P_PV   === 'number' ? Math.max(0, site.P_PV) : 0;

  return {
    solarW,
    consumptionW,
    gridW,
    // GetPowerFlowRealtimeData only exposes today's energy (E_Day), which resets daily -
    // not the lifetime accumulator this field's contract expects (see meters/README.md),
    // so left null rather than feeding in a value that would break the midnight-baseline logic.
    solarActEnergyDlvdWh: null,
    timestamp: Date.now(),
  };
}

async function testConnection() {
  try {
    const readings = await fetchReadings();
    return { ok: true, readings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function handleFetchError(_err) {
  return false; // no provider-specific auth-refresh behaviour - local API, no tokens
}

module.exports = {
  id: 'fronius',
  label: 'Fronius (local Solar API)',
  authType: 'none',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
};
