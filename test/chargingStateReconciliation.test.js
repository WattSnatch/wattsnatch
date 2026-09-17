/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Being in CHARGING is the controller's belief. The car is the authority.
//
// Found live 2026-09-17, on a clear day with 5.1 kW of surplus available and the
// car plugged in at 73% against an 80% limit. The loop intercepted the grid
// charge Tesla started on plug-in, which stopped the car. The two vehicle_data
// polls that followed both timed out, so the ten-second-old cached state still
// said 'Charging' - describing the charge the loop had itself just ended.
// MONITORING took that as "vehicle already charging, take control" and moved to
// CHARGING.
//
// CHARGING's only action is trimming amps. The start command lives in MONITORING
// and nothing returns there. So for 46 minutes the loop sent set_charging_amps to
// a stopped car, roughly every ten seconds, while the meter showed the car
// drawing 0 W across all 266 telemetry rows of the session and about 2.8 kWh of
// surplus went to the grid. The proxy was healthy throughout and every command
// succeeded. Nothing was broken except the assumption.
//
// Two safety nets missed it, which is why this needs its own. The phantom-charge
// watchdog requires `currentlyCharging && !chargeConfirmedLive`, and the car was
// honestly reporting Stopped, so `currentlyCharging` was false and it never
// fired. And the charge-limit guard returns above the state machine, so it never
// looked at this case either.
//
// The fix is to reconcile in CHARGING: if the car says it is not charging, start
// it. The rest of these tests pin the boundaries of that, because a restart is a
// command sent to a real car and the ways it could misfire are worse than the
// bug it fixes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-chargerecon-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const controller = require('../src/controller');
const chargingTesla = require('../src/services/charging/tesla');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

/** Count start/amps calls while fn runs, always restoring the originals. */
async function withStubs(fn) {
  const original = {
    startCharging:    chargingTesla.startCharging,
    setChargingAmps:  chargingTesla.setChargingAmps,
    stopCharging:     chargingTesla.stopCharging,
    wakeVehicle:      chargingTesla.wakeVehicle,
  };
  const calls = { start: 0, amps: 0, stop: 0, wake: 0, lastAmps: null };
  chargingTesla.startCharging   = async () => { calls.start++; return { ok: true }; };
  chargingTesla.setChargingAmps = async (_vin, a) => { calls.amps++; calls.lastAmps = a; return { ok: true }; };
  chargingTesla.stopCharging    = async () => { calls.stop++; return { ok: true }; };
  chargingTesla.wakeVehicle     = async () => { calls.wake++; return { ok: true }; };
  try {
    await fn(calls);
  } finally {
    Object.assign(chargingTesla, original);
  }
}

// A tick in CHARGING with plenty of solar and the battery well below its limit,
// so nothing above the state machine returns early. Only chargingState varies.
function tick(overrides = {}) {
  return {
    targetAmps: 16, smoothedExcess: 5000, chargingState: 'Stopped', pluggedIn: true,
    batteryPct: 73, chargeLimit: 80, chargeAmps: 16, chargerPower: 0,
    holdMinutes: 5, minAmps: 5, maxAmps: 32,
    vin: 'VIN123', teslaToken: 'token', hasPriorCarData: true,
    ...overrides,
  };
}

function inCharging({ lastCommandedAmps = 16, lastRestartAt = 0 } = {}) {
  controller.state = 'CHARGING';
  controller._lastCommandedAmps = lastCommandedAmps;
  controller._lastChargeRestartAt = lastRestartAt;
}

test('a car reporting Stopped while we believe we are charging is actually started', async () => {
  // The bug in one assertion: before the fix this sent amps and no start, for 46 minutes.
  await withStubs(async (calls) => {
    inCharging();
    await controller._stateMachine(tick({ chargingState: 'Stopped' }));
    assert.equal(calls.start, 1, 'setting amps on a stopped car does nothing - it must be started');
    assert.equal(calls.amps, 1, 'and given the target rate in the same action');
    assert.equal(calls.lastAmps, 16);
  });
});

test('NoPower is treated the same as Stopped', async () => {
  await withStubs(async (calls) => {
    inCharging();
    await controller._stateMachine(tick({ chargingState: 'NoPower' }));
    assert.equal(calls.start, 1);
  });
});

test('a car that is genuinely charging is never sent a start', async () => {
  await withStubs(async (calls) => {
    inCharging({ lastCommandedAmps: 10 });
    await controller._stateMachine(tick({ chargingState: 'Charging' }));
    assert.equal(calls.start, 0, 'restarting a running charge is not a no-op on a real car');
    assert.equal(calls.amps, 1, 'it just follows the surplus as before');
    assert.equal(calls.lastAmps, 16);
  });
});

test('no charge state at all is not evidence, so nothing is started', async () => {
  // A sleeping car reports nothing. Commanding a start on an absence of data is
  // how the scheduled-wake bug happened in reverse: acting on "we do not know".
  await withStubs(async (calls) => {
    inCharging();
    await controller._stateMachine(tick({ chargingState: null }));
    assert.equal(calls.start, 0, 'null means asleep or not yet reported, not stopped');
  });
});

test('a car that is not plugged in is never started', async () => {
  await withStubs(async (calls) => {
    inCharging();
    await controller._stateMachine(tick({ chargingState: 'Stopped', pluggedIn: false }));
    assert.equal(calls.start, 0, 'starting a charge on an unplugged car is meaningless');
  });
});

test('the restart is rate limited, so a fast tick is not a command storm', async () => {
  // The loop ticks every few seconds in BLE mode. A car that will not start for
  // a reason we cannot see must not be commanded on every one of them.
  await withStubs(async (calls) => {
    inCharging({ lastRestartAt: Date.now() - 5 * 1000 }); // 5s ago
    await controller._stateMachine(tick({ chargingState: 'Stopped' }));
    assert.equal(calls.start, 0, 'within the cooldown, nothing is re-sent');
  });
});

test('after the cooldown passes it tries again, because the surplus is still going to the grid', async () => {
  await withStubs(async (calls) => {
    inCharging({ lastRestartAt: Date.now() - 10 * 60 * 1000 }); // 10 min ago
    await controller._stateMachine(tick({ chargingState: 'Stopped' }));
    assert.equal(calls.start, 1, 'a stuck charge must not be abandoned silently');
  });
});

test('a successful restart stamps the clock so the next tick is bounded', async () => {
  await withStubs(async () => {
    inCharging();
    const before = controller._lastChargeRestartAt;
    await controller._stateMachine(tick({ chargingState: 'Stopped' }));
    assert.ok(controller._lastChargeRestartAt > before,
      'without stamping, the cooldown never engages and the storm returns');
  });
});

test('a charging car at the rate it was already given is left entirely alone', async () => {
  await withStubs(async (calls) => {
    inCharging({ lastCommandedAmps: 16 });
    await controller._stateMachine(tick({ chargingState: 'Charging' }));
    assert.equal(calls.amps, 0, 'no redundant command when the target has not moved');
    assert.equal(calls.start, 0);
  });
});

// Source-level guard. The behaviour above can be satisfied by a start command
// placed anywhere; what actually broke was that CHARGING had no start at all.
test('the start command lives inside the CHARGING branch, not only in MONITORING', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // lastIndexOf, not indexOf: _diversionReason near the top of the file has its own
  // `case STATES.HOLDING:` and `case STATES.CHARGING:` lines, and HOLDING comes first
  // there, so an indexOf pair slices backwards and silently yields nothing.
  const charging = code.slice(code.lastIndexOf('case STATES.CHARGING:'),
                              code.lastIndexOf('case STATES.HOLDING:'));
  assert.ok(charging.length > 0, 'CHARGING branch must be found');
  assert.match(charging, /startCharging\(/,
    'CHARGING must be able to start a charge, otherwise a stopped car is trimmed forever');

  const cond = charging.match(/const carSaysNotCharging\s*=\s*([^;]+);/);
  assert.ok(cond, 'the restart condition must be named so it can be read here');
  assert.match(cond[1], /'Stopped'/, 'the reconciliation must key off what the car reports');
  assert.match(cond[1], /'NoPower'/);
  assert.ok(!/null/.test(cond[1]),
    'a null charge state must never be part of the restart condition: it means asleep, not stopped');
});

test('the cooldown is a real duration rather than a flag', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  const m = src.match(/CHARGE_RESTART_MIN_GAP_MS\s*=\s*(\d+)\s*\*\s*1000/);
  assert.ok(m, 'CHARGE_RESTART_MIN_GAP_MS must be defined in seconds');
  const secs = parseInt(m[1], 10);
  assert.ok(secs >= 30 && secs <= 300,
    `${secs}s must be short enough to stop wasting surplus, long enough not to hammer the car`);
});
