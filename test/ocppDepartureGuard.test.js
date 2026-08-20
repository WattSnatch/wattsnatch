/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Regression tests for a real bug: departure scheduling on the OCPP backend
// forced hours of full-rate GRID charging before every departure.
//
// OCPP 1.6 cannot read the vehicle's battery percentage on a typical home AC
// charger (that needs ISO 15118 "Plug and Charge"), so batteryPct is a
// permanent 0. getDepartureDecision() computed
// `missingPct = target - currentSoc`, which therefore stayed permanently equal
// to the FULL target - so it never hit the `missingPct === 0` auto-clear, and
// `needsGridCharge` latched true for the whole 6-hour activation window before
// every departure. Confirmed against the real code before the fix:
//   { active: true, needsGridCharge: true, missingPct: 80, hoursUntil: 3 }
// i.e. six hours of grid import, the exact opposite of this app's purpose,
// ending only when the departure time passed.
//
// The fix refuses to answer rather than answering wrongly. These tests pin
// both halves: OCPP refuses, and Tesla behaves exactly as it always did.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-ocpp-departure-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const departureScheduler = require('../src/services/departureScheduler');

const HOURS = 60 * 60 * 1000;

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

function reset(backend) {
  db.setSetting('charging_backend', backend);
  try { departureScheduler.clearDeparture(); } catch (_e) {}
}

test('OCPP: setting a departure is refused with an explanation, not silently accepted', () => {
  reset('ocpp');
  assert.throws(
    () => departureScheduler.setDeparture(Date.now() + 3 * HOURS, 80, 'probe'),
    /battery percentage|ISO 15118/i,
    'OCPP must refuse a departure rather than store one it can never satisfy'
  );
  assert.equal(departureScheduler.getActiveDeparture(), null, 'nothing should have been stored');
});

test('OCPP: a departure stored under Tesla is not acted on after switching to OCPP', () => {
  // The dangerous path: schedule under Tesla (allowed), then change backend.
  // Without the guard in getDepartureDecision() this stored row would still be
  // evaluated against a permanently-0 SoC and force grid charging.
  reset('tesla');
  departureScheduler.setDeparture(Date.now() + 3 * HOURS, 80, 'set-under-tesla');
  assert.ok(departureScheduler.getActiveDeparture(), 'precondition: departure stored under Tesla');

  db.setSetting('charging_backend', 'ocpp');
  const decision = departureScheduler.getDepartureDecision(0, 32);

  assert.equal(decision.active, false, 'must not be active on a no-SoC backend');
  assert.notEqual(decision.needsGridCharge, true, 'must never force grid charging without a real SoC');
  assert.equal(decision.unsupported, true);
  assert.match(decision.unsupportedReason, /battery percentage/i);
});

test('OCPP: the exact pre-fix failure case now returns no grid charge', () => {
  reset('ocpp');
  // Reproduces the original probe: 3h until departure (inside the 6h activation
  // window), 80% target, SoC permanently 0. Pre-fix this returned
  // needsGridCharge:true with missingPct:80.
  db.setDeparture(Date.now() + 3 * HOURS, 80, 'pre-fix-repro');
  const decision = departureScheduler.getDepartureDecision(0, 32);
  assert.notEqual(decision.needsGridCharge, true);
  assert.equal(decision.active, false);
});

test('Tesla: departure scheduling is completely unchanged', () => {
  reset('tesla');
  departureScheduler.setDeparture(Date.now() + 3 * HOURS, 80, 'tesla-normal');

  // Inside the 6h activation window, real SoC below target -> grid top-up, as always.
  const short = departureScheduler.getDepartureDecision(55, 32);
  assert.equal(short.active, true);
  assert.equal(short.needsGridCharge, true);
  assert.equal(short.missingPct, 25);
  assert.equal(short.targetSoc, 80);
  assert.equal(short.suggestedAmps, 32);
});

test('Tesla: reaching the target reports targetReached and does NOT clear yet', () => {
  // Deliberately changed behaviour. Clearing the row here used to make the
  // controller's stop unreachable: the decision went {active:false}, so
  // _runDeparture never ran on the tick the target was hit and the car carried
  // on charging toward the Tesla charge limit instead of stopping at target.
  // The controller now clears it, once it has actually stopped the car.
  reset('tesla');
  departureScheduler.setDeparture(Date.now() + 3 * HOURS, 80, 'tesla-reached');
  const done = departureScheduler.getDepartureDecision(80, 32);
  assert.equal(done.active, true);
  assert.equal(done.targetReached, true);
  assert.equal(done.needsGridCharge, false);
  assert.equal(done.targetSoc, 80);
  // Still stored - the controller is responsible for clearing it.
  assert.ok(departureScheduler.getActiveDeparture());
});

test('Tesla: outside the activation window it stays solar-first', () => {
  reset('tesla');
  departureScheduler.setDeparture(Date.now() + 12 * HOURS, 80, 'tesla-far-out');
  const far = departureScheduler.getDepartureDecision(55, 32);
  assert.equal(far.active, true);
  assert.equal(far.needsGridCharge, false, '12h out is well outside the 6h activation window');
});

test('socAvailable() reflects the backend', () => {
  db.setSetting('charging_backend', 'ocpp');
  assert.equal(departureScheduler.socAvailable(), false);
  db.setSetting('charging_backend', 'tesla');
  assert.equal(departureScheduler.socAvailable(), true);
  db.setSetting('charging_backend', '');
  assert.equal(departureScheduler.socAvailable(), true, 'unset must behave as Tesla, not as no-SoC');
});
