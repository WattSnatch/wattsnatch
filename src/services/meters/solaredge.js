/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// SolarEdge Monitoring API adapter (cloud, API-key based - instant self-service
// key generation from the SolarEdge monitoring portal, no approval wait).
//
// NOTE: built to SolarEdge's publicly documented Monitoring API
// (site/{id}/currentPowerFlow.json), but has not been verified against a real
// SolarEdge account/site - I don't have one to test against. Please open an
// issue/PR if your site returns something different and this needs adjusting.

const db = require('../../db');

const API_BASE = 'https://monitoringapi.solaredge.com';

async function _httpGetJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`SolarEdge API returned status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isConfigured() {
  return !!(db.getSetting('solaredge_api_key') && db.getSetting('solaredge_site_id'));
}

async function fetchReadings() {
  const apiKey = db.getSetting('solaredge_api_key');
  const siteId = db.getSetting('solaredge_site_id');
  if (!apiKey) throw new Error('SolarEdge API key not configured');
  if (!siteId) throw new Error('SolarEdge site ID not configured');

  const url = `${API_BASE}/site/${encodeURIComponent(siteId)}/currentPowerFlow.json?api_key=${encodeURIComponent(apiKey)}`;
  const data = await _httpGetJson(url);

  const flow = data && data.siteCurrentPowerFlow;
  if (!flow) throw new Error('SolarEdge response missing siteCurrentPowerFlow - unexpected API shape');

  // SolarEdge reports magnitudes in kW plus a `connections` array describing flow
  // direction (e.g. {"from":"GRID","to":"Load"} = importing), rather than a signed
  // grid value like Enphase/Fronius. Derive the signed gridW WattSnatch expects from
  // that topology.
  const pvKw    = flow.PV   ? parseFloat(flow.PV.currentPower)   || 0 : 0;
  const loadKw  = flow.LOAD ? parseFloat(flow.LOAD.currentPower) || 0 : 0;
  const gridKw  = flow.GRID ? parseFloat(flow.GRID.currentPower) || 0 : 0;

  let gridImporting = true; // default assumption if connections are missing/ambiguous
  if (Array.isArray(flow.connections)) {
    const gridToLoad = flow.connections.some(c =>
      String(c.from).toUpperCase() === 'GRID' && String(c.to).toUpperCase().includes('LOAD'));
    const loadToGrid = flow.connections.some(c =>
      String(c.from).toUpperCase().includes('LOAD') && String(c.to).toUpperCase() === 'GRID');
    if (loadToGrid && !gridToLoad) gridImporting = false;
  }

  return {
    solarW:       Math.round(pvKw * 1000),
    consumptionW: Math.round(loadKw * 1000),
    gridW:        Math.round((gridImporting ? gridKw : -gridKw) * 1000),
    // currentPowerFlow doesn't expose a lifetime energy accumulator (that's a
    // separate /site/{id}/energy endpoint) - left null, see meters/README.md.
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
  return false; // API key doesn't expire the way an OAuth token does - nothing to refresh
}

module.exports = {
  id: 'solaredge',
  label: 'SolarEdge',
  authType: 'cloud-key',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
};
