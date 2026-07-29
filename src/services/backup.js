/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const AdmZip = require('adm-zip');
const db = require('../db');
const { encryptBuffer, decryptBuffer } = require('../utils/backupCrypto');

const DB_DIR = path.join(os.homedir(), '.solarcharge');
const DB_PATH = path.join(DB_DIR, 'solarcharge.db');
const KEYS_DIR = path.join(__dirname, '..', '..', 'keys');

function timestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function backupFilename(d = new Date(), encrypted = false) {
  return `wattsnatch-backup-${timestampForFilename(d)}.zip${encrypted ? '.enc' : ''}`;
}

// Builds the backup zip's raw (unencrypted) bytes: DB safely hot-copied via
// better-sqlite3's .backup(), the keys/ folder, and a manifest.
async function buildZipBuffer() {
  const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-backup-db-${Date.now()}.sqlite`);

  // .backup() produces a consistent snapshot even under WAL mode / concurrent
  // writes, unlike a raw fs.copyFile of the .db file which can miss data
  // still sitting in the -wal file.
  await db.getDb().backup(tmpDbPath);

  try {
    const zip = new AdmZip();
    zip.addLocalFile(tmpDbPath, '', 'solarcharge.db');

    if (fs.existsSync(KEYS_DIR)) {
      for (const entry of fs.readdirSync(KEYS_DIR)) {
        if (entry === '.gitkeep') continue;
        const full = path.join(KEYS_DIR, entry);
        if (fs.statSync(full).isFile()) {
          zip.addLocalFile(full, 'keys');
        }
      }
    }

    const pkg = require('../../package.json');
    const manifest = {
      app: 'wattsnatch',
      version: pkg.version,
      created_at: new Date().toISOString(),
      hostname: os.hostname(),
      note: 'Contains your WattSnatch database and local keys/certs. Does NOT contain OS-keychain-stored credentials (myenergi/MELCloud/iCloud), which stay on this machine and are unaffected by restoring this backup.',
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    return zip.toBuffer();
  } finally {
    fs.rm(tmpDbPath, { force: true }, () => {});
  }
}

// Builds a backup zip and writes it to destZipPath. If `password` is given,
// the zip bytes are encrypted (AES-256-GCM, see utils/backupCrypto.js) and
// ".enc" is appended to the written filename - the returned `path` reflects
// this. Returns { path, sizeBytes }.
async function createBackupZip(destZipPath, password) {
  let buffer = await buildZipBuffer();
  if (password) {
    buffer = encryptBuffer(buffer, password);
    if (!destZipPath.endsWith('.enc')) destZipPath += '.enc';
  }

  fs.mkdirSync(path.dirname(destZipPath), { recursive: true });
  fs.writeFileSync(destZipPath, buffer);

  return { path: destZipPath, sizeBytes: buffer.length };
}

// Same as createBackupZip but returns an in-memory Buffer instead of writing
// to disk - used by the HTTP download route so nothing is left behind on
// the server's filesystem after the request completes.
async function createBackupZipBuffer(password) {
  const buffer = await buildZipBuffer();
  return password ? encryptBuffer(buffer, password) : buffer;
}

// Decrypts a backup buffer produced with a password. Throws with a clear
// message if the password is wrong or the data is corrupted.
function decryptBackupBuffer(buffer, password) {
  return decryptBuffer(buffer, password);
}

const AUTO_BACKUP_DIR = path.join(DB_DIR, 'backups', 'auto');

const DAY_MS  = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DAILY_RETENTION_DAYS = 7;    // keep every automatic backup from the last week
const WEEKLY_RETENTION_WEEKS = 12; // then thin to one per week for ~3 months

// Deletes automatic backups that have aged past the retention policy:
// every backup from the last 7 days is kept; from 7 days to ~12 weeks old,
// only the single newest backup in each calendar week is kept; anything
// older than that is deleted. Pure filesystem function (mtime-based) so it
// can be tested against synthetic files without touching the real DB.
// Returns { kept, deleted }.
function pruneAutoBackups(dir = AUTO_BACKUP_DIR, now = Date.now()) {
  if (!fs.existsSync(dir)) return { kept: 0, deleted: 0 };

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const full = path.join(dir, f);
      return { file: f, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  const keep = new Set();
  const seenWeeks = new Set();

  for (const f of files) {
    const ageMs = now - f.mtime;
    if (ageMs <= DAILY_RETENTION_DAYS * DAY_MS) {
      keep.add(f.file);
      continue;
    }
    if (ageMs <= WEEKLY_RETENTION_WEEKS * WEEK_MS) {
      const weekKey = Math.floor(f.mtime / WEEK_MS);
      if (!seenWeeks.has(weekKey)) {
        seenWeeks.add(weekKey);
        keep.add(f.file); // newest backup seen so far in this week (files are newest-first)
      }
    }
    // older than WEEKLY_RETENTION_WEEKS: not kept, falls through to deletion below
  }

  let deleted = 0;
  for (const f of files) {
    if (!keep.has(f.file)) {
      fs.rmSync(f.full, { force: true });
      deleted++;
    }
  }

  return { kept: keep.size, deleted };
}

function getAutoBackupStatus(dir = AUTO_BACKUP_DIR) {
  if (!fs.existsSync(dir)) return { count: 0, totalSizeBytes: 0, newest: null, oldest: null };
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { file: f, sizeBytes: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return {
    count: files.length,
    totalSizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    newest: files[0]?.mtime || null,
    oldest: files[files.length - 1]?.mtime || null,
  };
}

module.exports = {
  createBackupZip, createBackupZipBuffer, decryptBackupBuffer, backupFilename,
  pruneAutoBackups, getAutoBackupStatus,
  DB_PATH, KEYS_DIR, DB_DIR, AUTO_BACKUP_DIR,
};
