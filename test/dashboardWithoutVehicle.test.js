/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A working inverter with no Tesla VIN paired must still render solar/house data.
// Reported live via issues #17 and #19: the setup completes, the inverter (e.g. Fronius)
// is fine and TeslaMate is connected, but the dashboard shows nothing and the logs show no
// errors - because the control loop hard-returned at the very top on a missing VIN, before
// it ever read the meter. Solar/house metering is independent of whether a car is paired.
// The live behaviour needs a running meter provider and telemetry stack, so these are
// source-level assertions on the exact loop wiring the incident proved was wrong.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the top-of-loop guard no longer bails on a missing VIN', () => {
  // It must still bail when there is no meter to read, but not merely because no car is paired.
  assert.match(code, /if\s*\(!provider\s*\|\|\s*!provider\.isConfigured\(\)\)\s*return;/,
    'the guard must be provider-only');
  assert.doesNotMatch(code, /!provider\.isConfigured\(\)\s*\|\|\s*!vin\)\s*return;/,
    'the old VIN-gated early return must be gone');
});

test('a no-VIN branch records and emits metering-only telemetry, then returns', () => {
  // Isolate the branch body so the assertions cannot be satisfied by other parts of the loop.
  const idx = code.indexOf('if (!vin) {');
  assert.ok(idx >= 0, 'there must be an explicit no-vin branch');
  const branch = code.slice(idx, idx + 900);
  assert.match(branch, /diversion_reason:\s*'no_vehicle'/,
    'the metering row must be tagged so history shows why the car was absent');
  assert.match(branch, /this\._emitTelemetry\(readings,\s*null,/,
    'must emit dashboard telemetry with a null vehicle state so solar/house data renders');
  assert.match(branch, /return;/,
    'must return before the vehicle-only sections that assume a VIN');
});

test('the no-VIN branch runs after the meter read, not before it', () => {
  // If it came before the meter read, readings would be null and there would be nothing to show.
  const meterRead = code.indexOf('await provider.fetchReadings()');
  const noVin = code.indexOf('if (!vin) {');
  assert.ok(meterRead >= 0 && noVin >= 0 && noVin > meterRead,
    'the no-vin branch must sit after readings have been fetched');
});
