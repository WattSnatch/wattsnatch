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

// Fake proxy whose responses each test can set. Shaped exactly like the real
// wimaha/tesla-ble-http-proxy: one outer envelope ({response: {result, reason, vin, command,
// response: <payload>}}), with the actual data a SECOND level deeper under another nested
// "response" key. Confirmed live 2026-09-09 against a real proxy - the code used to unwrap only
// the outer layer, landing one level short, so every poll "succeeded" over HTTP while every
// field came back missing. These fixtures previously used a single-wrapped shape that matched
// the bug rather than reality, which is exactly how it went undetected - never revert to that.
let bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
  command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
let dataResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
  command: 'vehicle_data', response: { charge_state: {
  charging_state: 'Charging', battery_level: 55, charge_limit_soc: 80, charge_amps: 16, charger_power: 11,
} } } }) };

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
  dataResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'vehicle_data', response: {} } }) };
  await assert.rejects(() => tesla.getVehicleDataBle('VINTEST'), /no charge_state/);
  dataResp = saved;
});

test('getVehicleDataBle unwraps the real double envelope, not a single-wrapped guess', async () => {
  // Locks in the exact shape captured from a live proxy - the previous version of this fixture
  // (single-wrapped) matched the bug instead of reality and let it ship undetected.
  const saved = dataResp;
  dataResp = { code: 200, body: JSON.stringify({ response: { result: true,
    reason: 'The request was successfully processed.', vin: 'VINTEST', command: 'vehicle_data',
    response: { charge_state: { charging_state: 'Charging', battery_level: 45, charge_limit_soc: 80,
      charge_amps: 6, charger_power: 1 } } } }) };
  const d = await tesla.getVehicleDataBle('VINTEST');
  assert.equal(d.chargingState, 'Charging');
  assert.equal(d.batteryPct, 45);
  assert.equal(d.chargerPowerKw, 1);
  dataResp = saved;
});

test('getBodyStateBle reports awake vs asleep', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_ASLEEP' } } }) };
  assert.equal((await tesla.getBodyStateBle('VINTEST')).asleep, true);
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
  assert.equal((await tesla.getBodyStateBle('VINTEST')).asleep, false);
});

test('_blePollState: awake car marks reachable, not sleeping, and updates telemetry', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
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
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_ASLEEP' } } }) };
  controller._lastBleSleepCheckAt = 0;
  controller._lastBlePollAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true, 'a sleeping car in range is still at home');
  assert.equal(controller._carSleeping, true);
  assert.equal(controller._checkAtHome(), true);
});

test('_blePollState: a single missed check within the grace window keeps trusting the car is home', async () => {
  // Found live 2026-09-09: one dropped request between WattSnatch and the proxy (never even
  // reached the proxy's own logs) used to flip reachability to false immediately, which didn't
  // just flicker the dashboard - it issued a real charge_stop mid-session. This is the fix under
  // test: a lone miss right after a confirmed-reachable moment must not be trusted as "left."
  controller._lastBleReachableAt = Date.now(); // just confirmed reachable, as the prior tests did
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1'); // nothing listening - this call fails
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true, 'one miss inside the grace window must not flip to away');
  assert.equal(controller._checkAtHome(), true);
  db.setSetting('tesla_ble_proxy_url', base); // restore for any later tests
});

test('_blePollState: sustained failures past the grace window mean the car has genuinely left', async () => {
  // Same failing proxy, but the last confirmed-reachable moment is now well outside the grace
  // window - this is what a real departure (or a truly dead proxy) looks like, and it must still
  // be caught, not masked forever by the leniency above.
  controller._lastBleReachableAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1'); // nothing listening
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, false, 'a sustained run of failures must still be treated as away');
  assert.equal(controller._checkAtHome(), false, 'genuinely away after the grace window expires');
  db.setSetting('tesla_ble_proxy_url', base); // restore for any later tests
});

test('_blePollState: a fresh boot (never yet confirmed reachable) starts away, not home', async () => {
  // _lastBleReachableAt defaults to 0 - Date.now() - 0 is always far past the grace window, so a
  // process that has never once confirmed the car is present must not default to "home" on
  // unproven ground just because the grace-period math technically allows a large gap.
  controller._lastBleReachableAt = 0;
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, false);
  db.setSetting('tesla_ble_proxy_url', base);
});
