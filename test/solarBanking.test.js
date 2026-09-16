/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Solar banking raises the car's charge limit on a strong day when the days
// ahead look poor, then puts the owner's limit back.
//
// The feature is deliberately additive: the diversion algorithm decides how much
// surplus to send, and every stop condition in the controller compares the
// battery against the car's own charge_limit_soc. Moving that ceiling is the
// whole mechanism, which is why nothing in controller.js is touched. These tests
// pin the decision logic, which is pure, rather than the command plumbing.
//
// The case that matters most is a sleeping car. A car asleep reports no charging
// state at all, and PLUGGED_IN.has(null) is false. Treating that as "unplugged"
// would restore the limit every time the car dozed off in the driveway, in the
// middle of a sunny afternoon, undoing the banking for the rest of the day. That
// is the same confusion between "no data" and "a fact" that broke scheduled
// wakes, so it is asserted from both directions here.
//
// The other sharp edge is the truncated final forecast day. A Solcast window
// covers a fixed number of hours, so its last calendar day stops partway through
// and reports a fraction of its real total. Averaging it in would make a
// perfectly good week look weak and trigger a boost on an artefact of when the
// fetch happened.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-solarbanking-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const banking = require('../src/services/solarBanking');

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch { /* already gone */ }
});

// A baseline set of inputs where every gate passes and a boost is warranted.
// Each test changes exactly one thing, so a failure names its own cause.
function ctx(overrides = {}) {
  return {
    enabled:          true,
    backendIsOcpp:    false,
    chargingState:    'Charging',
    activeBoost:      null,
    today:            '2026-09-16',
    atHome:           true,
    limitTrustworthy: true,
    forecastFresh:    true,
    currentLimit:     80,
    ceiling:          90,
    forecast:         { boost: true, reason: 'strong today, weak ahead' },
    ...overrides,
  };
}

// ── The sleeping car ─────────────────────────────────────────────────────────

test('a sleeping car does NOT count as unplugged and keeps its boost', () => {
  // The whole point: no charge state is an absence of information, not a
  // disconnection. Restoring here would undo the banking mid-afternoon.
  const plan = banking.planAction(ctx({
    chargingState: null,
    activeBoost:   { baseline: 80, day: '2026-09-16' },
  }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /already active/);
});

test('an explicitly disconnected car does restore', () => {
  const plan = banking.planAction(ctx({
    chargingState: 'Disconnected',
    activeBoost:   { baseline: 80, day: '2026-09-16' },
  }));
  assert.equal(plan.action, 'restore');
  assert.match(plan.reason, /unplugged/);
});

test('a sleeping car is not a reason to start a boost either', () => {
  const plan = banking.planAction(ctx({ chargingState: null }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /no charge state/);
});

// ── Restore triggers ─────────────────────────────────────────────────────────

test('the boost is restored when the day it was taken out on ends', () => {
  const plan = banking.planAction(ctx({
    today:       '2026-09-17',
    activeBoost: { baseline: 80, day: '2026-09-16' },
  }));
  assert.equal(plan.action, 'restore');
  assert.match(plan.reason, /day ended/);
});

test('turning the feature off restores an active boost rather than stranding it', () => {
  const plan = banking.planAction(ctx({
    enabled:     false,
    activeBoost: { baseline: 80, day: '2026-09-16' },
  }));
  assert.equal(plan.action, 'restore');
  assert.match(plan.reason, /turned off/);
});

test('a boost left behind by a previous process is restored after a restart', () => {
  // activeBoost is read from the database, so a process that died mid-boost
  // still knows the owner's number on the next tick.
  const plan = banking.planAction(ctx({
    today:         '2026-09-18',
    chargingState: 'Stopped',
    activeBoost:   { baseline: 70, day: '2026-09-16' },
  }));
  assert.equal(plan.action, 'restore');
});

test('an active boost on the same day with the car still plugged in is left alone', () => {
  const plan = banking.planAction(ctx({
    activeBoost: { baseline: 80, day: '2026-09-16' },
  }));
  assert.equal(plan.action, 'none');
});

// ── Gates that must block a boost ────────────────────────────────────────────

test('the feature off means no action at all', () => {
  assert.equal(banking.planAction(ctx({ enabled: false })).action, 'none');
});

test('an OCPP charge point has no vehicle limit to move', () => {
  // And nothing to restore either, since nothing was ever set.
  const plan = banking.planAction(ctx({ backendIsOcpp: true, activeBoost: { baseline: 80, day: '2026-09-16' } }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /OCPP/);
});

test('a car away from home is left alone', () => {
  const plan = banking.planAction(ctx({ atHome: false }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /not at home/);
});

test('an unconfirmed charge limit is never captured as the baseline', () => {
  // Capturing a persisted or unknown limit would later "restore" the car to a
  // number its owner never chose.
  const plan = banking.planAction(ctx({ limitTrustworthy: false }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /not confirmed/);
});

test('a stale forecast blocks the decision', () => {
  const plan = banking.planAction(ctx({ forecastFresh: false }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /stale|missing/);
});

test('a limit already at or above the ceiling is not rewritten', () => {
  const plan = banking.planAction(ctx({ currentLimit: 90 }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /already at or above/);
});

test('a limit outside the range Tesla accepts is refused', () => {
  for (const bad of [0, 49, 101, NaN]) {
    const plan = banking.planAction(ctx({ currentLimit: bad }));
    assert.equal(plan.action, 'none', `limit ${bad} should be refused`);
  }
});

test('an unplugged car never starts a boost', () => {
  const plan = banking.planAction(ctx({ chargingState: 'Disconnected' }));
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /not plugged in/);
});

test('a weak forecast verdict blocks the boost', () => {
  const plan = banking.planAction(ctx({ forecast: { boost: false, reason: 'week ahead is not weak' } }));
  assert.equal(plan.action, 'none');
});

test('every gate passing produces a boost from the current limit to the ceiling', () => {
  const plan = banking.planAction(ctx());
  assert.equal(plan.action, 'boost');
  assert.equal(plan.from, 80);
  assert.equal(plan.to,   90);
});

test('every plugged-in state the controller recognises can start a boost', () => {
  for (const state of ['Stopped', 'NoPower', 'Charging', 'Complete']) {
    assert.equal(banking.planAction(ctx({ chargingState: state })).action, 'boost', state);
  }
});

// ── The forecast comparison ──────────────────────────────────────────────────

test('a strong day followed by four weak ones triggers', () => {
  const d = banking.decideBoost({
    todayCompletedKwh: 20,
    todayRemainingKwh: 20,          // 40 kWh today
    futureDayKwh:      [10, 12, 11, 9],
    weakRatioPct:      60,          // weak below 24 kWh
  });
  assert.equal(d.boost, true);
  assert.equal(d.todayFullKwh, 40);
});

test('a strong day followed by four more strong ones does not', () => {
  const d = banking.decideBoost({
    todayCompletedKwh: 20,
    todayRemainingKwh: 20,
    futureDayKwh:      [37, 35, 40, 38],
    weakRatioPct:      60,
  });
  assert.equal(d.boost, false);
  assert.match(d.reason, /not weak/);
});

test("today's figure counts what already happened, not just what is left", () => {
  // The forecast row for today only covers from the last fetch onwards, so at
  // 4pm it is nearly empty. Judging the day on that alone would make every
  // afternoon look feeble and suppress the feature exactly when it is decided.
  const d = banking.decideBoost({
    todayCompletedKwh: 35,
    todayRemainingKwh: 6,
    futureDayKwh:      [10, 10, 10, 10],
    weakRatioPct:      60,
  });
  assert.equal(d.todayFullKwh, 41);
  assert.equal(d.boost, true);
});

test('too little sun left today means there is nothing worth banking', () => {
  const d = banking.decideBoost({
    todayCompletedKwh: 40,
    todayRemainingKwh: 1,
    futureDayKwh:      [5, 5, 5, 5],
    weakRatioPct:      60,
  });
  assert.equal(d.boost, false);
  assert.match(d.reason, /left today/);
});

test('fewer than four full days ahead is not enough to judge the week', () => {
  const d = banking.decideBoost({
    todayCompletedKwh: 20,
    todayRemainingKwh: 20,
    futureDayKwh:      [5, 5, 5],
    weakRatioPct:      60,
  });
  assert.equal(d.boost, false);
  assert.match(d.reason, /need 4/);
});

test('the weak ratio is what decides a borderline week', () => {
  const inputs = { todayCompletedKwh: 0, todayRemainingKwh: 40, futureDayKwh: [25, 25, 25, 25] };
  // 25 average against 40 today is 62.5 percent.
  assert.equal(banking.decideBoost({ ...inputs, weakRatioPct: 60 }).boost, false);
  assert.equal(banking.decideBoost({ ...inputs, weakRatioPct: 70 }).boost, true);
});

// ── Forecast day selection ───────────────────────────────────────────────────

test('the truncated last day of the forecast window is dropped', () => {
  // A real window: today is partial at the start, the last day partial at the
  // end. Counting that final 22.4 would drag a strong week below the threshold.
  const rows = [
    { day: '2026-09-16', kwh: 10.0, remaining_kwh: 10.0 },
    { day: '2026-09-17', kwh: 37.4, remaining_kwh: 37.4 },
    { day: '2026-09-18', kwh: 35.8, remaining_kwh: 35.8 },
    { day: '2026-09-19', kwh: 40.8, remaining_kwh: 40.8 },
    { day: '2026-09-20', kwh: 40.1, remaining_kwh: 40.1 },
    { day: '2026-09-21', kwh: 22.4, remaining_kwh: 22.4 },  // truncated
  ];
  const days = banking.futureFullDays(rows, '2026-09-16');
  assert.deepEqual(days, [37.4, 35.8, 40.8, 40.1]);
});

test('today is excluded from the days ahead', () => {
  const rows = [
    { day: '2026-09-16', kwh: 10.0 },
    { day: '2026-09-17', kwh: 20.0 },
    { day: '2026-09-18', kwh: 30.0 },
  ];
  assert.deepEqual(banking.futureFullDays(rows, '2026-09-16'), [20.0]);
});

test('a forecast too short to have any usable day yields nothing', () => {
  assert.deepEqual(banking.futureFullDays([{ day: '2026-09-16', kwh: 10 }], '2026-09-16'), []);
  assert.deepEqual(banking.futureFullDays([], '2026-09-16'), []);
  assert.deepEqual(banking.futureFullDays(null, '2026-09-16'), []);
});

// ── Settings ─────────────────────────────────────────────────────────────────

test('the feature ships off, so an upgrade changes nothing', () => {
  assert.equal(db.getSetting('opportunistic_charge_limit_enabled'), 'false');
  assert.equal(banking.isEnabled(), false);
});

test('the shipped defaults are 90 percent and a 60 percent weak ratio', () => {
  assert.equal(banking.boostCeiling(), 90);
  assert.equal(banking.weakRatioPct(), 60);
});

test('settings are matched strictly, so a fractional value cannot be truncated into action', () => {
  // parseInt('95.9') is 95. Acting on that would silently pick a ceiling the
  // owner never typed, which is how the three-phase bug doubled watts per amp.
  db.setSetting('opportunistic_charge_limit_pct', '95.9');
  assert.equal(banking.boostCeiling(), 90, 'falls back rather than truncating');

  db.setSetting('opportunistic_charge_limit_pct', 'abc');
  assert.equal(banking.boostCeiling(), 90);

  db.setSetting('opportunistic_charge_limit_pct', '140');   // above Tesla's max
  assert.equal(banking.boostCeiling(), 90);

  db.setSetting('opportunistic_charge_limit_pct', '40');    // below Tesla's min
  assert.equal(banking.boostCeiling(), 90);

  db.setSetting('opportunistic_charge_limit_pct', '100');
  assert.equal(banking.boostCeiling(), 100, 'a valid value is honoured');

  db.setSetting('opportunistic_charge_limit_pct', '90');
});

test('an active boost is read back from the database, not from memory', () => {
  assert.equal(banking.activeBoost(), null, 'nothing stored means no boost');

  db.setSetting('opportunistic_boost_baseline_pct', '80');
  db.setSetting('opportunistic_boost_day',          '2026-09-16');
  const active = banking.activeBoost();
  assert.equal(active.baseline, 80);
  assert.equal(active.day, '2026-09-16');

  db.setSetting('opportunistic_boost_baseline_pct', '');
  assert.equal(banking.activeBoost(), null);
});

test('a nonsensical stored baseline is treated as no boost rather than acted on', () => {
  for (const bad of ['0', '30', '120', 'eighty']) {
    db.setSetting('opportunistic_boost_baseline_pct', bad);
    assert.equal(banking.activeBoost(), null, `baseline ${bad} should be ignored`);
  }
  db.setSetting('opportunistic_boost_baseline_pct', '');
});
