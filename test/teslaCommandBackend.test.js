/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Verifies the command-backend routing logic (Fleet vs. BLE): which base URL, which headers,
// and the wait=true query param. Runs against a throwaway SQLite file, never the real DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-ble-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const tesla = require('../src/services/tesla');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('defaults to the Fleet-signing proxy when no backend is set', () => {
  db.setSetting('tesla_command_backend', 'fleet');
  assert.equal(tesla.useBleCommands(), false);
  assert.match(tesla.commandBaseUrl(), /^https:\/\/localhost:4443$/);
});

test('Fleet mode sends the bearer token and no wait param', () => {
  db.setSetting('tesla_command_backend', 'fleet');
  assert.deepEqual(tesla.commandHeaders('abc123'), { Authorization: 'Bearer abc123' });
  const url = tesla.commandUrl('VIN1', 'charge_start');
  assert.equal(url, 'https://localhost:4443/api/1/vehicles/VIN1/command/charge_start');
  assert.ok(!url.includes('wait='));
});

test('BLE mode routes to the BLE proxy, sends no auth header, and waits for completion', () => {
  db.setSetting('tesla_command_backend', 'ble');
  db.setSetting('tesla_ble_proxy_url', 'http://localhost:8080');
  assert.equal(tesla.useBleCommands(), true);
  assert.equal(tesla.commandBaseUrl(), 'http://localhost:8080');
  // No bearer token: BLE authenticates over the paired key.
  assert.deepEqual(tesla.commandHeaders('abc123'), {});
  // wait=true so a 200 means the car applied the command, not just that it was queued.
  assert.equal(
    tesla.commandUrl('VIN1', 'set_charging_amps'),
    'http://localhost:8080/api/1/vehicles/VIN1/command/set_charging_amps?wait=true',
  );
});

test('BLE mode honours a custom proxy URL', () => {
  db.setSetting('tesla_command_backend', 'ble');
  db.setSetting('tesla_ble_proxy_url', 'http://192.0.2.10:9000');
  assert.equal(tesla.commandBaseUrl(), 'http://192.0.2.10:9000');
  assert.equal(
    tesla.commandUrl('VIN1', 'charge_stop'),
    'http://192.0.2.10:9000/api/1/vehicles/VIN1/command/charge_stop?wait=true',
  );
});

test('testBleConnection reports an unreachable proxy instead of throwing', async () => {
  // Port 1 is not listening; this must resolve with ok:false, never reject.
  const result = await tesla.testBleConnection('http://127.0.0.1:1');
  assert.equal(result.ok, false);
  assert.ok(result.error, 'an error string should be present');
});

test('testBleConnection rejects a malformed URL cleanly', async () => {
  const result = await tesla.testBleConnection('not-a-url');
  assert.equal(result.ok, false);
});
