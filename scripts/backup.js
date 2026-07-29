#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// CLI backup - used directly (`npm run backup`) and by scripts/update.sh as
// the mandatory pre-update step. Writes a timestamped zip to
// ~/.solarcharge/backups/ by default, or to the directory/file passed as
// the first argument. Pass --encrypt to password-protect it (prompts for a
// password, or reads WATTSNATCH_BACKUP_PASSWORD for non-interactive use).

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const db = require('../src/db');
const { createBackupZip, backupFilename, DB_DIR } = require('../src/services/backup');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const args = process.argv.slice(2);
  const encrypt = args.includes('--encrypt');
  const arg = args.find((a) => a !== '--encrypt');

  let destPath;
  if (!arg) {
    destPath = path.join(DB_DIR, 'backups', backupFilename());
  } else if ((fs.existsSync(arg) && fs.statSync(arg).isDirectory()) || arg.endsWith('/') || arg.endsWith(path.sep)) {
    destPath = path.join(arg, backupFilename());
  } else {
    destPath = arg;
  }

  let password;
  if (encrypt) {
    password = process.env.WATTSNATCH_BACKUP_PASSWORD;
    if (!password) {
      password = await ask('Backup password: ');
      if (!password) {
        console.error('A password is required with --encrypt.');
        process.exit(1);
      }
    }
  }

  db.initDb();
  console.log('Creating backup...');
  const { path: written, sizeBytes } = await createBackupZip(destPath, password);
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`Backup written: ${written} (${sizeMb} MB)${encrypt ? ' [encrypted]' : ''}`);
}

main().catch((err) => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
