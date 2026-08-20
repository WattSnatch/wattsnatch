/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// CHARGE NOW must wake a sleeping car.
//
// Reported by the user, and reproduced from the production log: pressing CHARGE
// NOW fired setChargingAmps thirteen times over two minutes, every one returning
// `500 vehicle unavailable: vehicle is offline or asleep`, and never once sent a
// wake. `CHARGE NOW: waking vehicle` had never been emitted in the entire log
// history.
//
// The cause: _runOverride gates its wake on `if (!chargeState)`, but telemetry
// keeps whatever state it was last pushed. A car that was plugged in and then
// slept still reports `charging_state: 'Stopped'`, so chargeState is truthy, the
// wake branch is skipped, and the catch block only logged. The solar path and
// the departure path each had their own recovery for exactly this; the override
// and scheduled paths did not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-chargenowwake-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const controller = require('../src/controller');
// charging/index.js dispatches per call via _backend(), re-reading the property
// off this module each time - so replacing it here is picked up by the
// controller without any module-cache surgery.
const chargingTesla = require('../src/services/charging/tesla');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

const ASLEEP = new Error(
  'Set charging amps failed with status 500: {"response":null,"error":"vehicle unavailable: vehicle is offline or asleep"}'
);

/** Swap in a counting stub for wakeVehicle, run fn, always restore. */
async function withWakeStub(fn, { shouldThrow = false } = {}) {
  const original = chargingTesla.wakeVehicle;
  let calls = 0;
  chargingTesla.wakeVehicle = async () => {
    calls++;
    if (shouldThrow) throw new Error('wake failed');
    return { ok: true };
  };
  try {
    await fn(() => calls);
  } finally {
    chargingTesla.wakeVehicle = original;
  }
}

// ── Behaviour ────────────────────────────────────────────────────────────────

test('a sleeping-car error triggers an actual wake', async () => {
  await withWakeStub(async (calls) => {
    controller.lastWakeAttempt = 0;
    const woke = await controller._wakeIfAsleep(ASLEEP, 'VIN123', 'token', 'CHARGE NOW', { userInitiated: true });
    assert.equal(woke, true, 'the whole point: a sleeping car must be woken');
    assert.equal(calls(), 1);
  });
});

test('it clears _carSleeping, so the stale state that caused this gets refreshed', async () => {
  await withWakeStub(async () => {
    controller.lastWakeAttempt = 0;
    controller._carSleeping = true;
    await controller._wakeIfAsleep(ASLEEP, 'VIN123', 'token', 'CHARGE NOW', { userInitiated: true });
    assert.equal(controller._carSleeping, false,
      'while _carSleeping is true the REST fallback is skipped, so the stale chargeState would never refresh');
  });
});

test('an unrelated failure does not wake the car', async () => {
  await withWakeStub(async (calls) => {
    controller.lastWakeAttempt = 0;
    const woke = await controller._wakeIfAsleep(
      new Error('Set charging amps failed with status 401: unauthorized'), 'VIN123', 'token', 'CHARGE NOW');
    assert.equal(woke, false);
    assert.equal(calls(), 0, 'a 401 is a token problem, not a sleeping car');
  });
});

test('a wake failure is reported, not swallowed as success', async () => {
  await withWakeStub(async (calls) => {
    controller.lastWakeAttempt = 0;
    const woke = await controller._wakeIfAsleep(ASLEEP, 'VIN123', 'token', 'CHARGE NOW', { userInitiated: true });
    assert.equal(woke, false);
    assert.equal(calls(), 1, 'it still tried');
  }, { shouldThrow: true });
});

test('a user press is not throttled by a wake the background loop just sent', async () => {
  // lastWakeAttempt is shared by every wake site. A solar-loop wake seconds
  // earlier used to silently suppress a user-initiated one, with no log at all -
  // which is what made a dead button so hard to explain.
  await withWakeStub(async (calls) => {
    controller.lastWakeAttempt = Date.now() - 30 * 1000; // 30s ago
    const woke = await controller._wakeIfAsleep(ASLEEP, 'VIN123', 'token', 'CHARGE NOW', { userInitiated: true });
    assert.equal(woke, true, 'a person pressing a button gets a 20s guard, not the loop\'s 3 minutes');
    assert.equal(calls(), 1);
  });
});

test('the background loop keeps its 3-minute guard', async () => {
  await withWakeStub(async (calls) => {
    controller.lastWakeAttempt = Date.now() - 30 * 1000;
    const woke = await controller._wakeIfAsleep(ASLEEP, 'VIN123', 'token', 'Solar');
    assert.equal(woke, false, 'background retries must stay rate-limited');
    assert.equal(calls(), 0);
  });
});

test('a suppressed wake is logged rather than silent', async () => {
  await withWakeStub(async () => {
    const before = db.getRecentEvents ? db.getRecentEvents(50).length : null;
    controller.lastWakeAttempt = Date.now();
    await controller._wakeIfAsleep(ASLEEP, 'VIN123', 'token', 'Solar');
    if (before !== null) {
      const after = db.getRecentEvents(50);
      assert.ok(
        after.some(e => /wake was sent/i.test(e.details || '')),
        'suppression must leave a trace - silence is what hid this bug'
      );
    }
  });
});

// ── Wiring: every command path must have the recovery ────────────────────────

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');

test('all four command paths call the shared wake recovery', () => {
  // Before the fix only two of the four had it, and the two that did each had
  // their own copy. One implementation, called from all four.
  for (const label of ["'CHARGE NOW'", "'Departure'", "'Solar'", 'label']) {
    assert.ok(
      src.includes(`this._wakeIfAsleep(err, vin, teslaToken, ${label}`),
      `the ${label} path must recover from a sleeping car`
    );
  }
});

test('CHARGE NOW is flagged as user-initiated', () => {
  assert.match(
    src,
    /_wakeIfAsleep\(err, vin, teslaToken, 'CHARGE NOW', \{ userInitiated: true \}\)/,
    'a button press must not be throttled like a background retry'
  );
});

test('a missing token on the CHARGE NOW path is no longer silent', () => {
  // _canSendCommands(null) is false, which skipped the whole command block with
  // no else - and the route had already returned {ok:true}, which the dashboard
  // discards. The button did nothing, said nothing, and logged nothing.
  assert.match(src, /CHARGE NOW: no usable Tesla token/,
    'a command that cannot be sent must say so somewhere');
});
