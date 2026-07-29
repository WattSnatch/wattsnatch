#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Recovers a forgotten dashboard password. Requires filesystem access to the
// machine WattSnatch runs on (same trust level as editing the database
// directly) - there is no in-app "forgot password" flow by design, since
// that would mean either emailing a reset link (this app has no mail
// sending capability) or a security question, both weaker than "you have a
// terminal on the box".
//
// Usage:
//   npm run reset-password -- <new-password>   # set a new password directly
//   npm run reset-password -- --clear          # remove the password entirely
//                                                (dashboard becomes open,
//                                                 same as a fresh install)

const readline = require('readline');
const db = require('../src/db');
const { hashPassword } = require('../src/middleware/sessionAuth');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  db.initDb();
  const arg = process.argv[2];

  if (arg === '--clear') {
    if (!db.getSetting('login_password_hash')) {
      console.log('No dashboard password is set - nothing to clear.');
      return;
    }
    const answer = await ask('This removes the dashboard password entirely - anyone who can reach the dashboard will get straight in, same as a fresh install. Continue? [y/N] ');
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
    db.setSetting('login_password_hash', '');
    db.setSetting('login_failed_attempts', '0');
    db.setSetting('login_locked_until', '0');
    console.log('Dashboard password cleared. Set a new one from Settings → Security next time you sign in.');
    return;
  }

  let newPassword = arg;
  if (!newPassword) {
    newPassword = await ask('New dashboard password (min 8 characters): ');
  }
  if (!newPassword || newPassword.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await hashPassword(newPassword);
  db.setSetting('login_password_hash', hash);
  // Also clears any active lockout, so a legitimate recovery isn't blocked
  // by the very lockout that (most likely) motivated running this script.
  db.setSetting('login_failed_attempts', '0');
  db.setSetting('login_locked_until', '0');
  console.log('Dashboard password updated. Restart WattSnatch is not required - takes effect on your next sign-in.');
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
