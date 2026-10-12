/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Issue #27: the trip planner's numbers did not add up.
//
// Two real faults, replayed here with the reporter's own figures (a 207 km each-way trip needing
// 78.6 kWh, 146% of a 53.8 kWh usable pack, starting from 89%):
//
//   1. Expected solar before departure was overstated. Solcast rows are average kW over half an
//      hour, but the sum was multiplied by (half-hours in window / 48), which is only right for a
//      12-hour window. 40 hours out it credited about 3.3 times the forecast, so the planner
//      promised solar that never came and asked for too little grid charging.
//   2. A trip bigger than the battery got an impossible plan: "Need 18.6 kWh from grid" into a
//      battery with room for about 6, and "need 100% to depart" silently capped, hiding that even
//      a full battery is not enough and a charging stop is required.
//
// Runs against a throwaway DB with TeslaMate and live telemetry stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-issue27-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const solcast = require('../src/services/solcast');
const teslamate = require('../src/services/teslamate');
const telemetry = require('../src/services/telemetry');
const tripPlanner = require('../src/services/tripPlanner');

const HALF_HOUR = 30 * 60 * 1000;
const HOUR = 2 * HALF_HOUR;
let origTm;
let origState;

/** Replace the forecast with `hours` of flat output at `kw`, starting at `startMs`. */
function seedForecast(startMs, hours, kw) {
  const d = db.getDb();
  d.prepare('DELETE FROM solcast_forecasts').run();
  const ins = d.prepare('INSERT INTO solcast_forecasts (fetched_at, period_start, period_end, pv_estimate_kw) VALUES (?, ?, ?, ?)');
  const fetched = Date.now();
  for (let t = startMs; t < startMs + hours * HOUR; t += HALF_HOUR) ins.run(fetched, t, t + HALF_HOUR, kw);
}

test.before(() => {
  origTm = { ...teslamate };
  origState = telemetry.getState;
  // The reporter's car: 38.9 kWh per 207 km, 0.2 kWh/h sentry, full health.
  teslamate.getEfficiencyKwhPerKm = async () => ({ kwh_per_km: 38.9 / 207 });
  teslamate.getSentryDrainRateKwhPerHour = async () => ({ kwh_per_hour: 0.2 });
  teslamate.getBatteryHealthPercent = async () => ({ health_pct: 100 });
  db.setSetting('tesla_battery_kwh', '53.8');
  db.setSetting('solcast_api_key', 'test-key-not-real');
});

test.after(() => {
  Object.assign(teslamate, origTm);
  telemetry.getState = origState;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

const atSoc = (pct) => { telemetry.getState = () => ({ ...origState(), batteryPct: pct }); };

// ── 1. Solar energy in a window ─────────────────────────────────────────────────────────────

test('solar in a window is power times half an hour, for any window length', () => {
  const start = Math.ceil(Date.now() / HALF_HOUR) * HALF_HOUR;
  for (const hours of [6, 12, 24, 40, 72]) {
    seedForecast(start, hours, 2);                       // 2 kW flat = 2 kWh per hour
    assert.equal(solcast.getExpectedKwhInWindow(start, start + hours * HOUR), 2 * hours, `${hours}h window`);
  }
});

test('the reporter\'s window: 40 hours of forecast is not inflated 3.3 times', () => {
  const start = Math.ceil(Date.now() / HALF_HOUR) * HALF_HOUR;
  seedForecast(start, 40, 0.235);                        // about 9.4 kWh over the window
  const kwh = solcast.getExpectedKwhInWindow(start, start + 40 * HOUR);
  assert.ok(Math.abs(kwh - 9.4) < 0.01, `got ${kwh}`);
});

test('it agrees with the day totals the Solar Forecast card already shows', () => {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
  seedForecast(tomorrow.getTime(), 24, 1.5);
  assert.equal(solcast.getExpectedKwhInWindow(tomorrow.getTime(), tomorrow.getTime() + 24 * HOUR),
    solcast.getTomorrowForecast());
});

// ── 2. A trip bigger than the battery ───────────────────────────────────────────────────────

const REPORTER_TRIP = () => ({
  summary: 'Long day trip', location: 'Destination', distanceKm: 207, eventDurationHours: 4,
  departureTime: Date.now() + 40 * HOUR,
});

test('the reporter\'s trip is recognised as needing a charging stop', async () => {
  atSoc(89);
  seedForecast(Math.ceil(Date.now() / HALF_HOUR) * HALF_HOUR, 40, 0.235);
  const a = await tripPlanner.assessTripFeasibility(REPORTER_TRIP());
  assert.equal(a.status, 'NEEDS_ATTENTION');
  assert.equal(a.exceedsBattery, true);
  // 78.6 needed; 89% of 53.8 is 47.9 kWh, of which 37.1 is above the 20% floor: 41.5 short.
  // Only 5.9 kWh fits before the battery is full, so about 35.6 must come from a charging stop.
  assert.ok(Math.abs(a.required.total - 78.6) < 0.05, `total ${a.required.total}`);
  assert.ok(Math.abs(a.chargeStopKwh - 35.6) < 0.1, `charge stop ${a.chargeStopKwh}`);
  assert.match(a.message, /plan a charging stop on the way/);
});

test('it never asks for more grid energy than the battery can take', async () => {
  atSoc(89);
  db.getDb().prepare('DELETE FROM solcast_forecasts').run();    // no solar at all
  const a = await tripPlanner.assessTripFeasibility(REPORTER_TRIP());
  const roomKwh = 53.8 * (1 - 0.89);
  assert.ok(a.solarShortfall <= roomKwh + 0.01, `asked for ${a.solarShortfall} kWh into ${roomKwh.toFixed(2)} kWh of room`);
  assert.ok(Math.abs(a.solarShortfall - roomKwh) < 0.05, 'with no solar, the grid fills the whole room');
});

test('solar fills the room first, and only what fits counts', async () => {
  atSoc(89);
  const start = Math.ceil(Date.now() / HALF_HOUR) * HALF_HOUR;
  seedForecast(start, 40, 0.5);                          // 20 kWh forecast, 14 kWh credited at 70%
  const a = await tripPlanner.assessTripFeasibility(REPORTER_TRIP());
  assert.equal(a.solarShortfall, 0, 'more solar than room: nothing from the grid');
  assert.match(a.message, /Solar should fill the battery before you leave/);
});

test('a trip that fits the battery is planned exactly as before, without "Approve?"', async () => {
  atSoc(60);
  db.getDb().prepare('DELETE FROM solcast_forecasts').run();
  // 100 km each way is 38.4 kWh: fits in the 43.0 kWh a full battery holds above 20%, not from 60%.
  const trip = { ...REPORTER_TRIP(), distanceKm: 100 };
  const a = await tripPlanner.assessTripFeasibility(trip);
  assert.equal(a.status, 'NEEDS_ATTENTION');
  assert.ok(!a.exceedsBattery);
  assert.doesNotMatch(a.message, /Approve\?/, 'the dashboard has no approve control');
  assert.match(a.message, /needs to come from the grid/);
});

test('a short trip is still simply OK', async () => {
  atSoc(80);
  const a = await tripPlanner.assessTripFeasibility({ ...REPORTER_TRIP(), distanceKm: 20 });
  assert.equal(a.status, 'OK');
  assert.ok(!a.exceedsBattery);
});

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the trips API passes the new fields to the dashboard', () => {
  const api = read('src/routes/api.js');
  assert.match(api, /exceedsBattery: !!assessment\.exceedsBattery/);
  assert.match(api, /chargeStopKwh: assessment\.chargeStopKwh \?\? null/);
});

test('the dashboard shows the charging stop and drops the misleading labels', () => {
  const dash = read('public/js/dashboard.js');
  assert.doesNotMatch(dash, /'5% buffer'/, 'no permanent "5% buffer: 0.00 kWh" row');
  assert.match(dash, /Sentry \(\$\{Math\.round\(trip\.eventDurationHours \?\? 2\)\}h parked\)/,
    'sentry labelled with time parked, which is what it is calculated from, not time until departure');
  assert.match(dash, /if \(trip\.exceedsBattery\) \{[\s\S]{0,200}Charging stop needed/);
  assert.match(dash, /Minimum SoC needed \(incl\. 20% reserve\)/);
});

test('a "0.0 kWh from grid" push notification is never sent', () => {
  const tp = read('src/services/tripPlanner.js');
  assert.match(tp, /if \(assessment\.solarShortfall > 0\) \{\s*notifications\.notifyTripNeedsGridTopUp\(/);
});
