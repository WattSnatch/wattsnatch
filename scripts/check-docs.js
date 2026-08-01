#!/usr/bin/env node
'use strict';

/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root.
 */

/**
 * Documentation consistency checker.
 *
 * Exists because a real installer got blocked by a docs bug (a wrong Tesla
 * redirect URI), and the audits that followed kept missing the same class of
 * problem: prose that *describes* the app drifting away from what the app
 * actually does. Identifier-level mistakes (a route, a settings key) are easy
 * to grep for after the fact; the expensive ones were claims like "the wizard
 * has 7 steps" or "telemetry is kept for 7 days", which contain nothing
 * greppable and read as perfectly plausible English.
 *
 * So this checks documentation against the source of truth in the code:
 *   - every /api/... and /auth/... path mentioned in docs exists as a route
 *   - every npm script mentioned exists in package.json
 *   - every src/ or scripts/ file mentioned exists on disk
 *   - every internal markdown anchor link resolves (GitHub's slug rules,
 *     including the " - " -> "---" case that has bitten us twice)
 *   - the wizard step count claimed in docs matches public/setup.html
 *   - the meter and battery providers in the code are all mentioned in docs
 *   - retention/interval numbers match the constants in the code
 *   - nothing tracked by git is also matched by .gitignore (this is how a
 *     17MB binary and the proxy TLS keys ended up published)
 *
 * Deliberately dependency-free and self-contained so it can run in CI or on a
 * fresh clone before `npm install`.
 *
 * Usage: npm run check-docs   (exit 0 = clean, 1 = problems found)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const problems = [];
const checks = [];
function ok(label, detail) { checks.push({ pass: true, label, detail }); }
function bad(label, detail) { checks.push({ pass: false, label, detail }); problems.push(`${label}: ${detail}`); }

function read(f) { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } }

// Markdown docs to check. CHANGES.md is excluded on purpose: it is a
// historical record, so it legitimately describes things that are no longer
// true (removed features, bugs that have since been fixed).
const DOCS = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.md') && f !== 'CHANGES.md');

// ── 1. API paths ──────────────────────────────────────────────────────────────
function checkRoutes() {
  const routeDir = path.join(ROOT, 'src', 'routes');
  if (!fs.existsSync(routeDir)) return;
  const real = new Set();
  for (const f of fs.readdirSync(routeDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    for (const m of src.matchAll(/router\.(?:get|post|put|delete)\(\s*'([^']+)'/g)) real.add(m[1]);
  }
  const bogus = [];
  for (const doc of DOCS) {
    // THIRD_PARTY_LICENSES.md documents other projects' APIs by definition
    // (e.g. the Tesla Powerwall Gateway's own /api/system_status endpoints),
    // so its paths are not expected to be WattSnatch routes.
    if (doc === 'THIRD_PARTY_LICENSES.md') continue;
    // Evaluated line by line, not per-path: a doc may legitimately warn about
    // a wrong path in one place while still mistakenly instructing it in
    // another, and judging the whole file by the first matching line would
    // let that second occurrence through.
    const lines = read(doc).split('\n');
    lines.forEach((line, i) => {
      // Matches both a bare "/api/..." and one inside a full URL such as
      // "http://localhost:3001/auth/tesla/callback". Matching only bare paths
      // was the original flaw here: the redirect-URI bug that prompted all of
      // this was written as a full localhost URL and would have been skipped.
      for (const m of line.matchAll(/(https?:\/\/([a-zA-Z0-9._-]+)(?::\d+)?)?(\/(?:api|auth)\/[a-zA-Z0-9/_:.-]*)/g)) {
        const host = m[2];
        const p = m[3].replace(/[.,)`"'/]+$/, '');
        // Only paths served by this app. A non-local host means someone
        // else's API (Tesla's fleet-api, a Powerwall gateway, and so on).
        if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) continue;
        if (real.has(p)) continue;
        if (p.startsWith('/api/1/')) continue;
        // This specific line deliberately names a wrong path to warn against it.
        if (/not a real route|will not work|alone returns|is not a real|instead of|rather than/i.test(line)) continue;
        bogus.push(`${doc}:${i + 1} ${p}`);
      }
    });
  }
  bogus.length ? bad('API paths in docs', bogus.join(', ')) : ok('API paths in docs', 'all resolve to real routes');
}

// ── 2. npm scripts ────────────────────────────────────────────────────────────
function checkNpmScripts() {
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts || {});
  const bogus = [];
  for (const doc of DOCS) {
    for (const m of read(doc).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      if (!scripts.includes(m[1])) bogus.push(`${doc}: npm run ${m[1]}`);
    }
  }
  bogus.length ? bad('npm scripts in docs', [...new Set(bogus)].join(', ')) : ok('npm scripts in docs', 'all exist in package.json');
}

// ── 3. Referenced source files ────────────────────────────────────────────────
function checkFileRefs() {
  const bogus = [];
  for (const doc of DOCS) {
    for (const m of read(doc).matchAll(/\b((?:src|scripts)\/[a-zA-Z0-9_/.-]+\.(?:js|sh))/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) bogus.push(`${doc}: ${m[1]}`);
    }
  }
  bogus.length ? bad('Source files referenced in docs', [...new Set(bogus)].join(', ')) : ok('Source files referenced in docs', 'all exist');
}

// ── 4. Internal anchors ───────────────────────────────────────────────────────
// Mirrors GitHub's slugger: lowercase, drop anything that is not alphanumeric,
// space, underscore or hyphen, then spaces to hyphens. A heading containing
// " - " therefore yields three consecutive hyphens, which is the exact trap
// that produced two broken links in this repo.
function slug(heading) {
  return heading.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ +/g, '-');
}
function checkAnchors() {
  const broken = [];
  for (const doc of DOCS) {
    const text = read(doc);
    const anchors = new Set(
      [...text.matchAll(/^#{1,6} +(.+)$/gm)].map((m) => slug(m[1].trim()))
    );
    for (const m of text.matchAll(/\]\(#([a-z0-9_-]+)\)/g)) {
      if (!anchors.has(m[1])) broken.push(`${doc}#${m[1]}`);
    }
  }
  broken.length ? bad('Internal anchor links', broken.join(', ')) : ok('Internal anchor links', 'all resolve');
}

// ── 5. Wizard step count ──────────────────────────────────────────────────────
function checkWizardSteps() {
  const setup = read('public/setup.html');
  if (!setup) return;
  const real = new Set([...setup.matchAll(/id="step-(\d+)"/g)].map((m) => Number(m[1])));
  if (!real.size) return;
  const count = Math.max(...real);
  const wrong = [];
  for (const doc of DOCS) {
    const text = read(doc);
    const pats = [
      /(\d+)[- ]step(?:s)? (?:guided )?(?:setup )?wizard/gi,
      /wizard (?:has|walks through|walks you through) (\d+) steps/gi,
    ];
    for (const re of pats) {
      for (const m of text.matchAll(re)) {
        if (Number(m[1]) !== count) wrong.push(`${doc}: claims ${m[1]}, actual ${count}`);
      }
    }
  }
  wrong.length ? bad('Setup wizard step count', wrong.join('; ')) : ok('Setup wizard step count', `docs agree the wizard has ${count} steps`);
}

// ── 6. Provider coverage ──────────────────────────────────────────────────────
function checkProviders() {
  const alias = { mqttInput: 'MQTT', teslaPowerwall: 'Powerwall' };
  const missing = [];
  for (const kind of ['meters', 'battery']) {
    const dir = path.join(ROOT, 'src', 'services', kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || f === 'index.js') continue;
      const name = f.replace(/\.js$/, '');
      const needle = (alias[name] || name).toLowerCase();
      const documented = DOCS.some((d) => (read(d) || '').toLowerCase().includes(needle));
      if (!documented) missing.push(`${kind}/${name}`);
    }
  }
  missing.length ? bad('Provider coverage', `implemented but undocumented: ${missing.join(', ')}`) : ok('Provider coverage', 'every meter and battery provider is documented');
}

// ── 7. Retention / interval constants ─────────────────────────────────────────
function checkNumbers() {
  const db = read('src/db.js') || '';
  const wrong = [];

  const tel = db.match(/const\s+(\w+)\s*=\s*Date\.now\(\)\s*-\s*(\d+)\s*\*\s*365/);
  const telYears = tel ? Number(tel[2]) : null;
  const evt = /ninetyDaysAgo/.test(db) ? 90 : null;

  for (const doc of DOCS) {
    const text = read(doc) || '';
    if (telYears && /[Tt]elemetry (?:history )?(?:is )?(?:retained|kept) for 7 days/.test(text)) {
      wrong.push(`${doc}: says telemetry kept 7 days, code keeps ${telYears} years`);
    }
    if (/telemetry is auto-pruned after 7 days|old telemetry is auto-pruned after 7 days/i.test(text)) {
      wrong.push(`${doc}: claims 7-day telemetry pruning`);
    }
    if (evt && /event logs? (?:for |kept )?(\d+) days/i.test(text)) {
      const m = text.match(/event logs? (?:for |kept )?(\d+) days/i);
      if (Number(m[1]) !== evt) wrong.push(`${doc}: says event logs ${m[1]} days, code uses ${evt}`);
    }
  }

  const dflt = db.match(/polling_interval_seconds:\s*'(\d+)'/);
  if (dflt) {
    for (const doc of DOCS) {
      const text = read(doc) || '';
      if (/polled every tick \(5s\)|between 5-second poll ticks/.test(text)) {
        wrong.push(`${doc}: assumes a 5s tick, default is ${dflt[1]}s`);
      }
    }
  }

  wrong.length ? bad('Retention and interval claims', wrong.join('; ')) : ok('Retention and interval claims', 'match the constants in src/db.js');
}

// ── 8. Files that are tracked but gitignored ──────────────────────────────────
// This is how keys/proxy-tls-*.pem and a 17MB compiled binary reached the
// public repository: added before the ignore rule existed, never untracked.
function checkGitTracked() {
  try {
    const out = execSync('git ls-files --cached --ignored --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).trim();
    out ? bad('Tracked-but-ignored files', `${out.split('\n').join(', ')} - run: git rm --cached <file>`) : ok('Tracked-but-ignored files', 'none');
  } catch {
    ok('Tracked-but-ignored files', 'skipped (not a git repo)');
  }
}

console.log('\nWattSnatch documentation check\n');
checkRoutes(); checkNpmScripts(); checkFileRefs(); checkAnchors();
checkWizardSteps(); checkProviders(); checkNumbers(); checkGitTracked();

for (const c of checks) {
  console.log(`${c.pass ? GREEN + '✓' : RED + '✗'}${RESET} ${c.label}${c.detail ? ` ${DIM}- ${c.detail}${RESET}` : ''}`);
}
console.log('');
if (problems.length) {
  console.log(`${RED}${problems.length} problem(s) found.${RESET} Documentation disagrees with the code.\n`);
  process.exit(1);
}
console.log(`${GREEN}Documentation matches the code.${RESET}\n`);
process.exit(0);
