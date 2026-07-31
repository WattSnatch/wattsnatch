/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Mitsubishi Electric "Wi-Fi Control" adapter integration - AU/NZ only. This is
// a genuinely different platform from MELCloud (melcloud.js): same manufacturer,
// but a separate regional cloud service at api.melview.net, with its own
// account system - MELCloud credentials do NOT work here and vice versa.
//
// Protocol (cookie-based session, not a bearer token) adapted from
// jz-v/ha-melview (MIT licensed - see THIRD_PARTY_LICENSES.md), which itself
// documents being forked from earlier WTFPL-licensed reverse-engineering work.
// Not vendored or executed - only the endpoint shapes and request/response
// fields were read and reimplemented against WattSnatch's own AC provider
// contract (see ac.js).
//
// Important limitation, unlike MELCloud: the MelView API has no energy/power
// consumption field anywhere (confirmed by reading the full reference
// integration's response handling) - only on/off state, mode, set/room
// temperature, and fan speed. daily_energy_kwh/total_energy_kwh are always
// null here, so acLoadW on the dashboard will never show a value for a
// MelView-configured AC, unlike MELCloud's rough daily-average estimate.

const https = require('https');
const keytar = require('keytar');
const db = require('../db');
const logger = require('../utils/logger');

const SERVICE_NAME = 'WattSnatch';
const BASE_HOST = 'api.melview.net';
const APP_VERSION = '6.5.2090';
const API_VERSION = 3;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';

// Device status/setmode field -> WattSnatch's normalized mode string.
// Values taken from jz-v/ha-melview's MODE mapping.
const MODE = { 1: 'Heat', 2: 'Dry', 3: 'Cool', 7: 'Fan', 8: 'Auto' };

let _state = { devices: [], ok: false, lastUpdated: null };
let _interval = null;
let _authCookie = null;

async function getCredentials() {
  try {
    const email = await keytar.getPassword(SERVICE_NAME, 'melview_email');
    const password = await keytar.getPassword(SERVICE_NAME, 'melview_password');
    return { email, password };
  } catch (err) {
    logger.logEvent('warn', `keytar read failed for melview: ${err.message}`);
    return { email: null, password: null };
  }
}

async function setCredentials(email, password) {
  try {
    if (email)    await keytar.setPassword(SERVICE_NAME, 'melview_email', email);
    if (password) await keytar.setPassword(SERVICE_NAME, 'melview_password', password);
  } catch (err) {
    logger.logEvent('warn', `keytar write failed for melview: ${err.message}`);
    throw err;
  }
}

function _request(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': USER_AGENT,
    };
    if (_authCookie) headers.Cookie = `auth=${_authCookie}`;

    const req = https.request({
      hostname: BASE_HOST,
      path: `/api/${path}`,
      method: 'POST',
      headers,
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_e) { /* some endpoints return empty body */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MelView request timed out')); });
    req.write(payload);
    req.end();
  });
}

// Parses the auth cookie out of a login response's Set-Cookie header(s).
function _extractAuthCookie(setCookieHeaders) {
  if (!setCookieHeaders) return null;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const line of list) {
    const m = /(?:^|;\s*)auth=([^;]+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

async function login() {
  const { email, password } = await getCredentials();
  if (!email || !password) throw new Error('MelView credentials not configured');

  const res = await _request('login.aspx', { user: email, pass: password, appversion: APP_VERSION });
  if (res.status !== 200) throw new Error(`MelView login failed with status ${res.status}`);

  const cookie = _extractAuthCookie(res.headers['set-cookie']);
  if (!cookie) throw new Error('MelView login rejected - check your email/password (this is the AU/NZ "Wi-Fi Control" account, not MELCloud)');

  _authCookie = cookie;
  return cookie;
}

async function _authedRequest(path, body, retried) {
  if (!_authCookie) await login();
  const res = await _request(path, body);
  if (res.status === 401 && !retried) {
    _authCookie = null;
    await login();
    return _authedRequest(path, body, true);
  }
  if (res.status !== 200) throw new Error(`MelView request to ${path} failed with status ${res.status}`);
  return res.json;
}

async function fetchDevices() {
  const rooms = await _authedRequest('rooms.aspx', { unitid: 0 });
  if (!Array.isArray(rooms)) throw new Error('MelView returned an unexpected device list shape');

  const devices = [];
  for (const building of rooms) {
    for (const unit of building.units || []) {
      const info = await _authedRequest('unitcommand.aspx', { unitid: unit.unitid, v: API_VERSION });
      if (info && info.fault === 'COMM') {
        // Adapter is registered but not currently reachable by the MelView
        // server (Wi-Fi/internet down on the adapter itself) - skip rather
        // than reporting a wrong state for a device that just isn't home.
        continue;
      }
      devices.push({
        device_id: unit.unitid,
        name: unit.room || `Unit ${unit.unitid}`,
        is_on: !!(info && info.power),
        mode: info && MODE[info.setmode] ? MODE[info.setmode] : 'Unknown',
        set_temperature: info ? info.settemp : null,
        room_temperature: info ? info.roomtemp : null,
        // MelView's API has no energy/power consumption field at all (see
        // module header) - always null/0 here, unlike MELCloud's estimate.
        daily_energy_kwh: null,
        total_energy_kwh: null,
      });
    }
  }
  return devices;
}

function getState() {
  return { ..._state };
}

function isConfigured() {
  return db.getSetting('melview_configured') === '1';
}

async function poll() {
  try {
    const devices = await fetchDevices();
    _state = { devices, ok: true, lastUpdated: Date.now() };

    for (const device of devices) {
      db.insertAcTelemetry({
        recorded_at: Date.now(),
        device_id: device.device_id,
        device_name: device.name,
        is_on: device.is_on ? 1 : 0,
        mode: device.mode,
        set_temperature: device.set_temperature,
        room_temperature: device.room_temperature,
        daily_energy_kwh: device.daily_energy_kwh,
        total_energy_kwh: device.total_energy_kwh,
      });
    }
  } catch (err) {
    _state = { ..._state, ok: false, lastUpdated: Date.now() };
    logger.logEvent('api_error', `melview poll failed: ${err.message}`);
  }
}

/** Used by the setup route to validate credentials synchronously before saving. */
async function testConnection() {
  try {
    _authCookie = null;
    await login();
    const devices = await fetchDevices();
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function start() {
  if (!isConfigured()) {
    logger.logEvent('info', 'melview: not configured - skipping start');
    return;
  }

  // MelView's own adapters check in with the server roughly every 30s
  // (per jz-v/ha-melview's 30s info-cache lease) - matching that rather than
  // polling faster, since anything shorter just re-reads the same cache.
  const pollSecs = 30;
  const pollMs = pollSecs * 1000;

  logger.logEvent('info', `melview: starting poll every ${pollSecs}s`);

  poll().catch(() => {});
  _interval = setInterval(() => poll().catch(() => {}), pollMs);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  _authCookie = null;
}

function restart() {
  stop();
  start();
}

module.exports = {
  start,
  stop,
  restart,
  getState,
  isConfigured,
  setCredentials,
  testConnection,
};
