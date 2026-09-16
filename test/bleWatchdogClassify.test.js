/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The BLE proxy watchdog decides whether to act purely from the proxy's HTTP response, so its
// classification rules are the whole safety-critical surface of that script. These drive the real
// rules, through the script's own --classify hook, against responses actually recorded from the
// proxy rather than invented ones.
//
// This exists because of a specific eleven-hour failure on 2026-09-16. The rules used to name the
// faults they knew about and treat anything unrecognised as healthy. The proxy then began
// answering with a scan error that was not on that list, every check read it as healthy, and the
// watchdog logged "healthy again (HTTP 503)" over and over while the car sat one metre from the
// house with no charging control. Nothing was broken except the assumption that an unknown error
// is a safe one.
//
// So the direction under test is: benign is a short allowlist, and everything else is a fault.
// Adding a new fault string should never be required to make the watchdog act. The two benign
// entries both come from the proxy's own logs and both must stay benign, because acting on either
// would be worse than doing nothing: the car is simply away for most of any given day, and the
// BLE connection cap clears itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'teslable-watchdog.sh');

/** Run the watchdog's own classification rules over one response. */
function classify(httpCode, body) {
  return execFileSync('bash', [SCRIPT, '--classify', String(httpCode), body], {
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
}

test('a healthy read is not a fault', () => {
  const body = '{"response":{"result":true,"reason":"The request was successfully processed.",'
    + '"vin":"LRWYHCFJ5SC179194","command":"body-controller-state"}}';
  assert.equal(classify(200, body), '');
});

test('the car simply being away is not a fault', () => {
  // 76 occurrences in one week. The car is out most of the day; restarting into this would be
  // pure noise, and worse, it would train the hourly cap to be exhausted by non-problems.
  const body = '{"response":{"result":false,"reason":"Vehicle is not in range: ble: failed to '
    + 'scan for LRWYHCFJ5SC179194: context canceled"}}';
  assert.equal(classify(503, body), '');
});

test('hitting the BLE connection cap is not a fault', () => {
  // Tesla caps simultaneous BLE connections. This is transient contention that clears on its own,
  // and a restart just queues up another reconnect against the same cap.
  const body = '{"response":{"result":false,"reason":"failed to connect to vehicle (A): the '
    + 'vehicle is already connected to the maximum number of BLE devices"}}';
  assert.equal(classify(503, body), '');
});

test('no response at all is a fault', () => {
  assert.equal(classify('000', ''), 'no-response');
});

test('a firmware wedge is named, so it escalates straight to an adapter reset', () => {
  const body = '{"response":{"result":false,"reason":"failed to connect to vehicle (A): ble: '
    + 'failed to scan for LRWYHCFJ5SC179194: Command Disallowed"}}';
  assert.equal(classify(503, body), 'firmware-wedge');
});

test('a dead adapter handle is named as a stale socket', () => {
  for (const reason of [
    "ble: failed to scan for LRWYHCFJ5SC179194: skt: can't read hci socket: broken pipe",
    "Failed to get vehicle data: send ATT request failed: can't write hci socket: broken pipe",
  ]) {
    assert.equal(classify(503, `{"response":{"reason":"${reason}"}}`), 'stale-socket', reason);
  }
});

test('the scan error that caused the eleven-hour outage is a fault', () => {
  // The regression this file exists for. Not on any fault list when it happened, and under the
  // old rules it read as healthy for eleven hours.
  const body = '{"response":{"result":false,"reason":"failed to connect to vehicle (A): ble: '
    + 'failed to scan for LRWYHCFJ5SC179194: received scan response 6b:e8:d6:55:39:76 with no '
    + 'associated Advertising Data packet"}}';
  assert.equal(classify(503, body), 'unhealthy');
});

test('errors never seen before are faults rather than silence', () => {
  // The actual point. None of these need their own rule, and a future one should not either.
  const unseen = [
    'failed to get body controller state: context deadline exceeded',
    "failed to connect to vehicle (A): ble: failed to enable device: can't init hci: no devices available",
    'failed to perform handshake with vehicle (B): context deadline exceeded',
    'something the proxy has never said before and nobody has written a rule for',
  ];
  for (const reason of unseen) {
    assert.equal(classify(503, `{"response":{"reason":"${reason}"}}`), 'unhealthy',
      `an unrecognised error must be treated as a fault, not waved through: ${reason}`);
  }
});

test('an empty body on a non-200 is still a fault', () => {
  // Degenerate case: nothing to match against at all must not fall through to healthy.
  assert.equal(classify(502, ''), 'unhealthy');
});
