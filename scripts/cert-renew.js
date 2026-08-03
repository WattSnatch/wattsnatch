#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Renews every Let's Encrypt certificate WattSnatch depends on, across both
// certbot installations, and makes a failure impossible to miss.
//
// There are two separate certbot trees on a WattSnatch host, and this is the
// single most confusing thing about the setup:
//
//   1. The system tree (/etc/letsencrypt) - the certificate nginx serves for
//      the dashboard. Managed by certbot running as root.
//   2. The telemetry tree (~/.solarcharge/letsencrypt) - the certificate
//      `fleet-telemetry` serves to your car. Owned by the WattSnatch user,
//      because fleet-telemetry runs as that user and must be able to read
//      the private key.
//
// A bare `certbot renew` only ever looks at the system tree. If that is all
// you have scheduled, the telemetry certificate silently expires and the car
// stops reporting - which is exactly the failure this script exists to stop.
//
// Why this does not use certbot's --deploy-hook for the telemetry restart:
// the telemetry tree must be renewed as the WattSnatch user (so the renewed
// privkey stays readable by fleet-telemetry), but restarting fleet-telemetry
// needs root, since it is a system LaunchDaemon. A hook running as the user
// cannot do it. Instead this script records each certificate's serial before
// and after renewal, and restarts only what actually changed. That comparison
// also gives us the issuer check for free - see CHAIN ROTATION below.
//
// CHAIN ROTATION: your car pins the CA chain you sent it via "Send Config to
// Tesla". If Let's Encrypt rotates intermediates, a renewed certificate can be
// perfectly valid and still be rejected by the car, with no error anywhere
// except TLS handshake failures in the fleet-telemetry log. So a renewal that
// changes the issuer is treated as a problem needing human action, not a
// success.
//
// Usage: node scripts/cert-renew.js [--dry-run] [--quiet]
// Exit code 0 if everything is healthy, 1 if anything needs attention.
// Writes machine-readable status to CERT_STATUS_PATH for the app to display.

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Configuration ──────────────────────────────────────────────────────────

// The user WattSnatch and fleet-telemetry run as. When this script runs as
// root from the LaunchDaemon, certbot for the telemetry tree is dropped to
// this user so renewed key files stay readable by fleet-telemetry.
//
// Derived from who owns the WattSnatch install, not from whoever is running
// this: under launchd that is root, and root's home is not where the
// certificates live. WATTSNATCH_USER / WATTSNATCH_HOME override if your
// layout differs.
function installOwner() {
  if (process.env.WATTSNATCH_USER) return process.env.WATTSNATCH_USER;
  try {
    const uid = fs.statSync(path.join(__dirname, '..')).uid;
    if (typeof process.getuid === 'function' && uid === process.getuid()) {
      return os.userInfo().username;
    }
    return execFileSync('id', ['-un', String(uid)], { encoding: 'utf8' }).trim();
  } catch (err) {
    return os.userInfo().username;
  }
}

function homeOf(user) {
  if (process.env.WATTSNATCH_HOME) return process.env.WATTSNATCH_HOME;
  try {
    if (user === os.userInfo().username) return os.homedir();
  } catch (err) { /* fall through to the lookup below */ }
  try {
    // Portable across macOS and Linux without assuming /Users or /home.
    const out = execFileSync('sh', ['-c', `echo ~${user}`], { encoding: 'utf8' }).trim();
    if (out && !out.startsWith('~')) return out;
  } catch (err) { /* fall through */ }
  return os.homedir();
}

const APP_USER = installOwner();
const APP_HOME = homeOf(APP_USER);

const SOLARCHARGE_DIR = path.join(APP_HOME, '.solarcharge');
const CERT_STATUS_PATH = process.env.CERT_STATUS_PATH
  || path.join(SOLARCHARGE_DIR, 'cert-status.json');

const CERTBOT = process.env.CERTBOT_BIN
  || '/Library/Frameworks/Python.framework/Versions/3.14/bin/certbot';
const NGINX = process.env.NGINX_BIN || '/opt/homebrew/bin/nginx';
const TELEMETRY_SERVICE = 'system/com.solarcharge.telemetry';

// Warn this far out. 30 days matches when certbot starts attempting renewal,
// so an alert at 21 days means renewal has already failed several times.
const WARN_DAYS = 21;
const CRITICAL_DAYS = 10;

// Each DNS-01 challenge waits for propagation (30s per certificate here), and
// a tree can hold several lineages, so this needs headroom - but a run that
// exceeds it is stuck, and saying so beats blocking until the next schedule.
const CERTBOT_TIMEOUT_MS = Number(process.env.CERTBOT_TIMEOUT_MS) || 8 * 60 * 1000;

// Where nginx keeps its config, used to work out which system-tree
// certificates are actually being served (see criticalLineages below).
const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/opt/homebrew/etc/nginx';

// The two certbot trees. Which certificates count as "critical" is worked out
// per-host rather than hardcoded - see criticalLineages() - so that a stale or
// decommissioned lineage cannot train you to ignore this script's output, and
// so nothing here has to know your hostnames.
const TREES = [
  {
    name: 'system',
    configDir: '/etc/letsencrypt',
    asUser: null, // runs as whoever invokes certbot (root from the daemon)
    note: 'Serves the WattSnatch dashboard via nginx.',
  },
  {
    name: 'telemetry',
    configDir: path.join(SOLARCHARGE_DIR, 'letsencrypt'),
    asUser: APP_USER,
    note: 'Served by fleet-telemetry to your car. Must stay readable by the app user.',
  },
];

// Which lineages in a tree production actually depends on.
//
// Deliberately derived rather than configured, because a hardcoded list goes
// stale the moment a hostname changes - which is exactly when you most need
// this to be right.
//
//   - Telemetry tree: every lineage counts. The tree exists solely to serve
//     fleet-telemetry, so anything in it is load-bearing.
//   - System tree: only what nginx actually references. A lineage nobody
//     serves (a decommissioned hostname whose renewal config outlived it) is
//     reported but never alarms.
//
// WATTSNATCH_CRITICAL_CERTS overrides both, as a comma-separated list, for
// setups that do not match these assumptions.
function criticalLineages(tree, lineages) {
  const override = (process.env.WATTSNATCH_CRITICAL_CERTS || '').trim();
  if (override) return new Set(override.split(',').map(s => s.trim()).filter(Boolean));

  if (tree.name === 'telemetry') return new Set(lineages);

  // Read nginx's ssl_certificate directives and keep the lineages they point
  // at. If nginx's config cannot be read we return an empty set: reporting
  // nothing as critical is safer than guessing wrong and either crying wolf
  // or staying silent about the wrong certificate.
  const served = new Set();
  try {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const text = fs.readFileSync(full, 'utf8');
          for (const m of text.matchAll(/ssl_certificate\s+([^\s;]+)/g)) {
            const parts = m[1].split(path.sep);
            const i = parts.indexOf('live');
            if (i !== -1 && parts[i + 1]) served.add(parts[i + 1]);
          }
        }
      }
    };
    walk(NGINX_CONF_DIR);
  } catch (err) {
    return new Set();
  }
  return new Set(lineages.filter(l => served.has(l)));
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const QUIET = args.includes('--quiet');

function log(...a) { if (!QUIET) console.log(...a); }
function warn(...a) { console.warn(...a); }

// ── Certificate inspection ─────────────────────────────────────────────────

// Reads the live certificate for one certbot lineage. Returns null when the
// lineage has no readable certificate, which is normal for a cert that was
// issued but never deployed.
function readCert(configDir, certName) {
  const file = path.join(configDir, 'live', certName, 'fullchain.pem');
  try {
    const out = execFileSync('openssl',
      ['x509', '-in', file, '-noout', '-issuer', '-subject', '-serial', '-enddate'],
      // stderr is swallowed deliberately: an unreadable lineage is an expected
      // outcome (the system tree needs root), and is reported by returning null
      // rather than by leaking openssl's message to the console.
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pick = (re) => (out.match(re) || [null, null])[1];
    const notAfter = pick(/notAfter=(.+)/);
    const expiryMs = notAfter ? Date.parse(notAfter) : null;
    return {
      file,
      issuer: pick(/issuer=(.+)/),
      subject: pick(/subject=(.+)/),
      serial: pick(/serial=(.+)/),
      notAfter,
      daysRemaining: expiryMs ? Math.floor((expiryMs - Date.now()) / 86400000) : null,
    };
  } catch (err) {
    return null;
  }
}

// Lists the lineages configured in a tree, by reading its renewal configs.
// Reading the directory is enough - we deliberately do not shell out to
// `certbot certificates` here, which is slow and needs the account online.
function listLineages(configDir) {
  try {
    return fs.readdirSync(path.join(configDir, 'renewal'))
      .filter(f => f.endsWith('.conf'))
      .map(f => f.replace(/\.conf$/, ''))
      .sort();
  } catch (err) {
    return [];
  }
}

function snapshot(tree) {
  const out = {};
  for (const name of listLineages(tree.configDir)) {
    out[name] = readCert(tree.configDir, name);
  }
  return out;
}

// ── Renewal ────────────────────────────────────────────────────────────────

function runCertbotRenew(tree) {
  const certbotArgs = [
    'renew',
    '--config-dir', tree.configDir,
    '--work-dir', path.join(tree.configDir, 'work'),
    '--logs-dir', path.join(tree.configDir, 'logs'),
    '--non-interactive',
    // Under --non-interactive, certbot sleeps a random interval of up to 8
    // minutes before renewing, to spread load across Let's Encrypt's servers.
    // That is sensible for the distro-installed timer that fires on the hour
    // alongside thousands of other hosts, but this job is already scheduled at
    // a deliberately odd time (03:17/15:17) on a single machine, so the delay
    // buys nothing and only makes a run indistinguishable from a hang.
    '--no-random-sleep-on-renew',
  ];
  if (DRY_RUN) certbotArgs.push('--dry-run');

  // Drop privileges for trees owned by the app user, so renewed private keys
  // stay readable by fleet-telemetry. Without this, a root-run renewal leaves
  // a root-owned 0600 privkey and fleet-telemetry fails at its next restart.
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  let cmd = CERTBOT;
  let cmdArgs = certbotArgs;
  if (tree.asUser && runningAsRoot) {
    cmd = 'sudo';
    cmdArgs = ['-n', '-u', tree.asUser, CERTBOT, ...certbotArgs];
  }

  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      // Generous enough for several DNS-01 challenges at 30s propagation each,
      // tight enough that a genuine hang is reported rather than sat on until
      // the next scheduled run.
      timeout: CERTBOT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: String(stdout).trim() };
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    // "I am not allowed to look" is a different situation from "renewal is
    // broken", and conflating them would either cry wolf when a human runs
    // this without sudo, or hide a real failure behind a permissions excuse.
    const permission = /Permission denied|Either run as root/i.test(detail);
    const timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
    return {
      ok: false,
      permission,
      timedOut,
      output: detail || err.message,
      error: err.message,
    };
  }
}

// ── Post-renewal actions ───────────────────────────────────────────────────

function reloadNginx() {
  try {
    execFileSync(NGINX, ['-s', 'reload'], { timeout: 30000, stdio: 'ignore' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// fleet-telemetry reads its certificate once, at startup. A renewal without a
// restart changes nothing at all, so this is not optional.
function restartTelemetry() {
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', TELEMETRY_SERVICE],
      { timeout: 60000, stdio: 'ignore' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Status file ────────────────────────────────────────────────────────────

// The app reads this to show cert health in the dashboard. Written even when
// everything succeeds, so a stale file (nothing has run for days) is itself a
// detectable problem.
function writeStatus(status) {
  try {
    fs.mkdirSync(path.dirname(CERT_STATUS_PATH), { recursive: true });
    fs.writeFileSync(CERT_STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
    // When run as root from the daemon, hand ownership back so the app user
    // can read (and later overwrite) the file.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      try {
        execSync(`chown ${APP_USER} ${JSON.stringify(CERT_STATUS_PATH)}`, { stdio: 'ignore' });
      } catch { /* non-fatal: the file is world-readable anyway */ }
    }
  } catch (err) {
    warn(`[cert-renew] could not write status file: ${err.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const startedAt = new Date().toISOString();
  const problems = [];
  const certs = [];
  const unchecked = [];
  let telemetryNeedsRestart = false;
  let nginxNeedsReload = false;

  log(`WattSnatch certificate renewal${DRY_RUN ? ' (dry run)' : ''}`);

  for (const tree of TREES) {
    if (!fs.existsSync(tree.configDir)) {
      log(`  ${tree.name}: not present at ${tree.configDir}, skipping`);
      continue;
    }

    const before = snapshot(tree);
    const result = runCertbotRenew(tree);
    const after = snapshot(tree);

    // Not being allowed to read a tree tells us nothing about its health, so
    // report it as unchecked rather than inventing a verdict. In production
    // this never happens - the LaunchDaemon runs as root - but a human running
    // this by hand without sudo should get an accurate explanation, not a
    // false alarm about certificates that are perfectly fine.
    if (result.permission) {
      log(`  ${tree.name}: not checked - needs root to read ${tree.configDir}`);
      unchecked.push({
        tree: tree.name,
        configDir: tree.configDir,
        reason: 'Requires root. Run with sudo, or let the LaunchDaemon run it.',
      });
      continue;
    }

    if (result.timedOut) {
      const msg = `certbot did not finish within `
        + `${Math.round(CERTBOT_TIMEOUT_MS / 60000)} minutes and was stopped. `
        + `Certificates were NOT renewed.`;
      log(`  ${tree.name}: TIMED OUT - ${msg}`);
      problems.push({ name: `${tree.name} tree`, message: msg });
    } else if (!result.ok) {
      // certbot exits non-zero if ANY lineage in the tree fails, including
      // decommissioned ones. Attribute the failure per-certificate below
      // rather than condemning the whole tree.
      log(`  ${tree.name}: certbot reported at least one failure`);
    }

    const allNames = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const critical = criticalLineages(tree, allNames);

    for (const name of allNames) {
      const b = before[name];
      const a = after[name];
      const isCritical = critical.has(name);
      const renewed = !!(a && b && a.serial !== b.serial);
      const issuerChanged = !!(a && b && a.issuer !== b.issuer);

      // A lineage is failing if certbot errored AND this certificate is close
      // enough to expiry that certbot should have been able to renew it.
      const failing = !result.ok
        && a && a.daysRemaining !== null && a.daysRemaining <= 30;

      const entry = {
        tree: tree.name,
        name,
        critical: isCritical,
        subject: a ? a.subject : null,
        issuer: a ? a.issuer : null,
        notAfter: a ? a.notAfter : null,
        daysRemaining: a ? a.daysRemaining : null,
        renewed,
        issuerChanged,
        healthy: true,
        message: null,
      };

      if (!a) {
        entry.healthy = false;
        entry.message = 'No readable certificate for this lineage.';
      } else if (failing) {
        entry.healthy = false;
        entry.message = `Renewal is failing with ${a.daysRemaining} days left. `
          + `See ${path.join(tree.configDir, 'logs', 'letsencrypt.log')}.`;
      } else if (a.daysRemaining !== null && a.daysRemaining <= CRITICAL_DAYS) {
        entry.healthy = false;
        entry.message = `Expires in ${a.daysRemaining} days and has not renewed.`;
      } else if (a.daysRemaining !== null && a.daysRemaining <= WARN_DAYS) {
        entry.healthy = false;
        entry.message = `Expires in ${a.daysRemaining} days - renewal should have `
          + `happened by now.`;
      }

      // Chain rotation needs a human: the car pins the old chain and will
      // reject the new certificate until the CA field is updated and resent.
      if (issuerChanged && isCritical) {
        entry.healthy = false;
        entry.message = `Issuer changed from "${b.issuer}" to "${a.issuer}". `
          + `Update the CA certificate field and use Send Config to Tesla, or `
          + `the car will silently stop connecting.`;
      }

      if (renewed) {
        nginxNeedsReload = true;
        if (tree.name === 'telemetry') telemetryNeedsRestart = true;
      }

      if (!entry.healthy && isCritical) problems.push(entry);
      certs.push(entry);

      const mark = entry.healthy ? 'ok' : 'ATTENTION';
      log(`  [${mark}] ${tree.name}/${name}`
        + (entry.daysRemaining !== null ? ` - ${entry.daysRemaining}d left` : '')
        + (renewed ? ' (renewed)' : '')
        + (entry.message ? ` - ${entry.message}` : ''));
    }
  }

  // Only touch running services when something actually changed, so a routine
  // no-op run never disturbs a working production system.
  const actions = [];
  if (DRY_RUN) {
    if (nginxNeedsReload || telemetryNeedsRestart) {
      log('  (dry run: would reload nginx / restart fleet-telemetry)');
    }
  } else {
    if (nginxNeedsReload) {
      const r = reloadNginx();
      actions.push({ action: 'nginx-reload', ...r });
      log(`  nginx reload: ${r.ok ? 'ok' : 'FAILED - ' + r.error}`);
      if (!r.ok) problems.push({ name: 'nginx', critical: true, healthy: false,
        message: `Certificate renewed but nginx reload failed: ${r.error}` });
    }
    if (telemetryNeedsRestart) {
      const r = restartTelemetry();
      actions.push({ action: 'telemetry-restart', ...r });
      log(`  fleet-telemetry restart: ${r.ok ? 'ok' : 'FAILED - ' + r.error}`);
      if (!r.ok) problems.push({ name: 'fleet-telemetry', critical: true, healthy: false,
        message: `Certificate renewed but fleet-telemetry restart failed: ${r.error}. `
          + `It is still serving the OLD certificate.` });
    }
  }

  const status = {
    lastRunAt: startedAt,
    lastRunCompletedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    host: os.hostname(),
    healthy: problems.length === 0,
    problems: problems.map(p => ({ name: p.name, message: p.message })),
    certs,
    unchecked,
    actions,
  };

  if (!DRY_RUN) writeStatus(status);

  if (problems.length > 0) {
    warn(`\n${problems.length} certificate problem(s) need attention:`);
    for (const p of problems) warn(`  - ${p.name}: ${p.message}`);
    return 1;
  }

  log('\nAll certificates healthy.');
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { readCert, listLineages, criticalLineages, TREES, CERT_STATUS_PATH };
