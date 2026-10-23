/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Departure charging should finish just before the car leaves, not hours early.
//
// It used to run at full rate the moment the six-hour window opened, so a charge that needed
// four hours finished two hours early and the car sat at a high state of charge until it left.
// The rate is now planned to finish about 30 minutes before departure, re-planned every tick,
// raised if the car falls behind, eased if solar gets ahead, and never trickled: below about
// 16 A the car's fixed overhead wastes too much, so the start waits instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-depfinish-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const ds = require('../src/services/departureScheduler');

const H = 3600e3;
const base = { capacityKwh: 62.5, wattsPerAmp: 240, minAmps: 5, maxAmps: 32 };
const plan = (o) => ds.planCharge({ ...base, ...o });

test.after(() => { for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true }); });

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

test('this morning\'s charge: 65% to 100% from 06:00 for 12:00 runs at 19 A, not 32 A', () => {
  const p = plan({ missingPct: 35, msUntilDeparture: 6 * H });
  assert.equal(p.start, true);
  assert.equal(p.amps, 19);
  // 21.9 kWh at 19 A x 240 V x 90% = 4.1 kW into the pack: about 5.3 h, done ~11:20.
  const hours = (0.35 * 62.5) / (19 * 240 * 0.9 / 1000);
  assert.ok(hours < 5.5 && hours > 4.5, `finishes ${hours.toFixed(2)} h after 06:00`);
});

test('the finish lands inside the 30-minute margin, never after departure', () => {
  for (const [missing, hoursOut] of [[35, 6], [20, 4], [50, 6], [10, 2], [5, 1.5]]) {
    const p = plan({ missingPct: missing, msUntilDeparture: hoursOut * H });
    if (!p.start) continue;
    const kwPack = p.amps * 240 * ds.CHARGE_EFFICIENCY / 1000;
    const finishH = (missing / 100 * 62.5) / kwPack;
    assert.ok(finishH <= hoursOut - 0.5 + 1e-9, `${missing}% in ${hoursOut} h: finishes ${finishH.toFixed(2)} h out of ${hoursOut}`);
  }
});

test('a small top-up waits rather than trickling, then starts at 16 A or more', () => {
  const early = plan({ missingPct: 5, msUntilDeparture: 5 * H });
  assert.equal(early.start, false);
  assert.match(early.reason, /not needed yet/);
  const later = plan({ missingPct: 5, msUntilDeparture: 1.3 * H });
  assert.equal(later.start, true);
  assert.ok(later.amps >= 16, `starts at ${later.amps} A`);
});

test('once started it keeps going, even if the plan alone would pause it', () => {
  const p = plan({ missingPct: 5, msUntilDeparture: 5 * H, inProgress: true });
  assert.equal(p.start, true);
  assert.equal(p.amps, 16, 'at the efficient floor, not stopping and starting');
});

test('a car that has fallen behind is sped up to full rate', () => {
  assert.equal(plan({ missingPct: 35, msUntilDeparture: 2 * H }).amps, 32);
  assert.equal(plan({ missingPct: 10, msUntilDeparture: 20 * 60e3 }).amps, 32, 'inside the margin: full rate');
});

test('never above the maximum, never below the configured minimum floor', () => {
  assert.equal(plan({ missingPct: 90, msUntilDeparture: 3 * H }).amps, 32);
  const p = ds.planCharge({ ...base, maxAmps: 12, missingPct: 5, msUntilDeparture: 5 * H });
  assert.ok(p.amps <= 12);
});

test('with peak-tariff windows configured it keeps the old full-rate behaviour', () => {
  const p = plan({ missingPct: 35, msUntilDeparture: 6 * H, peakWindowsConfigured: true });
  assert.equal(p.amps, 32);
});

test('nothing to do once the target is reached', () => {
  assert.equal(plan({ missingPct: 0, msUntilDeparture: 3 * H }).start, false);
});

// ── Through getDepartureDecision ─────────────────────────────────────────────────────────────

test('the decision carries the planned rate', () => {
  db.setSetting('tesla_battery_kwh', '62.5');
  db.setSetting('charger_voltage', '240');
  db.setSetting('max_charge_amps', '32');
  ds.setDeparture(Date.now() + 6 * H, 100, 'trip');
  const d = ds.getDepartureDecision(65, 32);
  assert.equal(d.needsGridCharge, true);
  assert.equal(d.suggestedAmps, 19);
  assert.match(d.planReason, /finishes about 30 minutes before departure/);
  ds.clearDeparture();
});

test('a charge that needs more than 6 hours even at full rate starts before the window', () => {
  db.setSetting('tesla_battery_kwh', '82');
  ds.setDeparture(Date.now() + 9 * H, 100, 'long trip');
  const d = ds.getDepartureDecision(20, 32);       // 65.6 kWh: over 9 h at 32 A
  assert.equal(d.needsGridCharge, true, 'waiting for the 6-hour window would miss the target');
  assert.equal(d.suggestedAmps, 32);
  ds.clearDeparture();
  db.setSetting('tesla_battery_kwh', '62.5');
});

test('a top-up that can wait is not grid charged yet', () => {
  ds.setDeparture(Date.now() + 5 * H, 70, 'short trip');
  const d = ds.getDepartureDecision(65, 32);
  assert.equal(d.active, true);
  assert.equal(d.needsGridCharge, false);
  ds.clearDeparture();
});

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────

test('the controller charges at the planned rate, or faster on solar, and passes its state', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  assert.match(src, /getDepartureDecision\(batteryPct, maxAmps,\s*\{ wattsPerAmp: this\._wattsPerAmp\(\), inProgress: this\.state === STATES\.DEPARTURE \}\)/);
  assert.match(src, /const rateAmps\s+= Math\.max\(1, Math\.min\(maxAmps, Math\.max\(plannedAmps, solarAmps\)\)\)/);
  assert.match(src, /setChargingAmps\(vin, rateAmps, teslaToken\);\s*this\._trackApiCall\('command'\); await startCharging/);
  assert.doesNotMatch(src.slice(src.indexOf('async _runDeparture('), src.indexOf('async _runDeparture(') + 6000),
    /setChargingAmps\(vin, maxAmps, teslaToken\)/, 'departure no longer always uses the maximum');
});
