/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Trip charging must stop at the target, on telemetry - never by lowering the
// Tesla charge limit.
//
// Reported by the user: the "Charge to X% for this trip" button charged well
// past the minimum the trip needed. The route was calling
// setChargeLimit(vin, 31) and relying on the car to stop itself. Tesla enforces
// a 50% floor on the charge limit, and tripPlanner computes minimumSocRequired
// as trip% + a 20% floor - so a short trip lands around 31%, inside the band
// Tesla rejects. The limit silently clamped and the car charged on toward 80%.
//
// Separately, the automatic path could not stop either: getDepartureDecision
// deleted the departure row the instant the target was reached, so
// _runDeparture was never called on that tick and control fell through to the
// state machine, which stops on the Tesla charge limit rather than our target.
//
// "Cover a trip on the least possible grid power" is the whole feature. These
// pin it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-triptarget-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
db.setSetting('charging_backend', 'tesla');

const departureScheduler = require('../src/services/departureScheduler');

const HOURS = 60 * 60 * 1000;

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

// ── The scheduler must hand the controller a chance to stop ──────────────────

test('reaching the target reports targetReached and keeps the row', () => {
  departureScheduler.setDeparture(Date.now() + 3 * HOURS, 31, 'trip');
  const d = departureScheduler.getDepartureDecision(31, 32);

  assert.equal(d.active, true, 'clearing here made the controller stop unreachable');
  assert.equal(d.targetReached, true);
  assert.equal(d.needsGridCharge, false, 'at target there is nothing left to charge');
  assert.equal(d.targetSoc, 31);
  assert.ok(departureScheduler.getActiveDeparture(),
    'the controller clears this, once it has actually stopped the car');
  departureScheduler.clearDeparture();
});

test('overshooting the target still reports targetReached', () => {
  // Telemetry arrives in steps, so the exact target is often skipped.
  departureScheduler.setDeparture(Date.now() + 3 * HOURS, 31, 'trip');
  const d = departureScheduler.getDepartureDecision(34, 32);
  assert.equal(d.targetReached, true);
  assert.equal(d.needsGridCharge, false);
  departureScheduler.clearDeparture();
});

test('below target inside the window still asks for grid charge', () => {
  departureScheduler.setDeparture(Date.now() + 3 * HOURS, 31, 'trip');
  const d = departureScheduler.getDepartureDecision(22, 32);
  assert.equal(d.active, true);
  assert.equal(d.needsGridCharge, true);
  assert.equal(d.missingPct, 9);
  assert.ok(!d.targetReached);
  departureScheduler.clearDeparture();
});

test('a sub-50% target is accepted - that is the normal case for a short trip', () => {
  // The Tesla charge limit cannot go below 50, which is precisely why the
  // target lives here rather than being pushed to the car.
  departureScheduler.setDeparture(Date.now() + 2 * HOURS, 27, 'short trip');
  assert.equal(departureScheduler.getActiveDeparture().targetSoc, 27);
  departureScheduler.clearDeparture();
});

// ── The controller must issue a real stop ────────────────────────────────────

const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');

test('_runDeparture stops the car when the target is reached', () => {
  const start = controllerSrc.indexOf('async _runDeparture(');
  assert.ok(start > 0);
  const body = controllerSrc.slice(start, controllerSrc.indexOf('async _safeStop('));

  assert.match(body, /const targetReached = batteryPct > 0 && batteryPct >= departure\.targetSoc/);
  assert.match(body, /_safeStop\(/,
    'this branch used to only log and set IDLE, leaving the car charging');
  assert.match(body, /Departure target \$\{departure\.targetSoc\}% reached at/,
    'the stop should say what it stopped at');
});

test('the stop is not gated on the Tesla charge limit being confirmed', () => {
  // limitConfirmed exists so a stale *Tesla* limit cannot end a charge early.
  // The trip target is our own number, so that guard has no bearing on it -
  // gating on it would reintroduce the overshoot whenever the limit was stale.
  const start = controllerSrc.indexOf('async _runDeparture(');
  const body = controllerSrc.slice(start, controllerSrc.indexOf('async _safeStop('));
  // Comments stripped: the method explains *why* it is not gated, and that
  // prose mentions the identifier.
  const code = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/limitConfirmed/.test(code),
    'the departure stop must not depend on the age of Tesla\'s charge limit');
});

test('the departure dispatch enters on targetReached, not just needsGridCharge', () => {
  assert.match(
    controllerSrc,
    /departureDecision\.needsGridCharge \|\| departureDecision\.targetReached/,
    'without this the stop branch is never reached'
  );
});

test('departure charging is dispatched above the meter guard', () => {
  // Departure charging is grid charging and needs no solar data. While it sat
  // below the guard, a flaky inverter silently disabled the whole feature.
  const departureIdx = controllerSrc.indexOf('// --- Departure scheduler ---');
  const guardIdx     = controllerSrc.indexOf('Solar diversion requires a meter reading');
  assert.ok(departureIdx > 0 && guardIdx > 0);
  assert.ok(departureIdx < guardIdx,
    'a missing meter must not stop the car being charged for a trip');
});

// ── The route must not touch the Tesla charge limit ──────────────────────────

const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');

test('charge-for-trip no longer sets the Tesla charge limit', () => {
  const start = apiSrc.indexOf("router.post('/api/trips/charge-for-trip'");
  assert.ok(start > 0);
  const body = apiSrc.slice(start, apiSrc.indexOf('router.', start + 10));

  assert.ok(!/await setChargeLimit\(/.test(body),
    'Tesla clamps any limit below 50%, so this could never honour a 31% target');
  assert.match(body, /departureScheduler\.setDeparture\(/,
    'the target belongs where the controller can act on it');
});

test('charge-for-trip does not fall back to CHARGE NOW', () => {
  // commandChargeNow() puts the loop in OVERRIDE, which is dispatched before
  // the departure block and has no stop-at-target - it would recreate the exact
  // overshoot this fixes.
  const start = apiSrc.indexOf("router.post('/api/trips/charge-for-trip'");
  const body = apiSrc.slice(start, apiSrc.indexOf('router.', start + 10));
  assert.ok(!/commandChargeNow\(/.test(body),
    'OVERRIDE has no target and would charge straight past it');
});

test('the dashboard slider still refuses a sub-50% charge limit', () => {
  // The one place a charge limit is still written. Tesla's floor applies there
  // and the check must stay.
  const start = apiSrc.indexOf("router.post('/api/charge/limit'");
  const body = apiSrc.slice(start, apiSrc.indexOf('router.', start + 10));
  assert.match(body, /limit < 50/);
});
