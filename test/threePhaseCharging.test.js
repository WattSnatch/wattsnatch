/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Three-phase charging: charge current is commanded per-phase, so a three-phase
// charger at N amps draws three times the power a single-phase one does. Every
// amps<->watts conversion in the diversion loop goes through _wattsPerAmp().
//
// The load-bearing property here is the backwards-compatible one. charger_phases
// defaults to '1', and at one phase _wattsPerAmp() must equal the charger voltage
// exactly, because that is what the loop multiplied and divided by before this
// existed. Every install that never touches the new setting has to keep getting
// bit-identical numbers out of the control loop - this is the charging path, and
// a silent change to it is a real-world overdraw or a stalled charge.
//
// The other direction matters too: the fallback for a nonsense phase count is
// ONE, never three. Under-estimating watts-per-amp makes the loop command fewer
// amps than it could, which wastes a little surplus. Over-estimating makes it
// command more amps than the supply can carry, which is the failure that trips
// a breaker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-threephase-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const controller = require('../src/controller');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

/** Restore both settings to their shipped defaults between cases. */
function resetSettings() {
  db.setSetting('charger_voltage', '240');
  db.setSetting('charger_phases', '1');
  db.setSetting('min_charge_amps', '5');
}

test('the shipped default is single-phase, so watts per amp is just the voltage', () => {
  resetSettings();
  assert.equal(db.getSetting('charger_phases'), '1', 'the default must stay single-phase');
  assert.equal(controller._wattsPerAmp(), 240,
    'an install that never touches this setting must get exactly the old voltage-only number');
});

test('an unset phase count still behaves as single-phase', () => {
  resetSettings();
  db.setSetting('charger_phases', '');
  assert.equal(controller._wattsPerAmp(), 240,
    'a blank value is an install that predates the setting, not an invitation to guess');
});

test('three phases triple the watts drawn per commanded amp', () => {
  resetSettings();
  db.setSetting('charger_phases', '3');
  assert.equal(controller._wattsPerAmp(), 720);
});

test('two phases double it', () => {
  resetSettings();
  db.setSetting('charger_phases', '2');
  assert.equal(controller._wattsPerAmp(), 480);
});

test('a nonsense phase count falls back to one, never to more', () => {
  resetSettings();
  // Over-estimating watts-per-amp would make the loop command more current than
  // the supply can carry. Every bad value has to land on the cautious side.
  for (const bad of ['0', '-1', '4', '99', 'three', 'null', '2.5']) {
    db.setSetting('charger_phases', bad);
    assert.equal(controller._wattsPerAmp(), 240,
      `phase count ${JSON.stringify(bad)} must fall back to single-phase, not be trusted`);
  }
});

test('an unusable voltage falls back to the default rather than poisoning the maths', () => {
  resetSettings();
  // A NaN here would propagate all the way to targetAmps, and NaN survives the
  // Math.max/Math.min clamps that are supposed to bound the commanded current.
  for (const bad of ['', 'abc', '0', '-240']) {
    db.setSetting('charger_voltage', bad);
    assert.equal(controller._wattsPerAmp(), 240,
      `voltage ${JSON.stringify(bad)} must fall back to the 240 V default`);
  }
});

test('the voltage setting is still honoured alongside the phase count', () => {
  resetSettings();
  db.setSetting('charger_voltage', '230');
  db.setSetting('charger_phases', '3');
  assert.equal(controller._wattsPerAmp(), 690, '230V three-phase, not the 240V default');
});

test('the diversion threshold is unchanged for a single-phase install', () => {
  resetSettings();
  // 5 A x 240 V = 1200 W, exactly what this returned before phases existed.
  assert.equal(controller._getDiversionThreshold(false), 1200);
});

test('a three-phase install needs three times the surplus before it starts', () => {
  resetSettings();
  db.setSetting('charger_phases', '3');
  // Same 5 A minimum, but each amp now costs three times the power, so the
  // surplus required to reach that minimum scales with it.
  assert.equal(controller._getDiversionThreshold(false), 3600);
});

test('the trip-priority discount still applies on top of the phase count', () => {
  resetSettings();
  db.setSetting('charger_phases', '3');
  // 3600 W x 0.7 = 2520 W, and well above the 400 W floor.
  assert.equal(controller._getDiversionThreshold(true), 2520);
});

test('a three-phase install commands fewer amps for the same surplus', () => {
  // This is the whole point of the change, stated as the loop experiences it:
  // targetAmps = floor(surplus / wattsPerAmp). Commanding single-phase amps on a
  // three-phase charger would draw three times the power that was actually spare.
  resetSettings();
  const surplusW = 7200;

  const singlePhaseAmps = Math.floor(surplusW / controller._wattsPerAmp());
  db.setSetting('charger_phases', '3');
  const threePhaseAmps = Math.floor(surplusW / controller._wattsPerAmp());

  assert.equal(singlePhaseAmps, 30);
  assert.equal(threePhaseAmps, 10);
  assert.equal(singlePhaseAmps * 240, threePhaseAmps * 720,
    'both must add up to the same actual power drawn from the roof');
});
