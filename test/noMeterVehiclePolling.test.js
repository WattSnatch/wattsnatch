/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A missing or failing solar meter must not stop WattSnatch talking to the car.
//
// The controller used to `return` as soon as a meter read produced nothing,
// before any of the vehicle handling. Anyone with an unconfigured or broken
// inverter therefore saw a completely blank dashboard - no battery percentage,
// no charging state - and concluded Tesla was broken when Tesla was fine. It
// also silently disabled scheduled charging, free power windows and CHARGE NOW,
// none of which need solar data at all.
//
// These tests pin the two halves of that: the null-tolerance of everything the
// controller calls before solar arithmetic begins, and the fact that solar
// diversion itself still refuses to run on nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-nometer-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');

// ── The gate itself ──────────────────────────────────────────────────────────

test('a null meter reading no longer aborts the control loop', () => {
  // The old shape was:
  //   if (!readings) { this._emitSSE(...); return; }
  // The `return` is what blanked the dashboard. Assert it is gone, by checking
  // that the SSE-error branch does not return.
  const idx = controllerSource.indexOf("message: 'No gateway data'");
  assert.ok(idx > 0, 'the no-gateway-data branch should still exist');

  // Look at the few lines following the emit - there must be no `return` before
  // the block closes.
  const after = controllerSource.slice(idx, idx + 200);
  const closeBrace = after.indexOf('}');
  const branchBody = after.slice(0, closeBrace);
  assert.ok(
    !/\breturn\b/.test(branchBody),
    'the missing-meter branch must not return - that is what blanked the dashboard'
  );
});

test('solar diversion still refuses to run without a reading', () => {
  // The other half: having removed the blanket gate, the solar arithmetic must
  // have gained its own. Substituting zeroes there would read as "no surplus"
  // and could drive a real charging decision off an unmeasured value.
  assert.ok(
    controllerSource.includes('Solar diversion requires a meter reading'),
    'a dedicated guard should protect the solar-arithmetic section'
  );

  const guardIdx = controllerSource.indexOf('Solar diversion requires a meter reading');
  const solarTargetIdx = controllerSource.indexOf('// --- Solar target ---');
  assert.ok(
    guardIdx < solarTargetIdx,
    'the guard must sit before the solar target calculation, not after it'
  );
});

// ── Null-safety of everything reached before the guard ───────────────────────

test('every readings dereference before the guard is null-safe', () => {
  const guardIdx = controllerSource.indexOf('Solar diversion requires a meter reading');
  assert.ok(guardIdx > 0);

  const lines = controllerSource.slice(0, guardIdx).split('\n');

  // Walk the code before the guard, tracking whether we are inside an
  // `if (readings) {` block or immediately after a successful fetch. Any
  // `readings.` outside such protection would be a crash once readings can be
  // null - which is exactly what removing the gate made possible.
  let guardDepth = null;
  let depth = 0;
  let fetchedInScope = false;
  const unsafe = [];

  lines.forEach((line, i) => {
    if (/readings = await provider\.fetchReadings\(\)/.test(line)) fetchedInScope = true;
    if (/if \(readings\)\s*\{/.test(line) && guardDepth === null) guardDepth = depth;

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    // A bare `readings.foo` with no protection at all.
    if (/readings\./.test(line)
        && !/readings \?/.test(line)
        && !/readings &&/.test(line)
        && !/readings = await/.test(line)
        && guardDepth === null
        && !fetchedInScope) {
      unsafe.push(`${i + 1}: ${line.trim()}`);
    }

    depth += opens - closes;
    if (guardDepth !== null && depth <= guardDepth) guardDepth = null;
    // Leaving the try block that performed the fetch drops that protection.
    if (fetchedInScope && /^\s*\} catch/.test(line)) fetchedInScope = false;
  });

  assert.deepEqual(unsafe, [], 'unguarded readings dereference(s) before the solar guard');
});

// ── The functions the loop calls must tolerate null ──────────────────────────

test('_runOverride, _runScheduled and _emitTelemetry all guard readings', () => {
  // These are the three things reachable with a null reading. Each was already
  // written defensively, which is why removing the gate was safe - assert that
  // stays true, so a later edit cannot quietly reintroduce a crash.
  for (const fn of ['_runOverride', '_runScheduled', '_emitTelemetry']) {
    const start = controllerSource.indexOf(fn + '(');
    assert.ok(start > 0, `${fn} should exist`);
    const body = controllerSource.slice(start, start + 4000);
    const derefs = body.match(/readings\.[a-zA-Z]+/g) || [];
    if (derefs.length === 0) continue; // nothing to protect
    assert.ok(
      /readings \?/.test(body) || /if \(readings\)/.test(body),
      `${fn} dereferences readings and must guard for null`
    );
  }
});
