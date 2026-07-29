/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-login-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const {
  hashPassword, verifyPassword,
  checkLoginLockout, recordFailedLogin, recordSuccessfulLogin,
} = require('../src/middleware/sessionAuth');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('hashPassword/verifyPassword round-trip, and rejects the wrong password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword('correct-horse-battery-staple', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('no lockout until 5 consecutive failures', () => {
  for (let i = 1; i <= 4; i++) {
    assert.equal(checkLoginLockout().locked, false, `should not be locked before attempt ${i}`);
    const { lockoutMs } = recordFailedLogin();
    assert.equal(lockoutMs, 0, `attempt ${i} should not trigger a lockout`);
  }
});

test('5th consecutive failure locks out for 30 seconds', () => {
  const { attempts, lockoutMs } = recordFailedLogin(); // 5th failure (4 recorded in previous test)
  assert.equal(attempts, 5);
  assert.equal(lockoutMs, 30 * 1000);

  const status = checkLoginLockout();
  assert.equal(status.locked, true);
  assert.ok(status.remainingMs > 0 && status.remainingMs <= 30 * 1000);
});

test('lockout escalates at 8 and 12 failures', () => {
  // Force the lockout to have already expired so recordFailedLogin isn't
  // gated by checkLoginLockout (that's the caller's job, not this function's).
  db.setSetting('login_locked_until', '0');

  let result;
  for (let i = 6; i <= 7; i++) result = recordFailedLogin();
  assert.equal(result.attempts, 7);
  assert.equal(result.lockoutMs, 30 * 1000, 'still in the 5-7 tier');

  result = recordFailedLogin(); // 8th
  assert.equal(result.attempts, 8);
  assert.equal(result.lockoutMs, 5 * 60 * 1000, '8th failure enters the 5-minute tier');

  db.setSetting('login_locked_until', '0');
  for (let i = 9; i <= 11; i++) result = recordFailedLogin();
  assert.equal(result.lockoutMs, 5 * 60 * 1000, 'still in the 8-11 tier');

  db.setSetting('login_locked_until', '0');
  result = recordFailedLogin(); // 12th
  assert.equal(result.attempts, 12);
  assert.equal(result.lockoutMs, 30 * 60 * 1000, '12th failure enters the 30-minute tier');
});

test('a successful login fully resets the failure counter and any active lockout', () => {
  recordSuccessfulLogin();
  const status = checkLoginLockout();
  assert.equal(status.locked, false);
  assert.equal(db.getSetting('login_failed_attempts'), '0');
});

test('checkLoginLockout does not increment the counter - checking is not itself a failed attempt', () => {
  db.setSetting('login_failed_attempts', '0');
  db.setSetting('login_locked_until', '0');
  checkLoginLockout();
  checkLoginLockout();
  checkLoginLockout();
  assert.equal(db.getSetting('login_failed_attempts'), '0');
});
