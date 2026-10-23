/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Departure charging has to be able to go past the car's own charge limit, and must always put
// it back.
//
// Found 2026-10-23, the night before a long round trip. The overnight check scheduled a charge
// to 100% and the notification promised 100%, but departure charging only starts and stops the
// charge: the car stops itself at its own limit, 80%, and would have left about 7 kWh short of
// getting home.
//
// Pinned here: the limit is raised only inside the departure window and only when the target is
// above it; the owner's limit is read from the car and recorded before the raise; it is put back
// when the departure is over or the car is unplugged, retried until it lands, and survives a
// restart; local pairing warns instead of trying. Runs against a throwaway DB, commands stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-deplimit-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const charging = require('../src/services/charging');
const tesla = require('../src/services/tesla');
const telemetry = require('../src/services/telemetry');
const departureScheduler = require('../src/services/departureScheduler');
const dl = require('../src/services/departureLimit');

const HOUR = 3600e3;
const realNow = Date.now;
let clock;
let car;          // what the fake car reports
let writes;       // charge limits sent to the car
let failWrites;
const orig = {};

test.before(() => {
  orig.setChargeLimit = tesla.setChargeLimit;
  orig.getVehicleDataBle = charging.getVehicleDataBle;
  orig.getState = telemetry.getState;
  tesla.setChargeLimit = async (_vin, pct) => {
    if (failWrites) throw new Error('vehicle not in range');
    writes.push(pct); car.chargeLimit = pct;
  };
  charging.getVehicleDataBle = async () => ({ chargeLimit: car.chargeLimit, batteryPct: car.batteryPct, chargingState: car.chargingState });
  telemetry.getState = () => ({ ...orig.getState(), chargingState: car.chargingState, batteryPct: car.batteryPct,
    chargeLimit: car.cachedLimit ?? car.chargeLimit, latitude: null, longitude: null });
  db.setSetting('tesla_vin', '5YJ3E1EA0JF000001');
  db.setSetting('tesla_command_backend', 'ble');
  db.setSetting('tesla_pairing_mode', 'cloud');
});

test.beforeEach(() => {
  clock = realNow();
  Date.now = () => clock;
  car = { chargeLimit: 80, batteryPct: 65, chargingState: 'Stopped' };
  writes = [];
  failWrites = false;
  db.setSetting('departure_limit_baseline_pct', '');
  db.setSetting('departure_limit_raised_to_pct', '');
  db.setSetting('departure_limit_departure_time', '');
  db.setSetting('tesla_pairing_mode', 'cloud');
  departureScheduler.clearDeparture();
  dl._resetForTests();
});
test.afterEach(() => { Date.now = realNow; });
test.after(() => {
  Date.now = realNow;
  tesla.setChargeLimit = orig.setChargeLimit;
  charging.getVehicleDataBle = orig.getVehicleDataBle;
  telemetry.getState = orig.getState;
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true });
});

const depart = (hoursAhead, target) => departureScheduler.setDeparture(Date.now() + hoursAhead * HOUR, target, 'test trip');

// ── Decisions ───────────────────────────────────────────────────────────────────────────────

test('not raised before the departure window opens (more than 6 hours out)', async () => {
  depart(12, 100);
  const r = await dl.tick();
  assert.equal(r.action, 'none');
  assert.deepEqual(writes, []);
});

test('the reporter\'s morning: 100% target, 80% limit, inside the window -> raised to 100 and recorded', async () => {
  depart(5, 100);
  const r = await dl.tick();
  assert.equal(r.action, 'raise');
  assert.deepEqual(writes, [100]);
  const rec = dl.activeRaise();
  assert.equal(rec.baseline, 80, 'the owner\'s limit, to put back');
  assert.equal(rec.raisedTo, 100);
  assert.ok(Math.abs(rec.departureTime - (Date.now() + 5 * HOUR)) < 1000, 'tied to this departure');
});

test('a target the current limit already covers changes nothing', async () => {
  depart(5, 75);
  await dl.tick();
  assert.deepEqual(writes, []);
  assert.equal(dl.activeRaise(), null);
});

test('the owner\'s limit is read from the car, not from a stale cache', async () => {
  car.cachedLimit = 50;        // what a stale persisted value might say
  car.chargeLimit = 85;        // what the car actually has
  depart(5, 100);
  await dl.tick();
  assert.equal(dl.activeRaise().baseline, 85, 'the value to put back is the car\'s real setting');
});

test('raised to the target, not beyond it', async () => {
  depart(5, 92);
  await dl.tick();
  assert.deepEqual(writes, [92]);
});

test('an asleep car (no state) is not raised yet, and nothing is recorded', async () => {
  car.chargingState = null;
  depart(5, 100);
  const r = await dl.tick();
  assert.equal(r.action, 'none');
  assert.deepEqual(writes, []);
  assert.equal(dl.activeRaise(), null);
});

test('local pairing never tries, and warns once', async () => {
  db.setSetting('tesla_pairing_mode', 'local');
  depart(5, 100);
  const r1 = await dl.tick();
  const r2 = await dl.tick();
  assert.equal(r1.action, 'warn');
  assert.equal(r2.action, 'warn');
  assert.deepEqual(writes, []);
});

// ── Putting it back ─────────────────────────────────────────────────────────────────────────

test('put back once the target is reached and the departure is cleared', async () => {
  depart(5, 100);
  await dl.tick();
  car.batteryPct = 100; car.chargingState = 'Complete';
  departureScheduler.clearDeparture();           // what the controller does after stopping
  clock += 6 * 60e3;                             // past the retry spacing
  const r = await dl.tick();
  assert.equal(r.action, 'restore');
  assert.deepEqual(writes, [100, 80]);
  assert.equal(dl.activeRaise(), null);
});

test('put back when the departure time has passed', async () => {
  depart(5, 100);
  await dl.tick();
  clock += 6 * HOUR;
  await dl.tick();
  assert.deepEqual(writes, [100, 80]);
});

test('put back when the car is unplugged', async () => {
  depart(5, 100);
  await dl.tick();
  car.chargingState = 'Disconnected';
  clock += 6 * 60e3;
  await dl.tick();
  assert.deepEqual(writes, [100, 80]);
});

test('a failed restore keeps the record and is retried until it lands', async () => {
  depart(5, 100);
  await dl.tick();
  departureScheduler.clearDeparture();
  failWrites = true;
  clock += 6 * 60e3; await dl.tick();
  assert.ok(dl.activeRaise(), 'record kept after a failed restore');
  failWrites = false;
  clock += 6 * 60e3; await dl.tick();
  assert.deepEqual(writes, [100, 80]);
  assert.equal(dl.activeRaise(), null);
});

test('a raise recorded before a restart is still put back afterwards', async () => {
  // Simulate a previous process: record present, nothing in memory.
  db.setSetting('departure_limit_baseline_pct', '80');
  db.setSetting('departure_limit_raised_to_pct', '100');
  db.setSetting('departure_limit_departure_time', String(Date.now() - HOUR));
  car.chargeLimit = 100;
  await dl.tick();
  assert.deepEqual(writes, [80]);
});

test('a failed raise still leaves the record, so a write that did land is put back', async () => {
  depart(5, 100);
  failWrites = true;
  await dl.tick();
  assert.equal(dl.activeRaise().baseline, 80, 'baseline written before the command');
});

test('the raise is never re-sent every minute', async () => {
  depart(5, 100);
  for (let i = 0; i < 5; i++) { await dl.tick(); clock += 60e3; }
  assert.deepEqual(writes, [100]);
});

// ── Wording and wiring ──────────────────────────────────────────────────────────────────────

test('the overnight notification says what will happen to the limit', () => {
  db.setSetting('tesla_pairing_mode', 'cloud');
  assert.match(dl.limitNote(100, 80), /raised from 80% to 100% for this trip and put back afterwards/);
  db.setSetting('tesla_pairing_mode', 'local');
  assert.match(dl.limitNote(100, 80), /raise it in the Tesla app or the car will stop at 80%/);
  assert.equal(dl.limitNote(70, 80), '');
});

test('it is started with the app, and the briefing spells out trip energy and extra charging', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.match(read('src/server.js'), /departureLimit\.start\(\)/);
  assert.match(read('src/services/aiInsights.js'), /extra charging IS needed before leaving/);
  assert.match(read('src/controller.js'), /chargingState === 'Complete' && chargeLimit > batteryPct \+ 0\.5/,
    'departure resumes a car that stopped at its old limit once the limit is raised');
});
