/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Fleet Telemetry for vehicle state, Bluetooth LE for commands.
//
// That mix is the best of both: the car streams state and GPS live, so Home Assistant sees
// it arrive or leave within seconds, while every command goes over the local proxy for free.
// But the controller also makes direct reads of its own (a background refresh when the
// stream is quiet, a phantom-charge confirmation, a limit check before stopping), and those
// only went over Bluetooth in full BLE state mode. In the mixed setup they quietly went to
// Tesla's metered vehicle_data endpoint instead, the same pattern behind the September 2026
// account lockout.
//
// Pinned here:
//   - with BLE commands, every direct read goes over Bluetooth, never the cloud
//   - the background refresh never blocks the loop (presence is published from that loop,
//     and an out-of-range BLE read takes ~35s to fail)
//   - it checks the wake-free body state first and never latches _carSleeping
//   - free BLE commands and wakes are no longer counted as metered API calls
// Runs against a throwaway DB and a fake proxy, never the real ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-mixedble-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const logger = require('../src/utils/logger');
const telemetry = require('../src/services/telemetry');
const controller = require('../src/controller');

const envelope = (command, payload) => JSON.stringify({ response: { result: true, reason: 'ok',
  vin: 'VINTEST', command, response: payload } });

let sleepStatus = 'VEHICLE_SLEEP_STATUS_AWAKE';
let chargeState = { charging_state: 'Charging', battery_level: 61, charge_limit_soc: 85,
  charge_amps: 12, charger_power: 8 };
let delayMs = 0;
let requests = [];

const server = http.createServer((req, res) => {
  requests.push(req.url);
  const isBody = req.url.includes('body_controller_state');
  const body = isBody
    ? envelope('body-controller-state', { vehicle_sleep_status: sleepStatus })
    : envelope('vehicle_data', { charge_state: chargeState });
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  }, delayMs);
});

// Wait for the fire-and-forget refresh to finish.
async function settle() {
  for (let i = 0; i < 200 && controller._bleRefreshInFlight; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(controller._bleRefreshInFlight, false, 'refresh must finish and clear its in-flight flag');
}

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  db.setSetting('tesla_ble_proxy_url', `http://127.0.0.1:${server.address().port}`);
  db.setSetting('tesla_vin', 'VINTEST');
  db.setSetting('tesla_state_source', 'telemetry');
  db.setSetting('tesla_command_backend', 'ble');
});

test.beforeEach(() => {
  requests = [];
  delayMs = 0;
  sleepStatus = 'VEHICLE_SLEEP_STATUS_AWAKE';
  chargeState = { charging_state: 'Charging', battery_level: 61, charge_limit_soc: 85,
    charge_amps: 12, charger_power: 8 };
  db.setSetting('tesla_state_source', 'telemetry');
  db.setSetting('tesla_command_backend', 'ble');
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('direct reads go over Bluetooth whenever commands do, or state does', () => {
  const cases = [
    ['telemetry', 'ble',   true],   // the mixed setup this exists for
    ['ble',       'ble',   true],   // fully local
    ['ble',       'fleet', true],   // BLE state with cloud commands, unchanged
    ['telemetry', 'fleet', false],  // all cloud, unchanged
  ];
  for (const [source, backend, expected] of cases) {
    db.setSetting('tesla_state_source', source);
    db.setSetting('tesla_command_backend', backend);
    assert.equal(controller._directReadsOverBle(), expected, `${source} state + ${backend} commands`);
  }
});

test('free BLE commands and wakes are not counted as metered calls; real cloud calls still are', () => {
  const logged = [];
  const orig = logger.logEvent;
  logger.logEvent = (type, msg) => { if (type === 'api_cost') logged.push(msg); };
  try {
    db.setSetting('tesla_command_backend', 'ble');
    controller._trackApiCall('command');
    controller._trackApiCall('wake');
    controller._trackApiCall('data');
    assert.deepEqual(logged, ['data'], 'with BLE commands only a genuine cloud data call is counted');

    logged.length = 0;
    db.setSetting('tesla_command_backend', 'fleet');
    controller._trackApiCall('command');
    controller._trackApiCall('wake');
    controller._trackApiCall('data');
    assert.deepEqual(logged, ['command', 'wake', 'data'], 'Fleet API commands are still counted');
  } finally {
    logger.logEvent = orig;
  }
});

test('background refresh returns immediately even when the proxy is slow', async () => {
  delayMs = 400;
  const started = Date.now();
  const ret = controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  const elapsed = Date.now() - started;
  assert.equal(ret, undefined, 'must not hand the loop a promise to await');
  assert.ok(elapsed < 50, `must not block the control loop (took ${elapsed}ms)`);
  assert.equal(controller._bleRefreshInFlight, true);
  await settle();
});

test('only one refresh in flight at a time', async () => {
  delayMs = 150;
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  await settle();
  assert.equal(requests.filter((u) => u.includes('body_controller_state')).length, 1,
    'overlapping calls must not stack up reads against the proxy');
});

test('awake car: state is read over Bluetooth and fed into the cache', async () => {
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  await settle();
  assert.ok(requests[0].includes('body_controller_state'), 'wake-free body check comes first');
  assert.ok(requests.some((u) => u.includes('vehicle_data')));
  const s = telemetry.getState();
  assert.equal(s.chargingState, 'Charging');
  assert.equal(s.batteryPct, 61);
  assert.equal(s.chargeLimit, 85);
});

test('asleep car: no data read, and _carSleeping is not latched', async () => {
  sleepStatus = 'VEHICLE_SLEEP_STATUS_ASLEEP';
  controller._carSleeping = false;
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  await settle();
  assert.equal(requests.filter((u) => u.includes('vehicle_data')).length, 0,
    'a sleeping car must not be asked for vehicle data');
  assert.equal(controller._carSleeping, false,
    'telemetry owns the sleep signal in this mode; a local read must not latch it');
});

test('limit-only refresh takes the limit and nothing else', async () => {
  telemetry.updateFromApi({ chargingState: 'Stopped', batteryPct: 70, chargeLimit: 80 });
  chargeState = { charging_state: 'Charging', battery_level: 40, charge_limit_soc: 90,
    charge_amps: 16, charger_power: 11 };
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: true });
  await settle();
  const s = telemetry.getState();
  assert.equal(s.chargeLimit, 90, 'limit refreshed');
  assert.equal(s.batteryPct, 70, 'battery left to the live stream');
  assert.equal(s.chargingState, 'Stopped', 'charging state left to the live stream');
});

test('an unplugged car\'s limit is not trusted (it can report the 50% floor)', async () => {
  telemetry.updateFromApi({ chargeLimit: 80 });
  chargeState = { charging_state: 'Disconnected', battery_level: 66, charge_limit_soc: 50 };
  controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
  await settle();
  const s = telemetry.getState();
  assert.equal(s.chargeLimit, 80, 'kept the last confirmed limit');
  assert.equal(s.chargingState, 'Disconnected', 'the rest of the snapshot is still taken');
});

test('a failed read clears the in-flight flag so the next window can retry', async () => {
  const origUrl = db.getSetting('tesla_ble_proxy_url');
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  try {
    controller._bleBackgroundRefresh('VINTEST', { limitOnly: false });
    await settle();
  } finally {
    db.setSetting('tesla_ble_proxy_url', origUrl);
  }
});

// Wiring inside the control loop. These run in a 5s loop against live hardware, so they are
// pinned at source level rather than by spinning the whole loop up.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the cloud fallback is skipped whenever the Bluetooth refresh applies', () => {
  assert.match(code, /const bleFallback = stateSource !== 'ble' && this\._directReadsOverBle\(\);/);
  assert.match(code, /const needsFallback = stateSource !== 'ble' && !bleFallback && /,
    'the metered REST fallback must not run in the mixed setup');
});

test('the Bluetooth refresh is gated on home, the rate floor, and excludes location', () => {
  const start = code.indexOf('if (bleFallback) {');
  const end = code.indexOf('const needsFallback =', start);
  assert.ok(start > 0 && end > start, 'block found');
  const block = code.slice(start, end);
  assert.match(block, /this\._checkAtHome\(\)/, 'skipped while the geofence says away');
  assert.match(block, /FALLBACK_INTERVAL/, 'shares the fallback rate floor');
  assert.doesNotMatch(block, /locationStale/, 'BLE has no GPS; location must not trigger it');
  assert.doesNotMatch(block, /await /, 'must not block the loop');
  assert.doesNotMatch(block, /getVehicleData\(|getVehicleState\(/, 'no cloud reads');
});

test('the phantom probe asks over Bluetooth first, only when home, before any cloud path', () => {
  const start = code.indexOf('let restConfirmsCharging = false;');
  const end = code.indexOf('if (!restConfirmsCharging)', start);
  const block = code.slice(start, end);
  const bleAt = block.indexOf('this._directReadsOverBle()');
  const cloudAt = block.indexOf('getVehicleData(vin, teslaToken)');
  assert.ok(bleAt > 0 && cloudAt > bleAt, 'BLE branch precedes the cloud branch');
  assert.match(block.slice(bleAt, cloudAt), /if \(this\._isAtHome\)[\s\S]*getVehicleDataBle\(vin\)/);
  assert.match(block.slice(bleAt, cloudAt), /\} else if \(vin && teslaToken\) \{/,
    'the cloud read is only the alternative, never both');
});

test('the stop-time limit check uses the same rule', () => {
  assert.match(code, /const verifyOverBle = this\._directReadsOverBle\(\);/);
});
