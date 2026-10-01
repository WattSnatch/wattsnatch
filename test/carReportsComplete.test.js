/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The car saying Complete means it is done, whether or not the app has confirmed the limit.
//
// Found live 2026-10-01. A restart while the car slept left the cached charge limit
// unconfirmed (by design: a remembered limit is not trusted until the car confirms it). The
// car was at 80%, plugged in, reporting Complete, with 4 kW of surplus. The limit check above
// the state machine only acts on a confirmed limit, so it let the tick through, and
// MONITORING has branches for Charging, Stopped/NoPower and asleep, but not Complete. So it
// sat in MONITORING for hours, the dashboard said "starting charge", nothing was sent, and the
// "unconfirmed limit" line was logged every tick (258 times in 40 minutes).
//
// Pinned here: Complete goes to IDLE and stays there with no commands, ends a session the
// car finished on its own, and the unconfirmed-limit log is rate limited.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-complete-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const logger = require('../src/utils/logger');
const telemetry = require('../src/services/telemetry');
const controller = require('../src/controller');
const chargingTesla = require('../src/services/charging/tesla');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

async function withStubs(fn) {
  const original = {
    startCharging: chargingTesla.startCharging, setChargingAmps: chargingTesla.setChargingAmps,
    stopCharging: chargingTesla.stopCharging, wakeVehicle: chargingTesla.wakeVehicle,
  };
  const calls = { start: 0, amps: 0, stop: 0, wake: 0 };
  chargingTesla.startCharging   = async () => { calls.start++; return { ok: true }; };
  chargingTesla.setChargingAmps = async () => { calls.amps++; return { ok: true }; };
  chargingTesla.stopCharging    = async () => { calls.stop++; return { ok: true }; };
  chargingTesla.wakeVehicle     = async () => { calls.wake++; return { ok: true }; };
  try { await fn(calls); } finally { Object.assign(chargingTesla, original); }
}

// The live situation: plenty of surplus, plugged in, 80% against an 80% limit.
function tick(overrides = {}) {
  return {
    targetAmps: 16, smoothedExcess: 4300, chargingState: 'Complete', pluggedIn: true,
    batteryPct: 80, chargeLimit: 80, chargeAmps: 0, chargerPower: 0,
    holdMinutes: 3, minAmps: 5, maxAmps: 32,
    vin: 'VIN123', teslaToken: 'token', hasPriorCarData: true,
    ...overrides,
  };
}

test('precondition: the limit really is unconfirmed, as after a restart', () => {
  assert.equal(telemetry.getChargeLimitAge(), Infinity);
});

test('Complete with an unconfirmed limit settles in IDLE and sends nothing', async () => {
  await withStubs(async (calls) => {
    controller.state = 'MONITORING';
    controller.currentSessionId = null;
    for (let i = 0; i < 5; i++) await controller._stateMachine(tick());
    assert.equal(controller.state, 'IDLE', 'not stuck in MONITORING');
    assert.deepEqual(calls, { start: 0, amps: 0, stop: 0, wake: 0 }, 'no commands to a full car');
  });
});

test('from IDLE, surplus does not pull a Complete car back into MONITORING', async () => {
  await withStubs(async () => {
    controller.state = 'IDLE';
    await controller._stateMachine(tick());
    await controller._stateMachine(tick());
    assert.equal(controller.state, 'IDLE');
  });
});

test('a session the car finishes on its own is ended, not trimmed', async () => {
  await withStubs(async (calls) => {
    controller.state = 'CHARGING';
    const ended = [];
    const orig = controller._endSession;
    controller._endSession = (pct, reason) => { ended.push(reason); };
    try {
      await controller._stateMachine(tick());
    } finally {
      controller._endSession = orig;
    }
    assert.deepEqual(ended, ['charge_complete']);
    assert.equal(controller.state, 'IDLE');
    assert.equal(calls.amps, 0, 'no amp changes on a full car');
  });
});

test('Stopped below the limit still starts charging (unchanged)', async () => {
  await withStubs(async (calls) => {
    controller.state = 'MONITORING';
    const orig = controller._startSession;
    controller._startSession = () => {};
    try {
      await controller._stateMachine(tick({ chargingState: 'Stopped', batteryPct: 70 }));
    } finally {
      controller._startSession = orig;
    }
    assert.equal(calls.start, 1);
    assert.equal(controller.state, 'CHARGING');
  });
});

test('the unconfirmed-limit line is logged at most every 30 minutes, and not for Complete', async () => {
  const lines = [];
  const orig = logger.logEvent;
  logger.logEvent = (type, msg) => { if (/unconfirmed charge limit/.test(msg)) lines.push(msg); };
  try {
    await withStubs(async () => {
      controller._lastUnconfirmedLimitLogAt = 0;
      controller.state = 'IDLE';
      for (let i = 0; i < 5; i++) await controller._stateMachine(tick());
      assert.equal(lines.length, 0, 'Complete is already the answer - nothing to defer');

      for (let i = 0; i < 5; i++) {
        controller.state = 'MONITORING';
        await controller._stateMachine(tick({ chargingState: 'Stopped' }));
      }
      assert.equal(lines.length, 1, 'once, not once per tick');
    });
  } finally {
    logger.logEvent = orig;
  }
});
