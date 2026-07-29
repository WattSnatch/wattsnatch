/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Tesla Powerwall adapter - local Tesla Energy Gateway (TEG) API. No cloud
// account or Tesla Fleet API token needed for reading.
//
// Login flow, endpoints and the self-signed-cert/SNI handling below are
// taken from the andig/go-powerwall library (MIT licensed, see
// THIRD_PARTY_LICENSES.md), which is what evcc-io/evcc itself depends on for
// Powerwall support - NOT verified against a real gateway, same
// "best-effort" status as the SPAN Panel provider.
//
// Read-only by design: the only battery-related *write* the Gateway/Fleet
// API exposes is the backup reserve percentage, and that requires the Tesla
// cloud Fleet API (OAuth refresh token), not the local Gateway. Reserve is a
// discharge-floor setting for outage backup, not a charge-power limit or
// pause - it gives no way to make the Powerwall yield solar to the EV. So
// `ev_first` priority has no effect on Powerwall; Settings surfaces this as
// unsupported for this brand rather than silently no-op'ing.

const https = require('https');
const db = require('../../db');

let _cachedToken = null;

function _request(host, method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (token) headers['Cookie'] = `AuthCookie=${token}`;

    const req = https.request({
      host, port: 443, path: `/api/${apiPath}`, method, headers,
      // Self-signed gateway cert - not independently verifiable without the
      // user pinning it themselves, same trust model as Enphase's local API.
      rejectUnauthorized: false,
      // The gateway drops the TLS handshake without a recognized SNI hostname
      // matching one of its hardcoded stock names, even though the cert
      // itself isn't checked - go-powerwall works around this the same way.
      servername: 'powerwall',
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch (_e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Powerwall gateway request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

async function _login(host, email, password) {
  const res = await _request(host, 'POST', 'login/Basic',
    { username: 'customer', email, password, force_sm_off: false }, null);
  if (!res.json || !res.json.token) {
    throw new Error('Powerwall gateway login failed - check gateway email/password');
  }
  return res.json.token;
}

async function _authedGet(host, apiPath, email, password) {
  if (!_cachedToken) _cachedToken = await _login(host, email, password);
  let res = await _request(host, 'GET', apiPath, null, _cachedToken);
  if (res.status === 401 || res.status === 403) {
    _cachedToken = await _login(host, email, password);
    res = await _request(host, 'GET', apiPath, null, _cachedToken);
  }
  if (res.status !== 200) throw new Error(`Powerwall gateway returned status ${res.status} for ${apiPath}`);
  return res.json;
}

function isConfigured() {
  return !!(db.getSetting('powerwall_host') && db.getSetting('powerwall_email') && db.getSetting('powerwall_password'));
}

async function fetchReadings() {
  const host     = db.getSetting('powerwall_host');
  const email    = db.getSetting('powerwall_email');
  const password = db.getSetting('powerwall_password');
  if (!host)     throw new Error('Powerwall gateway host/IP not configured');
  if (!email)    throw new Error('Powerwall gateway email not configured');
  if (!password) throw new Error('Powerwall gateway password not configured');

  const aggregates = await _authedGet(host, 'meters/aggregates', email, password);
  const battery = aggregates && aggregates.battery;
  if (!battery || typeof battery.instant_power !== 'number') {
    throw new Error('Powerwall meters/aggregates response missing expected battery.instant_power field - gateway API may have changed');
  }

  const soe = await _authedGet(host, 'system_status/soe', email, password);
  if (!soe || typeof soe.percentage !== 'number') {
    throw new Error('Powerwall system_status/soe response missing expected percentage field - gateway API may have changed');
  }

  let capacityWh = null;
  try {
    const status = await _authedGet(host, 'system_status', email, password);
    if (status && typeof status.nominal_full_pack_energy === 'number') {
      capacityWh = Math.round(status.nominal_full_pack_energy);
    }
  } catch (_e) {
    // Non-fatal - capacity is cosmetic, SoC/power are what matter for priority logic.
  }

  // Commonly documented Powerwall convention (matches other local-API
  // integrations in the community, e.g. pypowerwall): the "battery" meter's
  // instant_power is negative while charging, positive while discharging.
  // Our own contract is the opposite (+ = charging), for consistency with
  // the Sigenergy/Sungrow providers - hence the negation.
  const powerW = Math.round(-battery.instant_power);

  return { socPct: soe.percentage, powerW, capacityWh, timestamp: Date.now() };
}

async function testConnection() {
  try {
    const readings = await fetchReadings();
    return { ok: true, readings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  id: 'tesla_powerwall',
  label: 'Tesla Powerwall',
  authType: 'local-key',
  capabilities: ['read'],
  isConfigured,
  fetchReadings,
  testConnection,
};
