/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');

const TESLA_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const TESLA_AUTH = 'https://auth.tesla.com';
const PROXY_URL = process.env.TESLA_PROXY_URL || 'https://localhost:4443';
const DEFAULT_BLE_PROXY_URL = 'http://localhost:8080';

const proxyAgent = new https.Agent({ rejectUnauthorized: false });

// Which local backend vehicle commands (charge start/stop/amps/limit, wake) are sent through.
// 'fleet' (default) - existing tesla-http-proxy, signs commands and relays via Tesla's cloud API.
// 'ble'             - TeslaBleHttpProxy, talks to the car directly over Bluetooth LE, no cloud hop.
// Vehicle *state* (Fleet Telemetry) is completely separate and unaffected by this setting.
function useBleCommands() {
  return db.getSetting('tesla_command_backend') === 'ble';
}

function bleProxyUrl() {
  return db.getSetting('tesla_ble_proxy_url') || DEFAULT_BLE_PROXY_URL;
}

function commandBaseUrl() {
  return useBleCommands() ? bleProxyUrl() : PROXY_URL;
}

function jsonFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isProxy = url.startsWith(PROXY_URL);
    const isHttps = parsed.protocol === 'https:';
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WattSnatch/1.0',
        ...(options.headers || {}),
      },
      agent: isProxy ? proxyAgent : undefined,
      timeout: options.timeout || 20000,
    };

    const req = (isHttps ? https : http).request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Tesla API request timed out'));
    });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Build the Tesla OAuth2 authorization URL.
 */
function getAuthUrl(clientId, redirectUri, state) {
  const scopes = 'vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location offline_access';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: state || crypto.randomBytes(16).toString('hex'),
    prompt: 'consent',
  });
  return `${TESLA_AUTH}/oauth2/v3/authorize?${params.toString()}`;
}

/**
 * Get a partner (client credentials) token for partner_accounts registration.
 */
async function getPartnerToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'vehicle_cmds vehicle_charging_cmds',
    audience: TESLA_BASE,
  }).toString();

  const res = await jsonFetch(`${TESLA_AUTH}/oauth2/v3/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Partner token request failed with status ${res.status}: ${res.body}`);
  }

  return JSON.parse(res.body);
}

/**
 * Register the app domain with Tesla's Fleet API (required one-time before any API calls).
 */
async function registerPartnerAccount(partnerToken, domain) {
  const res = await jsonFetch(`${TESLA_BASE}/api/1/partner_accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${partnerToken}` },
    body: JSON.stringify({ domain }),
  });

  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`Partner account registration failed with status ${res.status}: ${res.body}`);
  }

  return true;
}

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(code, clientId, clientSecret, redirectUri) {
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const res = await jsonFetch(`${TESLA_AUTH}/oauth2/v3/token`, {
    method: 'POST',
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Tesla token exchange failed with status ${res.status}: ${res.body}`);
  }

  return JSON.parse(res.body);
}

/**
 * Refresh an expired access token.
 */
async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await jsonFetch(`${TESLA_AUTH}/oauth2/v3/token`, {
    method: 'POST',
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Tesla token refresh failed with status ${res.status}: ${res.body}`);
  }

  return JSON.parse(res.body);
}

/**
 * List vehicles associated with the account.
 */
async function listVehicles(accessToken) {
  const res = await jsonFetch(`${TESLA_BASE}/api/1/vehicles`, {
    headers: authHeader(accessToken),
  });

  if (res.status !== 200) {
    throw new Error(`List vehicles failed with status ${res.status}`);
  }

  const data = JSON.parse(res.body);
  return (data.response || []).map((v) => ({
    vin: v.vin,
    display_name: v.display_name,
    state: v.state,
  }));
}

/**
 * Get the cloud-reported state of a single vehicle ('online', 'asleep', 'offline').
 */
async function getVehicleState(vin, accessToken) {
  const res = await jsonFetch(`${TESLA_BASE}/api/1/vehicles`, {
    headers: authHeader(accessToken),
  });
  if (res.status !== 200) throw new Error(`List vehicles failed with status ${res.status}`);
  const data = JSON.parse(res.body);
  const vehicle = (data.response || []).find((v) => v.vin === vin);
  return vehicle ? vehicle.state : null;
}

/**
 * Get vehicle data: charge_state + drive_state (for GPS / geofencing).
 * Returns { chargeState, driveState } - either may be null.
 */
async function getVehicleData(vin, accessToken) {
  const res = await jsonFetch(
    `${TESLA_BASE}/api/1/vehicles/${vin}/vehicle_data`,
    { headers: authHeader(accessToken) }
  );

  if (res.status !== 200) {
    throw new Error(`Get vehicle data failed with status ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  const response = data.response || {};
  return {
    chargeState: response.charge_state || null,
    driveState: response.drive_state || null,
  };
}

// Commands sent through the BLE proxy need no bearer token (auth happens over BLE via the
// paired key); commands through the Fleet-signing proxy still need the Fleet accessToken.
function commandHeaders(accessToken) {
  return useBleCommands() ? {} : authHeader(accessToken);
}

// Build the command endpoint URL for the active backend. TeslaBleHttpProxy returns as soon
// as it has *queued* the command over BLE unless wait=true is set - without it a 200 means
// "sent", not "the car applied it", and the result check below can never see a failure that
// happens after the response. wait=true makes the proxy block until the command resolves.
// Unknown query params are ignored by proxy builds that predate it, so this stays safe.
function commandUrl(vin, command) {
  const base = `${commandBaseUrl()}/api/1/vehicles/${vin}/command/${command}`;
  return useBleCommands() ? `${base}?wait=true` : base;
}

// Uniformly validate a command response. A non-200 always throws. On 200 we read the
// Fleet-style {response:{result,reason}} body; a 200 with an empty or non-JSON body (which
// some proxy builds return on success) is treated as success rather than throwing on
// JSON.parse. okReasons lists non-error "false" results (e.g. already_started).
function assertCommandOk(res, label, okReasons = []) {
  if (res.status !== 200) {
    throw new Error(`${label} failed with status ${res.status}: ${res.body}`);
  }
  let parsed;
  try { parsed = JSON.parse(res.body); }
  catch (_e) { return { result: true, reason: '' }; }
  const result = parsed.response ?? parsed;
  if (result && result.result === false && !okReasons.includes(result.reason)) {
    throw new Error(`${label} rejected by car: ${result.reason || 'unknown reason'}`);
  }
  return parsed;
}

/**
 * Wake the vehicle. Goes via the BLE proxy's wake_up command when that backend is active
 * (BLE also auto-wakes on any command); otherwise unchanged - Tesla's cloud API directly.
 */
async function wakeVehicle(vin, accessToken) {
  const url = useBleCommands()
    ? `${commandBaseUrl()}/api/1/vehicles/${vin}/command/wake_up`
    : `${TESLA_BASE}/api/1/vehicles/${vin}/wake_up`;

  const res = await jsonFetch(url, {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body: '{}',
  });

  if (res.status !== 200) {
    throw new Error(`Wake vehicle failed with status ${res.status}`);
  }

  try { return JSON.parse(res.body); } catch (_e) { return { ok: true }; }
}

/**
 * Set charging amps via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function setChargingAmps(vin, amps, accessToken) {
  // TeslaBleHttpProxy's documented body uses a string value ({"charging_amps":"5"}); the
  // Fleet-signing proxy follows the Fleet API schema (integer). Send the right type per backend.
  const body = useBleCommands()
    ? JSON.stringify({ charging_amps: String(amps) })
    : JSON.stringify({ charging_amps: amps });
  const res = await jsonFetch(commandUrl(vin, 'set_charging_amps'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body,
  });

  return assertCommandOk(res, 'Set charging amps');
}

/**
 * Start charging via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function startCharging(vin, accessToken) {
  const res = await jsonFetch(commandUrl(vin, 'charge_start'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body: '{}',
  });

  return assertCommandOk(res, 'Start charging', ['already_started']);
}

/**
 * Set the charge limit via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function setChargeLimit(vin, limitPercent, accessToken) {
  // Same string-vs-integer reasoning as set_charging_amps.
  const body = useBleCommands()
    ? JSON.stringify({ percent: String(limitPercent) })
    : JSON.stringify({ percent: limitPercent });
  const res = await jsonFetch(commandUrl(vin, 'set_charge_limit'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Set charge limit failed with status ${res.status}: ${res.body}`);
  }

  try { return JSON.parse(res.body); } catch (_e) { return { ok: true }; }
}

/**
 * Stop charging via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function stopCharging(vin, accessToken) {
  const res = await jsonFetch(commandUrl(vin, 'charge_stop'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body: '{}',
  });

  return assertCommandOk(res, 'Stop charging', ['not_charging']);
}

/**
 * Read charge state from the vehicle over BLE (TeslaBleHttpProxy's vehicle_data endpoint,
 * charge_state only). Returned in the same shape the controller feeds telemetry.updateFromApi.
 * Does NOT pass wakeup=true, so it never wakes a sleeping car. Missing fields come back as
 * undefined (so updateFromApi leaves the previous value untouched) but a completely absent
 * charge_state throws - we must never silently feed zeros into charging decisions.
 */
async function getVehicleDataBle(vin) {
  const res = await jsonFetch(
    `${bleProxyUrl()}/api/1/vehicles/${vin}/vehicle_data?endpoints=charge_state`,
    { method: 'GET', headers: {}, timeout: 20000 },
  );
  if (res.status !== 200) {
    throw new Error(`BLE vehicle_data failed with status ${res.status}: ${res.body}`);
  }
  let parsed;
  try { parsed = JSON.parse(res.body); }
  catch (_e) { throw new Error('BLE vehicle_data returned a non-JSON body'); }
  const cs = (parsed.response && parsed.response.charge_state) || parsed.charge_state || null;
  if (!cs) throw new Error('BLE vehicle_data response had no charge_state');
  return {
    chargingState:  cs.charging_state,
    batteryPct:     cs.battery_level,
    chargeLimit:    cs.charge_limit_soc,
    chargeAmps:     cs.charge_amps ?? cs.charging_amps,
    chargerPowerKw: cs.charger_power,
  };
}

/**
 * Read the body controller state over BLE. This is cheap and, crucially, never wakes the car,
 * so it is safe to poll: any 200 response means the car is in Bluetooth range (i.e. at home),
 * and the sleep field tells us whether it is awake. Sleep parsing is best-effort - reachability
 * is the load-bearing signal; if the sleep field is absent we assume awake (a vehicle_data read
 * still will not wake it).
 */
async function getBodyStateBle(vin) {
  const res = await jsonFetch(
    `${bleProxyUrl()}/api/1/vehicles/${vin}/body_controller_state`,
    { method: 'GET', headers: {}, timeout: 15000 },
  );
  if (res.status !== 200) {
    throw new Error(`BLE body_controller_state failed with status ${res.status}`);
  }
  let parsed;
  try { parsed = JSON.parse(res.body); }
  catch (_e) { throw new Error('BLE body_controller_state returned a non-JSON body'); }
  const body = parsed.response ?? parsed;
  const sleep = body.vehicleSleepStatus || body.vehicle_sleep_status || '';
  return { asleep: /ASLEEP/i.test(String(sleep)), raw: body };
}

/**
 * Check that the BLE command proxy is reachable, without sending any vehicle command.
 * A plain GET to the proxy root: any HTTP response (even 404) proves it's up and speaking
 * HTTP; a connection error means it isn't running or the URL is wrong. Never issues a
 * charge command, so it is always safe to call from the settings UI.
 */
function testBleConnection(baseUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(baseUrl || bleProxyUrl()); }
    catch (_e) { return resolve({ ok: false, error: 'Invalid URL' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return resolve({ ok: false, error: 'URL must start with http:// or https://' });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: '/',
      method: 'GET',
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out - is the proxy running at this URL?' }); });
    req.end();
  });
}

/**
 * Generate an EC P-256 key pair and save to keys/ directory.
 * Tesla Fleet API requires EC keys (prime256v1), not RSA.
 */
function generateKeyPair(appDir) {
  const keysDir = path.join(appDir, 'keys');
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
  });

  const privateKeyPath = path.join(keysDir, 'private.pem');
  const publicKeyPath = path.join(keysDir, 'public.pem');

  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

  return { publicKey, privateKey };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getPartnerToken,
  registerPartnerAccount,
  listVehicles,
  getVehicleState,
  getVehicleData,
  wakeVehicle,
  setChargingAmps,
  setChargeLimit,
  startCharging,
  stopCharging,
  generateKeyPair,
  // command-backend routing (exported for the controller's guard, the settings test
  // endpoint, and unit tests)
  useBleCommands,
  commandBaseUrl,
  commandHeaders,
  commandUrl,
  testBleConnection,
  getVehicleDataBle,
  getBodyStateBle,
};
