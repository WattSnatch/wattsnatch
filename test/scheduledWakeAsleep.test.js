/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A scheduled window must wake a car that is asleep when it opens.
//
// Sibling of chargeNowWake.test.js, which covers the *stale state* case: a car
// that slept while still reporting `charging_state: 'Stopped'`. This is the
// other half - a car asleep long enough that there is no charge state at all.
//
// `_runScheduled` derives `pluggedIn` from `PLUGGED_IN.has(chargingState)`, and
// `chargingState` is null when the car reports nothing. `PLUGGED_IN.has(null)`
// is false, so the not-plugged-in guard fired and returned before the command
// block below it - where the wake lived. The window therefore did nothing at
// all, silently, and the only reason overnight charging appeared to work was
// that a cached charge state usually happened to be present.
//
// "No state" is not the same fact as "not plugged in". It means we do not know
// yet, and the way to find out is to wake the car.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-schedwake-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const controller = require('../src/controller');
const chargingTesla = require('../src/services/charging/tesla');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

/** Count wake/start/amps calls while fn runs, always restoring the originals. */
async function withStubs(fn) {
  const original = {
    wakeVehicle: chargingTesla.wakeVehicle,
    startCharging: chargingTesla.startCharging,
    setChargingAmps: chargingTesla.setChargingAmps,
  };
  const calls = { wake: 0, start: 0, amps: 0 };
  chargingTesla.wakeVehicle    = async () => { calls.wake++;  return { ok: true }; };
  chargingTesla.startCharging  = async () => { calls.start++; return { ok: true }; };
  chargingTesla.setChargingAmps = async () => { calls.amps++; return { ok: true }; };
  try {
    await fn(calls);
  } finally {
    Object.assign(chargingTesla, original);
  }
}

test('a window opening on a car with no charge state wakes it', async () => {
  await withStubs(async (calls) => {
    controller.lastWakeAttempt = 0;
    await controller._runScheduled({
      chargeState: null,             // asleep: nothing reported at all
      readings: null,                // night, so no meter data either
      vin: 'VIN123',
      teslaToken: 'token',
      freePower: false,
    });

    assert.equal(calls.wake, 1, 'no charge state means unknown, not unplugged - the car must be woken');
    assert.equal(calls.start, 0, 'and nothing is commanded until it reports back');
  });
});

test('the wake stays rate-limited so a whole window is not a wake storm', async () => {
  await withStubs(async (calls) => {
    controller.lastWakeAttempt = Date.now() - 30 * 1000; // 30s ago
    await controller._runScheduled({
      chargeState: null, readings: null, vin: 'VIN123', teslaToken: 'token', freePower: false,
    });

    assert.equal(calls.wake, 0, 'a tick every 60s must not mean a wake every 60s');
  });
});

test('an unplugged car that IS reporting is still left alone', async () => {
  await withStubs(async (calls) => {
    controller.lastWakeAttempt = 0;
    await controller._runScheduled({
      chargeState: { charging_state: 'Disconnected', battery_level: 50, charge_limit_soc: 80, charge_amps: 0 },
      readings: null, vin: 'VIN123', teslaToken: 'token', freePower: false,
    });

    assert.equal(calls.wake, 0, 'this car answered and said it is unplugged - waking it proves nothing');
    assert.equal(calls.start, 0);
  });
});

test('a plugged-in, stopped car still gets started', async () => {
  await withStubs(async (calls) => {
    controller.lastWakeAttempt = 0;
    await controller._runScheduled({
      chargeState: { charging_state: 'Stopped', battery_level: 40, charge_limit_soc: 90, charge_amps: 0 },
      readings: null, vin: 'VIN123', teslaToken: 'token', freePower: false,
    });

    assert.equal(calls.start, 1, 'the ordinary path must be untouched by the wake fix above it');
    assert.equal(calls.amps, 1);
  });
});

/** Record _endSession calls without touching the database. */
async function withSessionSpy(fn) {
  const originalEnd = controller._endSession;
  const originalId = controller.currentSessionId;
  const ended = [];
  controller._endSession = (batteryEnd, endReason) => { ended.push({ batteryEnd, endReason }); };
  controller.currentSessionId = 1234;
  try {
    await fn(ended);
  } finally {
    controller._endSession = originalEnd;
    controller.currentSessionId = originalId;
  }
}

test('a car that falls asleep mid-session does not have the session closed at 0%', async () => {
  // The second bug this fixes, and the easier of the two to undo by accident: with
  // no charge state, batteryPct is 0, so the old path reached the not-plugged-in
  // guard and ended the live session as 'disconnected' with a recorded end battery
  // of zero. That corrupts the session's own accounting, not just the schedule.
  // Moving the wake below the guard again would bring it straight back.
  await withStubs(async () => {
    await withSessionSpy(async (ended) => {
      controller.lastWakeAttempt = 0;
      await controller._runScheduled({
        chargeState: null, readings: null, vin: 'VIN123', teslaToken: 'token', freePower: false,
      });

      assert.deepEqual(ended, [],
        'asleep is not knowing, so the session stays open until the car reports back for real');
    });
  });
});

test('a car that reports being unplugged still closes the session properly', async () => {
  await withStubs(async () => {
    await withSessionSpy(async (ended) => {
      controller.lastWakeAttempt = 0;
      await controller._runScheduled({
        chargeState: { charging_state: 'Disconnected', battery_level: 64, charge_limit_soc: 80, charge_amps: 0 },
        readings: null, vin: 'VIN123', teslaToken: 'token', freePower: false,
      });

      assert.equal(ended.length, 1, 'a real disconnect must still end the session');
      assert.equal(ended[0].endReason, 'disconnected');
      assert.equal(ended[0].batteryEnd, 64, 'and record the battery the car actually reported');
    });
  });
});
