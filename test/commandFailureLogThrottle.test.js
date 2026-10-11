/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The same failed command is logged once every five minutes, not once every tick.
//
// Found live 2026-10-12. The loop retried a failing stop every 10 seconds, and each failure
// wrote the same line: 133 of them in 22 minutes, burying everything else in the log without
// telling the owner anything the first line had not.
//
// Nothing is hidden: the count of repeats is reported on the next line. Digits are ignored when
// comparing, because the back-off message counts down ("retrying in 15s", "in 14s"), and
// different messages or different commands are never merged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-failthrottle-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const logger = require('../src/utils/logger');
const controller = require('../src/controller');
const chargingTesla = require('../src/services/charging/tesla');

const realNow = Date.now;
let clock;
let lines;
const origLog = logger.logEvent;

test.beforeEach(() => {
  clock = realNow();
  Date.now = () => clock;
  controller._cmdFailLog = new Map();
  lines = [];
  logger.logEvent = (type, msg) => { if (type === 'api_error') lines.push(msg); };
});
test.afterEach(() => { Date.now = realNow; logger.logEvent = origLog; });
test.after(() => {
  Date.now = realNow; logger.logEvent = origLog;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

const err = (m) => new Error(m);

test('133 identical failures over 22 minutes become five lines, not 133', () => {
  for (let i = 0; i < 133; i++) {
    controller._logCommandFailure('Stop charging failed', err('status 503: Command Disallowed'));
    clock += 10000;
  }
  assert.ok(lines.length <= 5, `got ${lines.length}`);
  assert.equal(lines[0], 'Stop charging failed: status 503: Command Disallowed');
  assert.match(lines[1], /\(\d+ identical failures since the last report\)$/, 'the repeats are counted, not hidden');
});

test('the counting-down back-off message is treated as one message', () => {
  controller._logCommandFailure('Stop charging failed', err('Bluetooth proxy is faulting - backing off, retrying in 15s'));
  for (const s of [14, 9, 4, 1]) {
    controller._logCommandFailure('Stop charging failed', err(`Bluetooth proxy is faulting - backing off, retrying in ${s}s`));
  }
  assert.equal(lines.length, 1);
});

test('different commands and different messages are never merged', () => {
  controller._logCommandFailure('Stop charging failed', err('a'));
  controller._logCommandFailure('Start charging failed', err('a'));
  controller._logCommandFailure('Stop charging failed', err('b'));
  assert.equal(lines.length, 3);
});

test('a failure that comes back after the window is reported again with its count', () => {
  for (let i = 0; i < 4; i++) controller._logCommandFailure('Set amps failed', err('x'));
  clock += 5 * 60 * 1000 + 1;
  controller._logCommandFailure('Set amps failed', err('x'));
  assert.deepEqual(lines, ['Set amps failed: x', 'Set amps failed: x (3 identical failures since the last report)']);
});

test('the memory stays bounded', () => {
  for (let i = 0; i < 200; i++) controller._logCommandFailure('Stop charging failed', err(`unique ${'x'.repeat(i)}`));
  assert.ok(controller._cmdFailLog.size <= 51);
});

test('an error with no message does not throw', () => {
  assert.doesNotThrow(() => controller._logCommandFailure('Stop charging failed', undefined));
  assert.doesNotThrow(() => controller._logCommandFailure('Stop charging failed', {}));
});

test('_safeStop reports through it', async () => {
  const orig = chargingTesla.stopCharging;
  chargingTesla.stopCharging = async () => { throw err('status 503: Command Disallowed'); };
  try {
    for (let i = 0; i < 30; i++) await controller._safeStop('VIN', 'tok', 'reason');
  } finally {
    chargingTesla.stopCharging = orig;
  }
  assert.equal(lines.length, 1, 'thirty failures, one line');
});

test('every command that is retried each tick uses it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  for (const label of ['Stop charging failed', 'Start charging failed', 'Charge restart failed', 'Set amps failed',
    'Set amps on resume failed', 'Hold step-down retry failed', 'Hold step-down failed']) {
    assert.ok(src.includes(`this._logCommandFailure('${label}', err)`), `${label} is throttled`);
    assert.ok(!src.includes("logger.logEvent('api_error', `" + label), `${label} is not logged directly any more`);
  }
});
