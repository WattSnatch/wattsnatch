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
    const MelcloudAPI = require('melcloud-api');
    const client = new MelcloudAPI({ email, password });
    await client.login();
    return client;
  } catch (err) {
    logger.logEvent('api_error', `melcloud initialization failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetch all AC devices from MELCloud.
 */
async function fetchDevices() {
  if (!_client) {
    _client = await initializeClient();
  }

  if (!_client) {
    throw new Error('MELCloud client not initialized');
  }

  try {
    const buildings = await _client.getBuildings();
    const devices = [];

    for (const building of buildings) {
      const deviceList = building.devices || [];
      for (const device of deviceList) {
        devices.push({
          device_id: device.deviceID,
          name: device.deviceName || device.name || `Device ${device.deviceID}`,
          is_on: device.power === 1,
          mode: device.operationMode === 0 ? 'Cool' :
                device.operationMode === 1 ? 'Dry' :
                device.operationMode === 2 ? 'Fan' :
                device.operationMode === 3 ? 'Heat' :
                device.operationMode === 4 ? 'Auto' : 'Unknown',
          set_temperature: device.setTemperature,
          room_temperature: device.roomTemperature,
          daily_energy_kwh: (device.todayEnergyConsumption || 0) / 1000, // MELCloud returns in Wh
          total_energy_kwh: (device.energyConsumption || 0) / 1000,
        });
      }
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
};
