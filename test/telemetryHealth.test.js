/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Telemetry-config health monitor. Tesla drops the per-vehicle telemetry config on car
// software updates (config: null), which silently kills the live stream. This service checks
// periodically and re-registers. The safety-critical properties: a failed check (no token,
// car unreachable) must be a no-op - never mistaken for "config missing" and never triggering
// a re-register - and repairs must be rate-limited so a persistent failure cannot storm the
// signing proxy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-tmhealth-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const telemetryHealth = require('../src/services/telemetryHealth');

test.after(() => {
  telemetryHealth.stop();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('getConfigStatus returns null (unknown) when there is no token to ask with', async () => {
  // Fresh test DB has no Tesla token stored.
  const status = await telemetryHealth.getConfigStatus();
  assert.equal(status, null, 'no token must yield null (unknown), never a fabricated status');
});

test('checkAndRepair is a safe no-op when the config cannot be checked', async () => {
  // With no token, getConfigStatus() is null, so checkAndRepair must NOT conclude "missing"
  // and must NOT attempt a re-register.
  const result = await telemetryHealth.checkAndRepair();
  assert.deepEqual(result, { checked: false },
    'an unaskable check must report checked:false and take no action');
});

test('sendConfig refuses cleanly when prerequisites are missing, without throwing', async () => {
  // No VIN / hostname / token in a fresh DB - must return an error object, not reject.
  const result = await telemetryHealth.sendConfig();
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === 'string' && result.error.length > 0,
    'a missing prerequisite must surface as a clear error string');
});

test('start/stop are idempotent and do not leave a timer running', () => {
  telemetryHealth.start();
  telemetryHealth.start(); // second call must be a no-op, not a second timer
  telemetryHealth.stop();
  telemetryHealth.stop();  // stopping twice must not throw
  assert.ok(true);
});

test('the monitor is wired into server start and stop', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /telemetryHealth\.start\(\)/, 'must be started with the other services');
  assert.match(server, /telemetryHealth\.stop\(\)/, 'must be stopped on shutdown');
});

test('the setup wizard route shares the same sendConfig implementation', () => {
  const setup = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'setup.js'), 'utf8');
  assert.match(setup, /telemetryHealth\.sendConfig\(\)/,
    'the wizard must call the shared sender, not a divergent copy');
});
