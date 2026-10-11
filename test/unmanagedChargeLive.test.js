/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A charge the controller did not start, and could not stop, was invisible to it.
//
// Found live 2026-10-12. Tesla starts charging on plug-in. The controller tried to stop that
// grid charge and could not, because the Bluetooth proxy was stuck. The car then drew 4.3 kW
// with the battery visibly rising, but the app only counted a charge as real once it had
// started a session, and it never had. So it recorded the car as 0 W, counted the 4.3 kW as
// house load, and calculated a surplus of minus 1.1 kW when the real figure was about plus
// 3.2 kW. The dashboard said the car was not charging while it visibly was.
//
// The guard behind this exists for a reason: a frozen "Charging" flag (stale stream, car away
// or asleep) fabricated charging sessions on 2026-09-02. So an unmanaged charge must be proven
// by the battery actually rising, never by a frame merely looking fresh.
//
// Pinned here:
//   - the first sighting is only a baseline and does not count
//   - a rising battery makes it live, and it stays live for the same 25 minute window
//   - a frozen battery never does, however long "Charging" is reported
//   - the old high-water mark is forgotten when not charging, so a charge that starts below
//     where the last one ended can still count
//   - sessions behave exactly as before
// Runs against a throwaway DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-unmanaged-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const controller = require('../src/controller');

const realNow = Date.now;
let clock;
const CS = { charging_state: 'Charging' };      // any non-null object: the car has reported

test.beforeEach(() => {
  clock = realNow();
  Date.now = () => clock;
  controller.currentSessionId = null;
  controller._chargeProgressBattery = null;
  controller._chargeProgressAt = 0;
});
test.afterEach(() => { Date.now = realNow; });
test.after(() => {
  Date.now = realNow;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

const live = (charging, state, pct) => controller._updateChargeProgress(charging, state, pct);
const MIN = 60 * 1000;

test('the live morning: no session, 71% and rising, becomes live once the battery moves', () => {
  assert.equal(live(true, CS, 71.14), false, 'first sighting is only a baseline');
  clock += 1 * MIN;
  assert.equal(live(true, CS, 71.14), false, 'no movement yet');
  clock += 1 * MIN;
  assert.equal(live(true, CS, 71.21), true, 'the battery rose, so the charge is real');
});

test('a frozen Charging flag never becomes live, however long it lasts', () => {
  live(true, CS, 55);
  for (let i = 0; i < 60; i++) {
    clock += 1 * MIN;
    assert.equal(live(true, CS, 55), false, `minute ${i + 1}`);
  }
});

test('it stays live for the same 25 minute window a session gets, then lapses', () => {
  live(true, CS, 60);
  clock += 1 * MIN; assert.equal(live(true, CS, 60.2), true);
  clock += 24 * MIN; assert.equal(live(true, CS, 60.2), true, 'just inside the window');
  clock += 2 * MIN; assert.equal(live(true, CS, 60.2), false, 'the battery stopped moving, so it lapses');
  clock += 1 * MIN; assert.equal(live(true, CS, 60.4), true, 'and recovers if it moves again');
});

test('the old high-water mark is forgotten when not charging', () => {
  live(true, CS, 79); clock += MIN; live(true, CS, 80);       // a previous charge ended at 80%
  live(false, { charging_state: 'Complete' }, 80);             // car says it is done
  assert.equal(controller._chargeProgressBattery, null);
  assert.equal(live(true, CS, 71), false, 'a new charge starts from its own baseline');
  clock += MIN;
  assert.equal(live(true, CS, 71.1), true, 'without this it would have to climb past 80% first');
});

test('a car with no reported state leaves an unmanaged charge undecided, not live', () => {
  assert.equal(live(false, null, 0), false);
  assert.equal(controller._chargeProgressAt, 0);
});

test('with a session, behaviour is unchanged: live from the start, held by progress', () => {
  controller.currentSessionId = 42;
  assert.equal(live(true, CS, 50), true, 'a session starts live');
  clock += 10 * MIN;
  assert.equal(live(true, CS, 50), true);
  clock += 16 * MIN;
  assert.equal(live(true, CS, 50), false, 'frozen past 25 minutes lapses');
});

test('with a session, a car that goes quiet does not reset the progress clock', () => {
  controller.currentSessionId = 42;
  live(true, CS, 50);
  const at = controller._chargeProgressAt;
  clock += 5 * MIN;
  live(false, null, 0);                                         // asleep: no state
  assert.equal(controller._chargeProgressAt, at, 'untouched, exactly as before');
  assert.equal(controller._chargeProgressBattery, 50);
});

test('the loop uses the method, and the constant lives at module level for both users', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  assert.match(src, /const chargeConfirmedLive = this\._updateChargeProgress\(currentlyCharging, chargeState, batteryPct\);/);
  assert.match(src, /^const PHANTOM_NO_PROGRESS_MS = 25 \* 60 \* 1000;$/m, 'one definition, at module level');
  assert.equal((src.match(/const PHANTOM_NO_PROGRESS_MS/g) || []).length, 1);
});
