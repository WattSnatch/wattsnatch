#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Restores a backup zip created by `npm run backup` (or the Settings page
// download). Destructive: overwrites the current database and keys/ folder.
// Always takes a safety snapshot of the CURRENT state first, so a restore
// itself is undoable.

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const readline = require('readline');
const AdmZip = require('adm-zip');

const { DB_PATH, KEYS_DIR, DB_DIR, backupFilename, decryptBackupBuffer } = require('../src/services/backup');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 800 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function main() {
  const zipPath = process.argv[2];
  const autoYes = process.argv.includes('--yes');

  if (!zipPath) {
    console.error('Usage: npm run restore -- <path-to-backup.zip> [--yes]');
    process.exit(1);
  }
  if (!fs.existsSync(zipPath)) {
    console.error(`Backup file not found: ${zipPath}`);
    process.exit(1);
  }

  let zipBuffer = fs.readFileSync(zipPath);
  if (zipPath.endsWith('.enc')) {
    const password = process.env.WATTSNATCH_BACKUP_PASSWORD || await ask('Backup password: ');
    try {
      zipBuffer = decryptBackupBuffer(zipBuffer, password);
    } catch (err) {
      console.error(`Could not decrypt backup: ${err.message}`);
      process.exit(1);
    }
  }

  const zip = new AdmZip(zipBuffer);
  const manifestEntry = zip.getEntry('manifest.json');
  const dbEntry = zip.getEntry('solarcharge.db');
  if (!manifestEntry || !dbEntry) {
    console.error('This does not look like a WattSnatch backup (missing manifest.json or solarcharge.db).');
    process.exit(1);
  }
  const manifest = JSON.parse(zip.readAsText(manifestEntry));
  console.log(`Backup: v${manifest.version}, created ${manifest.created_at}, from host "${manifest.hostname}"`);

  const portOpen = await checkPortInUse(3001);
  if (portOpen) {
    console.log('\n⚠ WattSnatch still appears to be running on port 3001.');
    console.log('  Stop it first (or restore will be overwritten by the running process on its next write).\n');
  }

  if (!autoYes) {
    const answer = await ask('This will REPLACE your current database and keys/ folder. A safety snapshot of the current state is taken first. Continue? [y/N] ');
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  // Safety snapshot of current state before touching anything, so a restore
  // itself can always be undone.
  try {
    const { createBackupZip } = require('../src/services/backup');
    const db = require('../src/db');
    db.initDb();
    const safetyPath = path.join(DB_DIR, 'backups', `pre-restore-${backupFilename().replace('wattsnatch-backup-', '')}`);
    const { path: written } = await createBackupZip(safetyPath);
    console.log(`Safety snapshot of current state saved to: ${written}`);
  } catch (err) {
    console.log(`Could not take a safety snapshot of the current state (${err.message}) - continuing anyway.`);
  }

  // Remove stale WAL/SHM sidecar files so the restored .db isn't paired
  // with leftover write-ahead-log state from the old database.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = DB_PATH + suffix;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, dbEntry.getData());
  fs.chmodSync(DB_PATH, 0o600);
  console.log(`Restored database → ${DB_PATH}`);

  const keyEntries = zip.getEntries().filter((e) => e.entryName.startsWith('keys/') && !e.isDirectory);
  if (keyEntries.length > 0) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    for (const entry of keyEntries) {
      const destFile = path.join(KEYS_DIR, path.basename(entry.entryName));
      fs.writeFileSync(destFile, entry.getData());
    }
    console.log(`Restored ${keyEntries.length} file(s) → ${KEYS_DIR}`);
  }

  console.log('\nRestore complete. Restart WattSnatch now:');
  console.log('  macOS:   launchctl kickstart -k gui/$(id -u)/com.YOURUSERNAME.wattsnatch');
  console.log('  Linux:   sudo systemctl restart wattsnatch');
  console.log('  Windows: pm2 restart wattsnatch');
}

main().catch((err) => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
