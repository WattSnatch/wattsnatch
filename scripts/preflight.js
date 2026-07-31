#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Checks the machine WattSnatch is about to run on for every failure mode
// that's ever actually bitten a real install, before the setup wizard
// starts - rather than discovering them one at a time mid-install with a
// different confusing error each time. Deliberately avoids requiring
// src/db.js or anything else that itself depends on the native modules
// being checked here, so a broken native module reports cleanly instead of
// crashing this script before it can say why.
//
// Usage: npm run preflight
// Exit code 0 if everything passes, 1 if anything needs attention -
// scriptable/CI-friendly, and the exit code is what AGENTS.md tells an
// agent to check before proceeding with setup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const https = require('https');
const { execSync } = require('child_process');

const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let hasFailure = false;
let hasWarning = false;
const results = [];

function pass(label, detail) { results.push({ icon: PASS, label, detail }); }
function warn(label, detail) { results.push({ icon: WARN, label, detail }); hasWarning = true; }
function fail(label, detail) { results.push({ icon: FAIL, label, detail }); hasFailure = true; }

// ── Node version ─────────────────────────────────────────────────────────────

function checkNodeVersion() {
  let required = '18.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    if (pkg.engines && pkg.engines.node) required = pkg.engines.node.replace(/^[>=^~]+/, '');
  } catch (_e) { /* fall back to the hardcoded default above */ }

  const current = process.versions.node;
  const [curMajor] = current.split('.').map(Number);
  const [reqMajor] = required.split('.').map(Number);

  if (curMajor >= reqMajor) {
    pass('Node.js version', `${current} (need ${required} or later)`);
  } else {
    fail('Node.js version', `${current} is too old - need ${required} or later. Install a current LTS from nodejs.org.`);
  }
}

// ── Native modules ────────────────────────────────────────────────────────────
// better-sqlite3, zeromq, and keytar all compile native code against the
// exact Node version running `npm install` - the single most common install
// failure, and the one that produces the most confusing error deep inside
// node-gyp or a NODE_MODULE_VERSION mismatch at runtime.

function checkNativeModule(name, { required = true, linuxNote = null } = {}) {
  try {
    require(name);
    pass(`Native module: ${name}`, 'loads correctly');
  } catch (err) {
    const msg = err.message || String(err);
    const isAbiMismatch = /NODE_MODULE_VERSION|was compiled against/.test(msg);
    const isMissingBinary = /Cannot find module|Could not locate the bindings file/.test(msg);

    let hint;
    if (isAbiMismatch) {
      hint = `compiled for a different Node version than what's currently running - run "npm rebuild" and try again`;
    } else if (isMissingBinary) {
      hint = `native binary missing - run "npm install" again (needs a C/C++ build toolchain if no prebuilt binary exists for your platform)`;
    } else {
      hint = msg.split('\n')[0];
    }
    if (linuxNote && process.platform === 'linux') hint += `. ${linuxNote}`;

    if (required) {
      fail(`Native module: ${name}`, hint);
    } else {
      warn(`Native module: ${name}`, `${hint} (optional - only needed for some integrations)`);
    }
  }
}

// ── Build tools (only worth checking if a native module actually failed) ────

function checkBuildTools() {
  const compilers = ['cc', 'gcc', 'clang'];
  const found = compilers.find((c) => {
    try { execSync(`which ${c}`, { stdio: 'ignore' }); return true; } catch (_e) { return false; }
  });
  if (found) {
    pass('C/C++ build toolchain', `found (${found})`);
  } else {
    const installHint = process.platform === 'darwin'
      ? 'run "xcode-select --install"'
      : process.platform === 'linux'
        ? 'run "sudo apt install build-essential python3" (Debian/Ubuntu) or your distro\'s equivalent'
        : 'install a C/C++ compiler for your platform';
    fail('C/C++ build toolchain', `not found - ${installHint}, then "npm install" again`);
  }
}

// ── keytar functional check (credential storage for MELCloud/MelView/iCloud) ─

async function checkKeytarFunctional() {
  let keytar;
  try {
    keytar = require('keytar');
  } catch (_e) {
    // Already reported by checkNativeModule above - don't double-report.
    return;
  }
  try {
    // Harmless round-trip against a throwaway account name - proves the
    // underlying keyring is actually reachable, not just that the native
    // module loaded.
    await keytar.setPassword('WattSnatch-preflight-check', 'test', 'test');
    await keytar.deletePassword('WattSnatch-preflight-check', 'test');
    pass('Credential storage (keytar)', 'OS keychain/keyring is reachable');
  } catch (err) {
    const linuxNote = process.platform === 'linux'
      ? ' On Linux this needs libsecret and a running keyring service (e.g. gnome-keyring) - install with "sudo apt install libsecret-1-0", or skip MELCloud/MelView/iCloud Calendar if you don\'t need them.'
      : '';
    warn('Credential storage (keytar)', `native module loaded but the keyring isn't reachable (${err.message}).${linuxNote} Only affects MELCloud, MelView, and iCloud Calendar - everything else works fine without it.`);
  }
}

// ── Port availability ─────────────────────────────────────────────────────────

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        fail(`Port ${port}`, 'already in use - stop whatever is using it, or set PORT to something else before starting WattSnatch');
      } else {
        warn(`Port ${port}`, `could not check (${err.message})`);
      }
      resolve();
    });
    server.once('listening', () => {
      server.close(() => {
        pass(`Port ${port}`, 'available');
        resolve();
      });
    });
    server.listen(port, '0.0.0.0');
  });
}

// ── Filesystem write access ───────────────────────────────────────────────────

function checkWritable(dirPath, label) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.preflight-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    pass(label, dirPath);
  } catch (err) {
    fail(label, `${dirPath} - ${err.message}`);
  }
}

// ── mDNS (Bonjour/Avahi) - used for automatic Enphase gateway discovery ──────

function checkMdns() {
  if (process.platform === 'darwin') {
    pass('mDNS (gateway auto-discovery)', 'Bonjour is built into macOS');
    return;
  }
  if (process.platform === 'linux') {
    try {
      execSync('which avahi-daemon', { stdio: 'ignore' });
      pass('mDNS (gateway auto-discovery)', 'avahi-daemon found');
    } catch (_e) {
      warn('mDNS (gateway auto-discovery)', 'avahi-daemon not found - "Find automatically" for the Enphase gateway may not work. Install with "sudo apt install avahi-daemon", or just enter the gateway\'s IP address manually during setup.');
    }
    return;
  }
  warn('mDNS (gateway auto-discovery)', `not checked on ${process.platform} - if "Find automatically" fails during setup, enter the gateway's IP address manually`);
}

// ── Internet connectivity ─────────────────────────────────────────────────────

function checkInternet() {
  return new Promise((resolve) => {
    const req = https.get('https://api.github.com', { timeout: 5000 }, (res) => {
      res.resume();
      pass('Internet connectivity', `reached api.github.com (HTTP ${res.statusCode})`);
      resolve();
    });
    req.on('timeout', () => { req.destroy(); warn('Internet connectivity', 'timed out reaching api.github.com - Tesla, Enphase, and other cloud integrations need outbound internet access'); resolve(); });
    req.on('error', (err) => { warn('Internet connectivity', `could not reach api.github.com (${err.message})`); resolve(); });
  });
}

// ── Run everything ────────────────────────────────────────────────────────────

async function main() {
  console.log('WattSnatch pre-flight check\n');

  checkNodeVersion();
  checkNativeModule('better-sqlite3');
  checkNativeModule('zeromq');
  checkNativeModule('keytar', { required: false });
  if (hasFailure) checkBuildTools();
  await checkKeytarFunctional();
  await checkPort(parseInt(process.env.PORT || '3001', 10));
  checkWritable(path.join(os.homedir(), '.solarcharge'), 'Database directory');
  checkWritable(path.join(__dirname, '..', 'keys'), 'Keys directory');
  checkMdns();
  await checkInternet();

  console.log('');
  for (const r of results) {
    console.log(`${r.icon} ${r.label}${r.detail ? ` - ${r.detail}` : ''}`);
  }

  console.log('');
  if (hasFailure) {
    console.log('One or more checks failed - fix the items marked ✗ above before running the setup wizard.');
    process.exit(1);
  } else if (hasWarning) {
    console.log('All required checks passed. Items marked ! are optional or only affect specific integrations - fine to proceed.');
    process.exit(0);
  } else {
    console.log('All checks passed - ready to run the setup wizard.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Pre-flight check itself failed unexpectedly:', err.message);
  process.exit(1);
});
