/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The BLE read timeout must stay above the proxy's own scan timeout.
//
// A cold BLE read cannot answer until the proxy has scanned for the car, and the car
// only advertises intermittently, so that scan can legitimately run for the proxy's
// full scanTimeout before it either finds the car or reports it out of range. If our
// client gives up first, we cancel a scan that was still working. The proxy logs
// "context canceled" and we see a plain request timeout, which reads exactly like the
// proxy being stuck when nothing is wrong at all.
//
// That is not hypothetical. It shipped: the timeouts were 20s and 15s against a 30s
// scan, and the result was that a car arriving home took twelve minutes to reconnect,
// because every poll aborted the scan before it could succeed and the next poll had to
// start over. It was also misdiagnosed twice as a wedged proxy before the arithmetic
// was noticed.
//
// bleStatePolling.test.js proves the behaviour end to end by making a real server wait
// 32 seconds. This asserts the same invariant directly and instantly, so the ordering
// cannot be quietly reversed by an edit that never runs the slow test - which is the
// realistic way it would come back, since a smaller number looks harmless in review.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-bletimeout-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const tesla = require('../src/services/tesla');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

test('the BLE read timeout clears the proxy scan timeout', () => {
  assert.ok(
    tesla.BLE_READ_TIMEOUT_MS > tesla.BLE_PROXY_SCAN_TIMEOUT_MS,
    `read timeout ${tesla.BLE_READ_TIMEOUT_MS}ms must exceed the proxy's `
    + `${tesla.BLE_PROXY_SCAN_TIMEOUT_MS}ms scan timeout, or a cold scan gets cancelled `
    + 'by us before it can finish and the car looks unreachable while it is sitting there',
  );
});

test('it clears it by enough margin to cover the round trip, not by a hair', () => {
  const margin = tesla.BLE_READ_TIMEOUT_MS - tesla.BLE_PROXY_SCAN_TIMEOUT_MS;
  assert.ok(margin >= 2000,
    `only ${margin}ms of headroom: the proxy still has to serialise and return its answer `
    + 'after the scan ends, so a margin this thin will start cancelling scans that did work');
});

test('the scan timeout still matches what the proxy is actually configured with', () => {
  // If the proxy's docker-compose.yml scanTimeout is ever changed, this constant has to
  // change with it, otherwise the invariant above is measuring against a number that is
  // no longer true and the read timeout could silently drop back under the real scan.
  assert.equal(tesla.BLE_PROXY_SCAN_TIMEOUT_MS, 30000,
    'update this alongside scanTimeout in the proxy docker-compose.yml');
});
