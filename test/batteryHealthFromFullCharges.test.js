/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Battery health must come from charges that finished full, not ones that started full.
//
// The query filtered on start_battery_level >= 97 and read the range at the start of the
// session. A charge that begins nearly full is rare for anyone and never happens for an
// owner who charges to 80%. On one install 0 of 779 sessions qualified while 12 had
// finished at 97% or more, so the health card was empty for the entire life of the
// install and could never have shown a value.
//
// Two further corrections ride along, both found in that same install's data.
//
// Readings are normalised to 100%. Ideal range at 97% and 100% differs by about three
// percent, which is the size of a year of real degradation. A 98% charge that read
// 416.9 km would otherwise look like wear rather than the 425.5 km it represents.
//
// "Recent" falls back to the latest full charge, never the all-time best. That install had
// exactly one full charge in the 90-day window. When it aged out, the old fallback compared
// the all-time best with itself and would have reported exactly 100%, on a schedule.
//
// The numbers used below are that install's real readings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-batthealth-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const { computeBatteryHealth } = require('../src/services/teslamate');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'teslamate.js'), 'utf8');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

// A real install: best full charge 433.15 km (Feb), the only one in the last 90 days 419.91 km.
const REAL = { recent_max_km: '419.91', latest_km: '419.91', all_time_max_km: '433.15', efficiency_factor: '0.155' };

test('a real history of full charges produces a health figure', () => {
  const r = computeBatteryHealth(REAL, NaN);
  assert.ok(r, 'the card was empty for the whole life of this install; it must not be now');
  assert.equal(r.health_pct, 96.9, '419.91 / 433.15');
  assert.equal(r.recent_max_range_km, 420);
  assert.equal(r.all_time_max_range_km, 433);
});

test('when the recent window is empty, the latest full charge is used, not the all-time best', () => {
  // The old fallback compared the all-time best with itself and read exactly 100%.
  const agedOut = { ...REAL, recent_max_km: null };
  const r = computeBatteryHealth(agedOut, NaN);
  assert.equal(r.health_pct, 96.9, 'must still reflect the latest measurement');
  assert.notEqual(r.health_pct, 100, 'a window ageing out must not manufacture perfect health');
});

test('the configured battery capacity is scaled by measured health', () => {
  // Issue #16: the owner's own figure beats a model-specific constant.
  const r = computeBatteryHealth(REAL, 82);
  assert.equal(r.usable_kwh, 79.5, '96.9% of 82 kWh');
});

test('without a configured capacity it falls back to the range estimate', () => {
  const r = computeBatteryHealth(REAL, NaN);
  assert.equal(r.usable_kwh, 65.1, '419.91 km x 0.155 kWh/km');
});

test('no full charges at all means no figure, rather than an invented one', () => {
  assert.equal(computeBatteryHealth({ all_time_max_km: null }, 82), null);
  assert.equal(computeBatteryHealth(null, 82), null);
  assert.equal(computeBatteryHealth(undefined, 82), null);
});

test('unusable values are refused rather than turned into a percentage', () => {
  assert.equal(computeBatteryHealth({ ...REAL, all_time_max_km: '0' }, 82), null, 'division by zero');
  assert.equal(computeBatteryHealth({ ...REAL, all_time_max_km: 'abc' }, 82), null);
  assert.equal(computeBatteryHealth({ ...REAL, recent_max_km: null, latest_km: null }, 82), null);
});

// ── The query itself ─────────────────────────────────────────────────────────
// It runs against TeslaMate's Postgres, which the suite does not stand up, so the SQL is
// pinned at source level. Each check isolates the query first so it cannot pass vacuously.

const fnStart = src.indexOf("const getBatteryHealthPercent = cached('battery_health'");
const sql = src.slice(fnStart, src.indexOf('});', fnStart));

test('the query is found', () => {
  assert.ok(fnStart >= 0, 'getBatteryHealthPercent must be found');
  assert.ok(sql.length > 100, 'and its body must be substantial');
});

test('it selects charges by how full they ENDED', () => {
  assert.match(sql, /WHERE end_battery_level >= \$\{BATTERY_HEALTH_MIN_END_SOC\}/,
    'filtering on the end of the session is the entire fix');
  assert.ok(!/start_battery_level\s*>=/.test(sql),
    'the start-of-session filter matched 0 of 779 real sessions and must not return');
  assert.match(src, /const BATTERY_HEALTH_MIN_END_SOC = 97;/,
    'near full, so the ideal range reading is not extrapolated far');
});

test('it reads the range at the end of the charge, normalised to 100%', () => {
  assert.match(sql, /end_ideal_range_km \* 100\.0 \/ end_battery_level AS norm_km/,
    'comparing a 97% reading with a 100% one raw reports three percent of noise as health');
  assert.ok(!/start_ideal_range_km/.test(sql),
    'the range at the start of a charge says nothing about capacity');
});

test('it supplies the latest reading so an empty recent window has somewhere to fall back', () => {
  assert.match(sql, /ORDER BY start_date DESC LIMIT 1\)\s*AS latest_km/,
    'without this the fallback can only be the all-time best, which reads as 100%');
});
