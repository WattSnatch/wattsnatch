/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const https = require('https');
const http = require('http');

// Agent that ignores self-signed certificates (required for Enphase IQ Gateway)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: isHttps ? insecureAgent : undefined,
      timeout: options.timeout || 15000,
    };

    const req = transport.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Decode a JWT payload (base64url) and return the parsed object.
 */
function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '==='.slice(0, (4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

/**
 * Obtain a local gateway JWT from Enlighten + Entrez.
 * Step 1: POST to Enlighten login to get a session_id.
 * Step 2: POST to Entrez with session_id + serial to get a JWT.
 */
async function generateGatewayToken(email, password, gatewaySerial) {
  // Step 1: Enlighten login
  const loginBody = `user[email]=${encodeURIComponent(email)}&user[password]=${encodeURIComponent(password)}`;
  const loginRes = await httpFetch('https://enlighten.enphaseenergy.com/login/login.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(loginBody),
    },
    body: loginBody,
    timeout: 20000,
  });

  if (loginRes.status !== 200) {
    throw new Error(`Enlighten login failed with status ${loginRes.status}`);
  }

  let loginData;
  try {
    loginData = JSON.parse(loginRes.body);
  } catch (_err) {
    throw new Error('Enlighten login returned non-JSON response');
  }

  const sessionId = loginData.session_id;
  if (!sessionId) {
    throw new Error('No session_id in Enlighten login response');
  }

  // Step 2: Entrez token - username must be the email, not any other field from the login response
  const tokenBody = JSON.stringify({
    session_id: sessionId,
    serial_num: gatewaySerial,
    username: email,
  });

  const tokenRes = await httpFetch('https://entrez.enphaseenergy.com/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(tokenBody),
    },
    body: tokenBody,
    timeout: 20000,
  });

  if (tokenRes.status !== 200) {
    throw new Error(`Entrez token request failed with status ${tokenRes.status}`);
  }

  const jwt = tokenRes.body.trim();
  if (!jwt || !jwt.includes('.')) {
    throw new Error('Entrez returned invalid JWT');
  }

  // Decode expiry from JWT payload
  const payload = decodeJwtPayload(jwt);
  const expiresAt = payload.exp ? payload.exp * 1000 : Date.now() + 6 * 30 * 24 * 60 * 60 * 1000;

  return { jwt, expiresAt };
}

/**
 * Fetch meter readings from the local Enphase IQ Gateway.
 * Returns: { solarW, consumptionW, gridW, timestamp }
 */
// Cache meter type config (EID → measurementType). Refreshed every hour.
let _meterTypeCache = null;
let _meterTypeCacheAt = 0;
const METER_TYPE_CACHE_MS = 60 * 60 * 1000;

async function fetchMeterTypes(gatewayIp, jwt) {
  const now = Date.now();
  if (_meterTypeCache && (now - _meterTypeCacheAt) < METER_TYPE_CACHE_MS) {
    return _meterTypeCache;
  }

  try {
    const res = await httpFetch(`https://${gatewayIp}/ivp/meters`, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeout: 8000,
    });
    if (res.status !== 200) return {};
    const meters = JSON.parse(res.body);
    const map = {};
    for (const m of (Array.isArray(meters) ? meters : [])) {
      if (m.eid && m.measurementType) map[m.eid] = m.measurementType;
    }
    _meterTypeCache = map;
    _meterTypeCacheAt = now;
    return map;
  } catch (_err) {
    return _meterTypeCache || {};
  }
}

async function fetchMeterReadings(gatewayIp, jwt) {
  const url = `https://${gatewayIp}/ivp/meters/readings`;
  const res = await httpFetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    timeout: 5000,
  });

  if (res.status === 401) {
    const err = new Error('Enphase JWT expired or invalid');
    err.code = 'ENPHASE_JWT_EXPIRED';
    throw err;
  }

  if (res.status !== 200) {
    throw new Error(`Enphase meter readings returned status ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (_err) {
    throw new Error('Enphase meter readings returned non-JSON');
  }

  const meters = Array.isArray(data) ? data : (data.readings || []);

  // Fetch authoritative meter types from /ivp/meters (cached hourly)
  const typeMap = await fetchMeterTypes(gatewayIp, jwt);
  const hasTypeMap = Object.keys(typeMap).length > 0;

  let solarW = 0;
  let consumptionW = 0;
  let gridW = null; // null = not yet set by a typed meter
  let solarActEnergyDlvdWh = null; // lifetime production energy accumulator

  for (const meter of meters) {
    const eid = meter.eid;
    const activePower = meter.activePower ?? meter.p ?? 0;

    // Prefer the authoritative type map; fall back to the field in the reading.
    // When a type map is available, skip EIDs not in it - they are phase
    // sub-meters or phantom entries that would corrupt aggregated values.
    let mtype = typeMap[eid] || meter.measurementType || meter.measurement_type || '';
    if (hasTypeMap && !typeMap[eid]) continue;

    // Fall back to EID ranges when no type information is available at all
    if (!mtype) {
      if (eid >= 704643328 && eid < 704643584) mtype = 'production';
      else if (eid >= 704643584 && eid < 704643840) mtype = 'total-consumption';
      else mtype = 'net-consumption';
    }

    if (mtype === 'production') {
      solarW = activePower;
      // Capture lifetime energy accumulator for daily production tracking
      if (meter.actEnergyDlvd != null) solarActEnergyDlvdWh = meter.actEnergyDlvd;
    } else if (mtype === 'total-consumption' || mtype === 'consumption') {
      consumptionW = activePower;
    } else if (mtype === 'net-consumption' || mtype === 'net') {
      gridW = activePower; // positive = importing from grid, negative = exporting
    }
  }

  if (gridW === null) gridW = 0;

  // When the system only has production + net-consumption CTs (no total-consumption CT),
  // derive house load: total = solar + net  (net negative = exporting surplus)
  if (consumptionW === 0 && (solarW > 0 || gridW !== 0)) {
    consumptionW = Math.max(0, solarW + gridW);
  }

  // When net meter is absent, estimate from what we do have
  if (gridW === 0 && (solarW > 0 || consumptionW > 0)) {
    gridW = consumptionW - solarW;
  }

  return {
    solarW: Math.max(0, solarW),
    consumptionW: Math.max(0, consumptionW),
    gridW,
    solarActEnergyDlvdWh, // null if not available; used for accurate daily total tracking
    timestamp: Date.now(),
  };
}

/**
 * Fetch today's production totals from the Enphase IQ Gateway's own energy
 * accumulator - the same source Enphase Enlighten uses.
 * Returns: { whToday, whLifetime, whLastSevenDays }
 *
 * Uses GET /api/v1/production which is available on all IQ Gateway firmware
 * versions that support local API access.
 */
async function fetchProductionTotals(gatewayIp, jwt) {
  const url = `https://${gatewayIp}/api/v1/production`;
  const res = await httpFetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    timeout: 10000,
  });

  if (res.status === 401) {
    const err = new Error('Enphase JWT expired or invalid');
    err.code = 'ENPHASE_JWT_EXPIRED';
    throw err;
  }

  if (res.status !== 200) {
    throw new Error(`Enphase /api/v1/production returned status ${res.status}`);
  }

  let data;
  try { data = JSON.parse(res.body); } catch (_err) {
    throw new Error('Enphase /api/v1/production returned non-JSON');
  }

  // Find the EIM (energy meter) entry - it carries whToday / whLifetime
  const production = Array.isArray(data.production) ? data.production : [];
  const eim = production.find(p => p.type === 'eim') || production[0] || {};

  return {
    whToday:         eim.whToday          || 0,
    whLifetime:      eim.whLifetime       || 0,
    whLastSevenDays: eim.whLastSevenDays  || 0,
    wattsNow:        eim.wNow             || 0,
  };
}

/**
 * Test gateway connection by fetching /info.
 */
async function testGatewayConnection(gatewayIp, jwt) {
  const url = `https://${gatewayIp}/info`;
  const headers = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  const res = await httpFetch(url, { headers, timeout: 10000 });

  if (res.status !== 200) {
    throw new Error(`Gateway /info returned status ${res.status}`);
  }

  // /info returns XML
  const body = res.body;
  const serialMatch = body.match(/<sn>(.*?)<\/sn>/);
  const firmwareMatch = body.match(/<software>(.*?)<\/software>/);

  return {
    serial: serialMatch ? serialMatch[1].trim() : 'unknown',
    firmware: firmwareMatch ? firmwareMatch[1].trim() : 'unknown',
  };
}

/**
 * Try to discover an Enphase gateway at envoy.local.
 * Returns the resolved IP or null.
 */
async function discoverGateway() {
  try {
    const res = await httpFetch('https://envoy.local/info', { timeout: 5000 });
    if (res.status === 200) {
      return 'envoy.local';
    }
  } catch (_err) {
    // Not found
  }
  return null;
}

module.exports = {
  generateGatewayToken,
  fetchMeterReadings,
  fetchProductionTotals,
  testGatewayConnection,
  discoverGateway,
};
