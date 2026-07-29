/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Drives the BLE state-source path (tesla.js reads + controller._blePollState/_checkAtHome)
// against a fake TeslaBleHttpProxy. Runs against a throwaway DB, never the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-blestate-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const tesla = require('../src/services/tesla');
const telemetry = require('../src/services/telemetry');
const controller = require('../src/controller');

// Fake proxy whose responses each test can set.
let bodyResp = { code: 200, body: JSON.stringify({ response: { vehicleSleepStatus: 'VEHICLE_SLEEP_STATUS_AWAKE' } }) };
let dataResp = { code: 200, body: JSON.stringify({ response: { charge_state: {
  charging_state: 'Charging', battery_level: 55, charge_limit_soc: 80, charge_amps: 16, charger_power: 11,
} } }) };

const server = http.createServer((req, res) => {
  const target = req.url.includes('body_controller_state') ? bodyResp : dataResp;
  res.writeHead(target.code, { 'Content-Type': 'application/json' });
  res.end(target.body);
});

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.setSetting('tesla_state_source', 'ble');
  db.setSetting('tesla_ble_proxy_url', base);
  db.setSetting('tesla_vin', 'VINTEST');
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('getVehicleDataBle parses charge_state from the Fleet-shaped response', async () => {
  const d = await tesla.getVehicleDataBle('VINTEST');
  assert.equal(d.chargingState, 'Charging');
  assert.equal(d.batteryPct, 55);
  assert.equal(d.chargeLimit, 80);
  assert.equal(d.chargeAmps, 16);
});

test('getVehicleDataBle throws when charge_state is absent (never feeds zeros)', async () => {
  const saved = dataResp;
  dataResp = { code: 200, body: JSON.stringify({ response: {} }) };
  await assert.rejects(() => tesla.getVehicleDataBle('VINTEST'), /no charge_state/);
  dataResp = saved;
});

test('getBodyStateBle reports awake vs asleep', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { vehicleSleepStatus: 'VEHICLE_SLEEP_STATUS_ASLEEP' } }) };
  assert.equal((await tesla.getBodyStateBle('VINTEST')).asleep, true);
  bodyResp = { code: 200, body: JSON.stringify({ response: { vehicleSleepStatus: 'VEHICLE_SLEEP_STATUS_AWAKE' } }) };
  assert.equal((await tesla.getBodyStateBle('VINTEST')).asleep, false);
});

test('_blePollState: awake car marks reachable, not sleeping, and updates telemetry', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { vehicleSleepStatus: 'VEHICLE_SLEEP_STATUS_AWAKE' } }) };
  controller._lastBleSleepCheckAt = 0;
  controller._lastBlePollAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true);
  assert.equal(controller._carSleeping, false);
  assert.equal(controller._checkAtHome(), true, 'reachable car reads as at home');
  const st = telemetry.getState();
  assert.equal(st.chargingState, 'Charging');
  assert.equal(st.batteryPct, 55);
});

test('_blePollState: asleep car is present (at home) but its state is not re-read', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { vehicleSleepStatus: 'VEHICLE_SLEEP_STATUS_ASLEEP' } }) };
  controller._lastBleSleepCheckAt = 0;
  controller._lastBlePollAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true, 'a sleeping car in range is still at home');
  assert.equal(controller._carSleeping, true);
  assert.equal(controller._checkAtHome(), true);
});

test('_blePollState: unreachable proxy means the car is away and control is suspended', async () => {
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1'); // nothing listening
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, false);
  assert.equal(controller._checkAtHome(), false, 'unreachable car reads as away');
  db.setSetting('tesla_ble_proxy_url', base); // restore for any later tests
});
