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

// Tesla runs the Fleet API from separate regional deployments, and an account
// registered in one region is not reachable through another - calls fail with
// errors that name neither the region nor the account, so a wrong base URL
// looks like a broken app rather than a misconfiguration.
//
// 'na' covers North America AND Asia-Pacific (including Australia), which is
// why this went unnoticed for so long: the two regions this project was built
// and tested in share one endpoint. Europe/Middle East/Africa and China each
// need their own.
const TESLA_REGIONS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn',
};
const DEFAULT_TESLA_REGION = 'na';

/**
 * Base URL for the Fleet API region this account belongs to.
 *
 * Read per call rather than captured at module load: the setting is chosen
 * during setup, which happens after this module is first required, and can be
 * changed later in Settings without restarting.
 */
function fleetBase() {
  const region = (db.getSetting('tesla_region') || DEFAULT_TESLA_REGION).toLowerCase();
  return TESLA_REGIONS[region] || TESLA_REGIONS[DEFAULT_TESLA_REGION];
}

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

// Tesla returns this specific 403 when the developer app itself has been rate-limited or
// suspended - not a single bad call, the whole account. Every caller here sits behind a
// poll loop with no backoff of its own, so without this a locked-out account gets hit again
// on the very next tick, forever, which only adds to whatever count got it locked out in the
// first place. Once seen, stop making real calls for a while and fail fast instead.
let _accountLockedUntil = 0;
const ACCOUNT_LOCK_BACKOFF_MS = 10 * 60 * 1000;

function _noteAccountLockIfPresent(body) {
  // BLE commands go straight to the car over Bluetooth and never touch Tesla's cloud
  // account, so a Fleet API lockout is meaningless to them - never arm the breaker for BLE.
  if (useBleCommands()) return;
  if (typeof body === 'string' && /account disabled|exceeded_limit/i.test(body)) {
    _accountLockedUntil = Date.now() + ACCOUNT_LOCK_BACKOFF_MS;
  }
}

function _assertAccountNotLocked() {
  if (useBleCommands()) return;
  if (Date.now() < _accountLockedUntil) {
    const secs = Math.round((_accountLockedUntil - Date.now()) / 1000);
    throw new Error(`Tesla account rate-limited (exceeded_limit) - backing off, retrying in ${secs}s`);
  }
}

// Vehicle-offline backoff. A charge command sent to a sleeping or away car returns 500
// "vehicle unavailable: vehicle is offline or asleep". The controller sits in a ~10s loop
// with no backoff of its own, so a single unreachable car draws hundreds of billed failed
// commands an hour - 3,891 in one night, observed 2026-09-02 - at $0.001 each. On that
// signal, fail charge commands fast for a short window instead of hammering. Wake is
// deliberately NOT gated by this (below): waking is exactly how you recover from offline,
// and the controller already rate-limits its own wake attempts. The thrown message still
// says "offline or asleep" so the controller's _wakeIfAsleep recovery still triggers.
let _vehicleOfflineUntil = 0;
const VEHICLE_OFFLINE_BACKOFF_MS = 3 * 60 * 1000;

function _noteVehicleOfflineIfPresent(body) {
  // BLE reachability is local (Bluetooth range), not a billed cloud call, so the cost
  // argument does not apply - let BLE surface its own unreachable errors immediately.
  if (useBleCommands()) return;
  if (typeof body === 'string' && /offline or asleep|vehicle unavailable/i.test(body)) {
    _vehicleOfflineUntil = Date.now() + VEHICLE_OFFLINE_BACKOFF_MS;
  }
}

function _assertVehicleNotBackingOff() {
  if (useBleCommands()) return;
  if (Date.now() < _vehicleOfflineUntil) {
    const secs = Math.round((_vehicleOfflineUntil - Date.now()) / 1000);
    throw new Error(`vehicle unavailable: offline or asleep - backing off, retrying in ${secs}s`);
  }
}

// Lift the offline backoff the instant something confirms the car is reachable again. The
// backoff exists only to stop hammering an unreachable car; once a read (or a wake) proves it
// is online, holding the lockout for the rest of the window just delays a charge that could
// start now. Without this, a wake-then-online sequence sits out the full backoff even though
// the car is ready (observed 2026-09-03: up to ~3 min late to start).
function _clearVehicleOfflineBackoff() {
  _vehicleOfflineUntil = 0;
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
    audience: fleetBase(),
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
  const res = await jsonFetch(`${fleetBase()}/api/1/partner_accounts`, {
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
  const res = await jsonFetch(`${fleetBase()}/api/1/vehicles`, {
    headers: authHeader(accessToken),
  });

  if (res.status !== 200) {
    // Keep the body: a 412 here is Tesla saying "account must be registered in the current
    // region <url>", which names the region the token actually belongs to. Swallowing it (as
    // this used to) turned a self-explaining error into a blind "status 412". See issue #17.
    throw new Error(`List vehicles failed with status ${res.status}: ${(res.body || '').slice(0, 300)}`);
  }

  const data = JSON.parse(res.body);
  return (data.response || []).map((v) => ({
    vin: v.vin,
    display_name: v.display_name,
    state: v.state,
  }));
}

/**
 * Ask Tesla which region this user's account actually lives in, and the base URL to use for it.
 * Returns { region, baseUrl } - region is our internal key ('na'|'eu'|'cn'), baseUrl is Tesla's
 * fleet_api_base_url. The region endpoint is answered from the token subject, but it must be
 * reached at *a* regional host: if the one we try is wrong, Tesla replies 412 with the correct
 * base URL in the body, so we parse that and believe it. This removes the hardcoded-'na'
 * assumption that made a wrong region look like a broken app (issue #17).
 */
// Pure parse of a /users/region reply. A 200 carries fleet_api_base_url in JSON; a 412 (or any
// body) may instead name the correct region URL in prose ("must be registered in <url>"), so we
// also scan for a fleet-api host. Returns { region, baseUrl } or null when nothing usable is
// found. Split out from the network call so the tricky cases are unit-testable without Tesla.
function parseRegionResponse(status, body) {
  let baseUrl = null;
  if (status === 200 && body) {
    try { baseUrl = (JSON.parse(body).response || {}).fleet_api_base_url || null; } catch (_e) { /* fall through */ }
  }
  if (!baseUrl && body) {
    const m = body.match(/https:\/\/fleet-api\.prd\.[a-z]{2}\.vn\.cloud\.tesla\.(?:com|cn)/i);
    if (m) baseUrl = m[0];
  }
  if (!baseUrl) return null;
  let region = DEFAULT_TESLA_REGION;
  for (const [key, url] of Object.entries(TESLA_REGIONS)) {
    if (baseUrl.startsWith(url)) { region = key; break; }
  }
  return { region, baseUrl };
}

async function getUserRegion(accessToken, tryBaseUrl) {
  const base = tryBaseUrl || fleetBase();
  const res = await jsonFetch(`${base}/api/1/users/region`, {
    headers: authHeader(accessToken),
  });
  const parsed = parseRegionResponse(res.status, res.body);
  if (!parsed) {
    throw new Error(`Region lookup failed with status ${res.status}: ${(res.body || '').slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Ask Tesla what public key it actually has registered for a domain. Returns the hex key
 * string, or null if Tesla has none. This is the check that turns "is my partner registration
 * really there?" from a manual curl (issue #17) into something the app can run itself.
 */
async function getRegisteredPublicKey(partnerToken, domain) {
  const res = await jsonFetch(
    `${fleetBase()}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(domain)}`,
    { headers: authHeader(partnerToken) },
  );
  if (res.status !== 200) return null;
  try { return (JSON.parse(res.body).response || {}).public_key || null; } catch (_e) { return null; }
}

/**
 * Get the cloud-reported state of a single vehicle ('online', 'asleep', 'offline').
 */
async function getVehicleState(vin, accessToken) {
  _assertAccountNotLocked();
  const res = await jsonFetch(`${fleetBase()}/api/1/vehicles`, {
    headers: authHeader(accessToken),
  });
  _noteAccountLockIfPresent(res.body);
  if (res.status !== 200) throw new Error(`List vehicles failed with status ${res.status}: ${(res.body || '').slice(0, 300)}`);
  const data = JSON.parse(res.body);
  const vehicle = (data.response || []).find((v) => v.vin === vin);
  const state = vehicle ? vehicle.state : null;
  if (state === 'online') _clearVehicleOfflineBackoff(); // reachable again - stop backing off
  return state;
}

/**
 * Get vehicle data: charge_state + drive_state (for GPS / geofencing).
 * Returns { chargeState, driveState } - either may be null.
 */
async function getVehicleData(vin, accessToken) {
  _assertAccountNotLocked();
  const res = await jsonFetch(
    `${fleetBase()}/api/1/vehicles/${vin}/vehicle_data`,
    { headers: authHeader(accessToken) }
  );
  _noteAccountLockIfPresent(res.body);

  if (res.status !== 200) {
    throw new Error(`Get vehicle data failed with status ${res.status}: ${res.body.slice(0, 200)}`);
  }

  // A 200 from vehicle_data means the car answered - it is reachable, so lift any backoff.
  _clearVehicleOfflineBackoff();
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
  _assertAccountNotLocked();
  const url = useBleCommands()
    ? `${commandBaseUrl()}/api/1/vehicles/${vin}/command/wake_up`
    : `${fleetBase()}/api/1/vehicles/${vin}/wake_up`;

  const res = await jsonFetch(url, {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body: '{}',
  });
  _noteAccountLockIfPresent(res.body);

  if (res.status !== 200) {
    throw new Error(`Wake vehicle failed with status ${res.status}`);
  }

  try { return JSON.parse(res.body); } catch (_e) { return { ok: true }; }
}

/**
 * Set charging amps via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function setChargingAmps(vin, amps, accessToken) {
  _assertAccountNotLocked();
  _assertVehicleNotBackingOff();
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
  _noteAccountLockIfPresent(res.body);
  _noteVehicleOfflineIfPresent(res.body);

  return assertCommandOk(res, 'Set charging amps');
}

/**
 * Start charging via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function startCharging(vin, accessToken) {
  _assertAccountNotLocked();
  _assertVehicleNotBackingOff();
  const res = await jsonFetch(commandUrl(vin, 'charge_start'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body: '{}',
  });
  _noteAccountLockIfPresent(res.body);
  _noteVehicleOfflineIfPresent(res.body);

  return assertCommandOk(res, 'Start charging', ['already_started']);
}

/**
 * Set the charge limit via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function setChargeLimit(vin, limitPercent, accessToken) {
  _assertAccountNotLocked();
  _assertVehicleNotBackingOff();
  // Same string-vs-integer reasoning as set_charging_amps.
  const body = useBleCommands()
    ? JSON.stringify({ percent: String(limitPercent) })
    : JSON.stringify({ percent: limitPercent });
  const res = await jsonFetch(commandUrl(vin, 'set_charge_limit'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body,
  });
  _noteAccountLockIfPresent(res.body);
  _noteVehicleOfflineIfPresent(res.body);

  if (res.status !== 200) {
    throw new Error(`Set charge limit failed with status ${res.status}: ${res.body}`);
  }

  try { return JSON.parse(res.body); } catch (_e) { return { ok: true }; }
}

/**
 * Stop charging via the active command backend (local Fleet-signing proxy, or BLE).
 */
async function stopCharging(vin, accessToken) {
  _assertAccountNotLocked();
  // NOTE: stop is intentionally still subject to the offline backoff. A stop command to an
  // offline/asleep car is a no-op anyway (a sleeping car is not charging), so there is nothing
  // to lose by deferring it, and it keeps the storm shut. A real user STOP press that lands
  // during a backoff window surfaces the "offline or asleep" message, which is accurate.
  _assertVehicleNotBackingOff();
  const res = await jsonFetch(commandUrl(vin, 'charge_stop'), {
    method: 'POST',
    headers: commandHeaders(accessToken),
    body: '{}',
  });
  _noteAccountLockIfPresent(res.body);
  _noteVehicleOfflineIfPresent(res.body);

  return assertCommandOk(res, 'Stop charging', ['not_charging']);
}

// wimaha/tesla-ble-http-proxy wraps every response in one outer envelope -
// {response: {result, reason, vin, command, response?: <payload>}} - and read commands
// (vehicle_data, body_controller_state) carry the actual payload a SECOND level deeper, under
// another nested "response" key; write commands (wake_up, charge_start, ...) have no second
// layer at all, since there's no data to return. getVehicleDataBle and getBodyStateBle both
// used to unwrap only the outer envelope, landing one level short of the real payload for both
// read endpoints - every poll "succeeded" at the HTTP layer but the parsed fields were always
// missing, either throwing "no charge_state" (silently swallowed by the caller's catch) or,
// worse, silently reading an empty sleep status forever. Confirmed live 2026-09-09: WattSnatch's
// persisted vehicle state had not updated in 4+ days despite the proxy answering correctly on
// every direct call. Unwrap defensively (peel the second layer only if present) rather than
// assume a fixed depth, so this keeps working if a future proxy version changes the envelope.
function _unwrapBleProxyPayload(parsed) {
  const envelope = parsed.response || parsed;
  return envelope.response || envelope;
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
  const cs = _unwrapBleProxyPayload(parsed).charge_state || null;
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
  const body = _unwrapBleProxyPayload(parsed);
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
  fleetBase,
  TESLA_REGIONS,
  clearVehicleOfflineBackoff: _clearVehicleOfflineBackoff,
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getPartnerToken,
  registerPartnerAccount,
  getUserRegion,
  parseRegionResponse,
  getRegisteredPublicKey,
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
