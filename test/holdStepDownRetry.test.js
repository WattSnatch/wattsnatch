/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// When solar drops, the car is dropped to minimum amps for the hold period, so
// the wait to see whether sun returns is not spent importing at the old rate.
//
// That step-down was sent exactly once, on the tick that starts the hold timer,
// and nothing re-attempted it. The timer is stamped before the command is sent
// and the state moves to HOLDING whether or not it succeeded, and HOLDING had no
// amp logic at all. So one failed command left the car drawing at whatever it was
// on, up to the configured maximum, straight from the grid, for the whole hold.
// The log recorded the failure and the state machine carried on regardless.
//
// Found in the live log 52 times: a car offline or asleep, and a request timing
// out while the Bluetooth proxy restarted. At 24 A a three minute hold is roughly
// 0.3 kWh imported per occurrence.
//
// Same shape as the charge reconciliation in chargingStateReconciliation.test.js:
// what this controller believes it commanded is not evidence the car received it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-holdretry-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const controller = require('../src/controller');
const chargingTesla = require('../src/services/charging/tesla');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

async function withStubs(fn, { ampsThrows = false } = {}) {
  const original = {
    setChargingAmps: chargingTesla.setChargingAmps,
    stopCharging:    chargingTesla.stopCharging,
    startCharging:   chargingTesla.startCharging,
    wakeVehicle:     chargingTesla.wakeVehicle,
  };
  const calls = { amps: 0, stop: 0, start: 0, lastAmps: null };
  chargingTesla.setChargingAmps = async (_vin, a) => {
    calls.amps++; calls.lastAmps = a;
    if (ampsThrows) throw new Error('vehicle unavailable: vehicle is offline or asleep');
    return { ok: true };
  };
  chargingTesla.stopCharging  = async () => { calls.stop++;  return { ok: true }; };
  chargingTesla.startCharging = async () => { calls.start++; return { ok: true }; };
  chargingTesla.wakeVehicle   = async () => ({ ok: true });
  try { await fn(calls); } finally { Object.assign(chargingTesla, original); }
}

// targetAmps 0 against minAmps 5 means "no usable solar", which is the hold condition.
function tick(overrides = {}) {
  return {
    targetAmps: 0, smoothedExcess: 200, chargingState: 'Charging', pluggedIn: true,
    batteryPct: 73, chargeLimit: 80, chargeAmps: 24, chargerPower: 5,
    holdMinutes: 3, minAmps: 5, maxAmps: 24,
    vin: 'VIN123', teslaToken: 'token', hasPriorCarData: true,
    ...overrides,
  };
}

// In a hold, with the car still up at 24 A because the step-down did not land.
function inHold({ lastCommandedAmps = 24, startedMsAgo = 20 * 1000, lastStepDownMsAgo = 60 * 1000 } = {}) {
  controller.state = 'HOLDING';
  controller.currentSessionId = null;          // keep _endSession a no-op
  controller.holdTimerStart = Date.now() - startedMsAgo;
  controller._lastCommandedAmps = lastCommandedAmps;
  controller._lastHoldStepDownAt = Date.now() - lastStepDownMsAgo;
}

test('a car left above the minimum by a failed step-down is dropped on a later tick', async () => {
  // The bug in one assertion: before the fix, HOLDING sent nothing at all.
  await withStubs(async (calls) => {
    inHold();
    await controller._stateMachine(tick());
    assert.equal(calls.amps, 1, 'the hold must re-attempt the step-down it never landed');
    assert.equal(calls.lastAmps, 5, 'and drop to the minimum, not anything else');
    assert.equal(controller._lastCommandedAmps, 5);
  });
});

test('a car already at the minimum is left alone', async () => {
  await withStubs(async (calls) => {
    inHold({ lastCommandedAmps: 5 });
    await controller._stateMachine(tick());
    assert.equal(calls.amps, 0, 'no command when the step-down already succeeded');
  });
});

test('the retry is rate limited, so a hold is not a command storm', async () => {
  await withStubs(async (calls) => {
    inHold({ lastStepDownMsAgo: 5 * 1000 });
    await controller._stateMachine(tick());
    assert.equal(calls.amps, 0, 'the usual cause is an offline car, which asking faster does not fix');
  });
});

test('once the gap has passed it tries again, because the import is still running', async () => {
  await withStubs(async (calls) => {
    inHold({ lastStepDownMsAgo: 45 * 1000 });
    await controller._stateMachine(tick());
    assert.equal(calls.amps, 1);
  });
});

test('a failed retry leaves the amps unrecorded so the next tick tries again', async () => {
  await withStubs(async (calls) => {
    inHold();
    await controller._stateMachine(tick());
    assert.equal(calls.amps, 1);
    assert.equal(controller._lastCommandedAmps, 24, 'a command that threw must not be recorded as sent');
  }, { ampsThrows: true });
});

test('an unplugged car is not chased', async () => {
  await withStubs(async (calls) => {
    inHold();
    await controller._stateMachine(tick({ pluggedIn: false, chargingState: 'Disconnected' }));
    assert.equal(calls.amps, 0);
  });
});

test('solar returning takes priority over retrying the step-down', async () => {
  await withStubs(async (calls) => {
    inHold();
    await controller._stateMachine(tick({ targetAmps: 16 }));
    assert.equal(controller.state, 'CHARGING');
    assert.equal(calls.lastAmps, 16, 'resume at the new target, not at the hold minimum');
  });
});

test('a resume records what it commanded, so the retry condition stays truthful', async () => {
  // Without this the field still read the hold minimum after resuming, which would
  // make the retry above fire against a car that is charging normally.
  await withStubs(async () => {
    inHold({ lastCommandedAmps: 5 });
    await controller._stateMachine(tick({ targetAmps: 16 }));
    assert.equal(controller._lastCommandedAmps, 16);
  });
});

test('an expired hold stops the charge rather than retrying a step-down', async () => {
  await withStubs(async (calls) => {
    inHold({ startedMsAgo: 4 * 60 * 1000 });
    await controller._stateMachine(tick());
    assert.equal(calls.stop, 1, 'the timer expiring ends the charge outright');
    assert.equal(calls.amps, 0, 'and must not also chase the minimum on the way out');
    assert.equal(controller.state, 'WAITING');
  });
});

test('the retry lives in the HOLDING branch and its gap is a real duration', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  const holding = code.slice(code.lastIndexOf('case STATES.HOLDING:'), code.lastIndexOf('case STATES.DEPARTURE:'));
  assert.ok(holding.length > 0, 'HOLDING branch must be found');
  assert.match(holding, /setChargingAmps\(vin, minAmps/,
    'HOLDING must be able to re-issue the step-down, otherwise one failure lasts the whole hold');

  const m = src.match(/HOLD_STEP_DOWN_RETRY_MS\s*=\s*(\d+)\s*\*\s*1000/);
  assert.ok(m, 'HOLD_STEP_DOWN_RETRY_MS must be defined in seconds');
  const secs = parseInt(m[1], 10);
  assert.ok(secs >= 15 && secs <= 90,
    `${secs}s must be short against a few minute hold, long enough not to hammer an offline car`);
});
