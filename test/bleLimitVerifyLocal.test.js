/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A cloud-free install was calling the cloud, tens of thousands of times.
//
// Before stopping a charge the controller re-checks the car's charge limit, because a
// stale cached value silently caps the car below what its owner set. That check called
// the Fleet API unconditionally, including in BLE state-source mode where everything
// else runs locally. One install logged 63,146 of them, every one failing against an
// account Tesla had already disabled for exceeding its allowance.
//
// It also retried forever. The check is gated on how old the cached limit is, and a
// failed call never refreshes that, so the condition stayed true and it fired on the
// next tick. The log shows them roughly ten seconds apart, for weeks.
//
// Both halves are fixed here: BLE mode asks the car over Bluetooth, which is free,
// local, and works with no Tesla token at all, and every attempt is stamped so a
// failure cannot repeat immediately.
//
// The two reads return different shapes and that is the trap worth pinning. The cloud
// call returns raw charge_state, so the limit is charge_limit_soc. The BLE read returns
// a flattened object, where it is chargeLimit. Swapping one for the other without
// translating would yield undefined, the check would silently never confirm anything,
// and nothing would look broken.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const blockStart = code.indexOf('const verifyOverBle =');
const blockEnd   = code.indexOf('if (knownDisconnected ||', blockStart);
const block      = code.slice(blockStart, blockEnd);

test('the stop-time limit check is found and bounded', () => {
  assert.ok(blockStart >= 0, 'the re-verify block must exist');
  assert.ok(blockEnd > blockStart, 'it must be bounded by the stop decision that follows');
  assert.ok(block.length > 200, 'the isolated block must be substantial');
});

test('BLE mode asks the car, not Tesla', () => {
  assert.match(block, /if \(verifyOverBle\) \{[\s\S]{0,200}getVehicleDataBle\(vin\)/,
    'the local read is the whole point of that mode');
});

test('cloud mode still asks Tesla', () => {
  assert.match(block, /else \{[\s\S]{0,200}getVehicleData\(vin, teslaToken\)/,
    'Fleet installs must keep the check they already had');
});

test('each branch reads the limit from its own response shape', () => {
  // The cloud returns raw charge_state; the BLE read returns a flattened object.
  assert.match(block, /freshLimit = bleData\.chargeLimit/,
    'the flattened BLE shape uses chargeLimit');
  assert.match(block, /freshLimit = fresh\?\.charge_limit_soc/,
    'the raw cloud shape uses charge_limit_soc');
});

test('the local read is not counted as a metered API call', () => {
  const bleBranch = block.slice(block.indexOf('if (verifyOverBle) {'), block.indexOf('} else {'));
  assert.ok(bleBranch.length > 0, 'the BLE branch must be found');
  assert.ok(!/_trackApiCall/.test(bleBranch),
    'a local Bluetooth read costs nothing and must not be logged as API spend');
  const cloudBranch = block.slice(block.indexOf('} else {'), block.indexOf('if (typeof freshLimit'));
  assert.match(cloudBranch, /_trackApiCall\('data'\)/,
    'the cloud call is metered and must still be tracked');
});

test('BLE mode does not require a Tesla token to run the check', () => {
  // A fully local install may have no token at all. Requiring one would silently
  // disable the check rather than run it locally.
  assert.match(block, /const canVerifyLimit = !!vin && \(verifyOverBle \|\| !!teslaToken\)/,
    'the token must only be required for the cloud path');
});

test('every attempt is stamped, so a failure cannot retry on the next tick', () => {
  assert.match(block, /Date\.now\(\) - this\._lastLimitVerifyAt\) >= VERIFY_LIMIT_BEFORE_STOP_MS/,
    'the gap must be part of the trigger condition');
  const stamp = block.indexOf('this._lastLimitVerifyAt = Date.now()');
  const call  = block.indexOf('getVehicleDataBle(vin)');
  assert.ok(stamp >= 0 && call > stamp,
    'the stamp must be written before the call, so a throw still counts as an attempt');
});

test('the stamp starts at zero so the first check is never delayed', () => {
  assert.match(src, /this\._lastLimitVerifyAt = 0;/,
    'a never-run check must be allowed to run immediately');
});
