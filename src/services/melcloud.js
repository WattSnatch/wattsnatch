/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const keytar = require('keytar');
const db = require('../db');
const logger = require('../utils/logger');

const SERVICE_NAME = 'WattSnatch';
const ACCOUNT = 'melcloud_credentials';

// Module-level state
let _state = {
  devices: [],
  ok: false,
  lastUpdated: null,
};

let _interval = null;
let _client = null;

/**
 * Get MELCloud credentials from Keychain.
 * Falls back to empty if not set.
 */
async function getCredentials() {
  try {
    const email = await keytar.getPassword(SERVICE_NAME, 'melcloud_email');
    const password = await keytar.getPassword(SERVICE_NAME, 'melcloud_password');
    return { email, password };
  } catch (err) {
    logger.logEvent('warn', `keytar read failed for melcloud: ${err.message}`);
    return { email: null, password: null };
  }
}

/**
 * Store MELCloud credentials to Keychain.
 */
async function setCredentials(email, password) {
  try {
    if (email) {
      await keytar.setPassword(SERVICE_NAME, 'melcloud_email', email);
    }
    if (password) {
      await keytar.setPassword(SERVICE_NAME, 'melcloud_password', password);
    }
  } catch (err) {
    logger.logEvent('warn', `keytar write failed for melcloud: ${err.message}`);
    throw err;
  }
}

/**
 * Initialize MELCloud client if credentials are available.
 */
async function initializeClient() {
  const { email, password } = await getCredentials();

  if (!email || !password) {
    return null;
  }

  try {
    // melcloud-api's constructor takes (email, password) as two positional
    // arguments, not an options object - passing { email, password } here
    // silently assigns the whole object to `this.email` and leaves
    // `this.password` undefined, so every login attempt fails with
    // Unauthorized regardless of how correct the actual credentials are.
    const MelcloudAPI = require('melcloud-api');
    const client = new MelcloudAPI(email, password);
    await client.login();
    return client;
  } catch (err) {
    logger.logEvent('api_error', `melcloud initialization failed: ${err.message}`);
    return null;
  }
}

// melcloud-api's own _parseDeviceData() normalizes MELCloud's numeric
// OperationMode into a lowercase string - notably mapping "Cool" to the
// literal string 'cold' (a naming quirk in that library, not a typo here).
// Normalized to WattSnatch's existing Title-Case convention.
const MODE_MAP = { heat: 'Heat', dry: 'Dry', cold: 'Cool', fan: 'Fan', auto: 'Auto' };

/**
 * Fetch all AC devices from MELCloud.
 *
 * Corrected against melcloud-api's real API surface (v1.1.2) - the previous
 * version of this function called `_client.getBuildings()`, which does not
 * exist on this client at all (it only exposes `getDevices()` and the
 * `getAirConditioners()` convenience wrapper around it), and read energy
 * fields (`todayEnergyConsumption`/`energyConsumption`) that the library's
 * own device parser never produces. Both would have thrown/returned nothing
 * for every user, MELCloud login success or not - this was never actually
 * working, not just broken for one platform mismatch.
 */
async function fetchDevices() {
  if (!_client) {
    _client = await initializeClient();
  }

  if (!_client) {
    throw new Error('MELCloud client not initialized');
  }

  try {
    const units = await _client.getAirConditioners();
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, local report boundary per MELCloud's own report endpoint

    const devices = [];
    for (const unit of units) {
      let dailyEnergyKwh = null;
      try {
        // EnergyCost/Report's totalPowerConsumption is treated as kWh
        // directly here (not Wh, unlike the live device-state fields) -
        // consistent with how other MELCloud integrations interpret this
        // same endpoint, but not verified against a real account by this
        // project. Best-effort, same status as the rest of this provider.
        const report = await _client.getEnergyReport(unit.id, todayStr, todayStr, unit.buildingId);
        dailyEnergyKwh = report.totalPowerConsumption || 0;
      } catch (_e) {
        // Some device/account combinations don't expose energy reporting
        // (or the account has no history yet) - non-fatal, the dashboard's
        // acLoadW estimate degrades to 0 rather than blocking the whole poll.
      }

      devices.push({
        device_id: unit.id,
        name: unit.name || `Device ${unit.id}`,
        is_on: !!unit.power,
        mode: MODE_MAP[unit.mode] || 'Unknown',
        set_temperature: unit.temperature,
        room_temperature: unit.roomTemperature,
        daily_energy_kwh: dailyEnergyKwh,
        // No efficient lifetime-total field exists on this API without
        // fetching a report over the unit's entire history on every poll -
        // not worth the extra request; nothing in WattSnatch reads this
        // beyond storing it in ac_telemetry for reference.
        total_energy_kwh: null,
      });
    }

    return devices;
  } catch (err) {
    throw new Error(`MELCloud fetch failed: ${err.message}`);
  }
}

// Public API

function getState() {
  return { ..._state };
}

function isConfigured() {
  // Check if the settings sentinel is set (credentials are stored in Keychain)
  return db.getSetting('melcloud_configured') === '1';
}

async function poll() {
  try {
    const devices = await fetchDevices();
    _state = {
      devices,
      ok: true,
      lastUpdated: Date.now(),
    };

    // Store telemetry for each device
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
    logger.logEvent('api_error', `melcloud poll failed: ${err.message}`);
  }
}

/** Used by the setup route to validate credentials synchronously before saving. */
async function testConnection() {
  try {
    _client = null;
    const devices = await fetchDevices();
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function start() {
  if (!isConfigured()) {
    logger.logEvent('info', 'melcloud: not configured - skipping start');
    return;
  }

  const pollSecs = 60; // MELCloud rate limit requirement
  const pollMs = pollSecs * 1000;

  logger.logEvent('info', `melcloud: starting poll every ${pollSecs}s`);

  // Poll immediately, then on interval
  poll().catch(() => {});
  _interval = setInterval(() => poll().catch(() => {}), pollMs);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  _client = null;
}

function restart() {
  stop();
  start();
}

module.exports = {
  start,
  stop,
  restart,
  poll,
  getState,
  isConfigured,
  getCredentials,
  setCredentials,
  testConnection,
};
