/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// SPAN Panel adapter (US smart electrical panel - local REST API, bearer
// token auth).
//
// NOTE: built from SPAN's publicly documented local API shape (as used by
// several open-source SPAN integrations), but has NOT been verified against
// real SPAN hardware - I don't have a panel to test against. Please open an
// issue/PR if your panel returns something different and this needs
// adjusting.
//
// Unlike Enphase/Fronius/SolarEdge, SPAN's core concept is whole-home
// circuit-level monitoring, not a dedicated "solar production" reading - a
// SPAN panel has no single first-class solar field. Solar (if present) comes
// in as one of the panel's monitored circuits, which varies per install, so
// this adapter requires the user to identify which circuit ID is the solar
// feed (span_solar_circuit_id) rather than guessing. Because financial and
// charge-control decisions depend on this reading being correct, this
// deliberately THROWS on any missing/malformed field rather than defaulting
// to 0 - a 0 W reading is a valid real value elsewhere in the app and must
// never be silently confused with "integration broken."

const db = require('../../db');

async function _httpGetJson(url, token, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`SPAN panel rejected the access token (${res.status})`);
    }
    if (!res.ok) throw new Error(`SPAN panel API returned status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isConfigured() {
  return !!(db.getSetting('span_host') && db.getSetting('span_access_token') && db.getSetting('span_solar_circuit_id'));
}

async function fetchReadings() {
  const host = db.getSetting('span_host');
  const token = db.getSetting('span_access_token');
  const solarCircuitId = db.getSetting('span_solar_circuit_id');
  if (!host) throw new Error('SPAN panel host/IP not configured');
  if (!token) throw new Error('SPAN access token not configured');
  if (!solarCircuitId) throw new Error('SPAN solar circuit ID not configured - SPAN has no dedicated solar reading, so the monitored circuit must be identified explicitly');

  const base = host.startsWith('http') ? host : `http://${host}`;

  const panel = await _httpGetJson(`${base}/api/v1/panel`, token);
  if (typeof panel?.instantGridPowerW !== 'number') {
    throw new Error('SPAN /api/v1/panel response missing expected instantGridPowerW field - API shape may have changed');
  }

  const circuits = await _httpGetJson(`${base}/api/v1/circuits`, token);
  const circuitList = circuits?.circuits ? Object.values(circuits.circuits) : (Array.isArray(circuits) ? circuits : null);
  if (!circuitList) throw new Error('SPAN /api/v1/circuits response has an unexpected shape - API shape may have changed');

  const solarCircuit = circuitList.find(c => String(c.id) === String(solarCircuitId));
  if (!solarCircuit) throw new Error(`No SPAN circuit found matching span_solar_circuit_id "${solarCircuitId}"`);
  if (typeof solarCircuit.instantPowerW !== 'number') {
    throw new Error(`SPAN circuit "${solarCircuitId}" is missing expected instantPowerW field - API shape may have changed`);
  }

  // SPAN's instantGridPowerW convention (per public docs): positive = importing.
  const gridW = Math.round(panel.instantGridPowerW);
  // Solar circuits report generation as a positive draw from the panel's
  // perspective in some SPAN firmware versions and negative in others -
  // normalize to "solar production is always >= 0" since that's what the
  // rest of the app expects (a negative solarW would be nonsensical).
  const solarW = Math.round(Math.abs(solarCircuit.instantPowerW));

  // consumption = solar + grid is the energy-balance identity. A small
  // negative can occur from timing skew between the two sequential API
  // calls above - clamp that to 0. A large negative means the readings are
  // inconsistent (most likely span_solar_circuit_id points at the wrong
  // circuit), and a wrong consumption figure would inflate the computed
  // solar excess and drive overcharging - so fail loudly instead.
  const rawConsumptionW = solarW + gridW;
  if (rawConsumptionW < -250) {
    throw new Error(
      `SPAN readings are inconsistent (solar ${solarW}W + grid ${gridW}W = ${rawConsumptionW}W consumption) - check that span_solar_circuit_id points at the solar feed circuit`
    );
  }
  const consumptionW = Math.max(0, Math.round(rawConsumptionW));

  return {
    solarW,
    consumptionW,
    gridW,
    // SPAN's circuit API exposes lifetime energy (producedEnergyWh) per
    // circuit, but its accuracy/availability varies by firmware - left null
    // rather than guessed, see meters/README.md for what this null means.
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
  return false; // static access token doesn't expire the way an OAuth token does - nothing to refresh
}

module.exports = {
  id: 'span',
  label: 'SPAN Panel',
  authType: 'local-key',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
};
