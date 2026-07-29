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

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-backup-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const backup = require('../src/services/backup');
const AdmZip = require('adm-zip');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('createBackupZip produces a zip containing a valid, openable database and a manifest', async () => {
  db.setSetting('electricity_rate_aud', '0.42'); // a distinctive marker value

  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wattsnatch-backup-test-'));
  const destZip = path.join(destDir, 'test-backup.zip');

  const { path: written, sizeBytes } = await backup.createBackupZip(destZip);
  assert.equal(written, destZip);
  assert.ok(sizeBytes > 0, 'backup zip should not be empty');
  assert.ok(fs.existsSync(destZip), 'backup zip file should exist on disk');

  const zip = new AdmZip(destZip);
  const manifestEntry = zip.getEntry('manifest.json');
  const dbEntry = zip.getEntry('solarcharge.db');
  assert.ok(manifestEntry, 'manifest.json should be present');
  assert.ok(dbEntry, 'solarcharge.db should be present');

  const manifest = JSON.parse(zip.readAsText(manifestEntry));
  assert.equal(manifest.app, 'wattsnatch');
  assert.ok(manifest.created_at, 'manifest should have a created_at timestamp');

  // Verify the embedded database is actually openable and has our marker value.
  const extractedDbPath = path.join(destDir, 'extracted.db');
  fs.writeFileSync(extractedDbPath, dbEntry.getData());
  const Database = require('better-sqlite3');
  const extractedDb = new Database(extractedDbPath, { readonly: true });
  const row = extractedDb.prepare("SELECT value FROM settings WHERE key = 'electricity_rate_aud'").get();
  extractedDb.close();
  assert.equal(row.value, '0.42');

  fs.rmSync(destDir, { recursive: true, force: true });
});

test('createBackupZipBuffer produces the same content as createBackupZip, in memory', async () => {
  const buffer = await backup.createBackupZipBuffer();
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);

  const zip = new AdmZip(buffer);
  assert.ok(zip.getEntry('solarcharge.db'));
  assert.ok(zip.getEntry('manifest.json'));
});

test('createBackupZipBuffer with a password returns encrypted bytes that decrypt back to a valid zip', async () => {
  const encrypted = await backup.createBackupZipBuffer('hunter2');
  assert.ok(Buffer.isBuffer(encrypted));

  // Encrypted output should not be openable as a zip directly - it's opaque
  // ciphertext, not the zip format.
  assert.throws(() => new AdmZip(encrypted));

  const decrypted = backup.decryptBackupBuffer(encrypted, 'hunter2');
  const zip = new AdmZip(decrypted);
  assert.ok(zip.getEntry('solarcharge.db'));
  assert.ok(zip.getEntry('manifest.json'));
});

test('decryptBackupBuffer rejects the wrong password', async () => {
  const encrypted = await backup.createBackupZipBuffer('correct-password');
  assert.throws(() => backup.decryptBackupBuffer(encrypted, 'wrong-password'), /Wrong password/);
});

test('createBackupZip with a password appends .enc to the written filename', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wattsnatch-backup-enc-test-'));
  const destZip = path.join(destDir, 'test-backup.zip');

  const { path: written } = await backup.createBackupZip(destZip, 's3cret');
  assert.equal(written, destZip + '.enc');
  assert.ok(fs.existsSync(written));
  assert.ok(!fs.existsSync(destZip), 'the unencrypted path should not have been written');

  const decrypted = backup.decryptBackupBuffer(fs.readFileSync(written), 's3cret');
  const zip = new AdmZip(decrypted);
  assert.ok(zip.getEntry('solarcharge.db'));

  fs.rmSync(destDir, { recursive: true, force: true });
});

test('pruneAutoBackups: keeps every backup from the last 7 days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wattsnatch-prune-test-'));
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  for (const ageDays of [0, 1, 3, 5, 7]) {
    const full = path.join(dir, `backup-age${ageDays}.zip`);
    fs.writeFileSync(full, 'x');
    const mtime = new Date(now - ageDays * DAY);
    fs.utimesSync(full, mtime, mtime);
  }

  const result = backup.pruneAutoBackups(dir, now);
  assert.equal(result.kept, 5);
  assert.equal(result.deleted, 0);
  assert.equal(fs.readdirSync(dir).length, 5);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneAutoBackups: thins backups older than a week to one per calendar week, drops anything past 12 weeks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wattsnatch-prune-test-'));
  const DAY = 24 * 60 * 60 * 1000;
  // Fixed, week-boundary-aligned "now" instead of Date.now() - pruneAutoBackups buckets
  // by Math.floor(mtime / WEEK_MS), so which absolute week each file falls into (and
  // therefore the exact kept count) shifts depending on what day this runs. A fixed
  // anchor makes the expected count exact and reproducible instead of a guessed range.
  const now = Date.parse('2024-01-04T00:00:00.000Z');

  const ages = [];
  for (let d = 0; d <= 20; d++) ages.push(d);
  for (let d = 25; d <= 100; d += 3) ages.push(d);

  for (const ageDays of ages) {
    const full = path.join(dir, `backup-age${ageDays}.zip`);
    fs.writeFileSync(full, 'x');
    const mtime = new Date(now - ageDays * DAY);
    fs.utimesSync(full, mtime, mtime);
  }

  const result = backup.pruneAutoBackups(dir, now);
  const remaining = fs.readdirSync(dir).map((f) => {
    const stat = fs.statSync(path.join(dir, f));
    return Math.round((now - stat.mtimeMs) / DAY);
  });

  // Daily zone (0-7 days old) is always kept in full: 8 files.
  assert.equal(remaining.filter((age) => age <= 7).length, 8);
  // Weekly zone: with `now` fixed at a week boundary, exactly 19 total survive
  // (8 daily + 11 weekly-thinned) - deterministic, not day-of-week dependent.
  assert.equal(result.kept, 19);
  assert.equal(result.kept + result.deleted, ages.length);
  assert.ok(Math.max(...remaining) < 84, 'nothing older than 12 weeks should survive');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('getAutoBackupStatus reports an empty state correctly for a directory that does not exist yet', () => {
  const status = backup.getAutoBackupStatus(path.join(os.tmpdir(), 'wattsnatch-never-created-' + Date.now()));
  assert.deepEqual(status, { count: 0, totalSizeBytes: 0, newest: null, oldest: null });
});

test('getAutoBackupStatus sums size and finds newest/oldest correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wattsnatch-status-test-'));
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  fs.writeFileSync(path.join(dir, 'a.zip'), 'x'.repeat(100));
  fs.utimesSync(path.join(dir, 'a.zip'), new Date(now - 2 * DAY), new Date(now - 2 * DAY));
  fs.writeFileSync(path.join(dir, 'b.zip'), 'x'.repeat(50));
  fs.utimesSync(path.join(dir, 'b.zip'), new Date(now), new Date(now));

  const status = backup.getAutoBackupStatus(dir);
  assert.equal(status.count, 2);
  assert.equal(status.totalSizeBytes, 150);
  assert.ok(Math.abs(status.newest - now) < 1000);

  fs.rmSync(dir, { recursive: true, force: true });
});
