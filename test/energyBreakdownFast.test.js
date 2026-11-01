/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The Data page took up to a minute to switch time frames.
//
// Two causes. The energy breakdown read every row of the period through a LEAD() window
// function with each row built as an object, which for a year was 1.4 million objects and
// about 6.5 seconds. And the short cache in front of it keyed on the exact millisecond end of
// the period, so a period ending "now" never hit it.
//
// The breakdown now streams rows as arrays and works out each row's interval from the next
// row in JavaScript. The figures must be byte-identical to the original, because they are
// reconciled against real bills, so the original implementation is kept here as the reference
// and the two are compared on deliberately awkward data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-breakdown-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const raw = db.getDb();

test.after(() => { for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true }); });

// The original row read and loop, verbatim apart from returning the raw accumulators that feed
// the shared rounding code. Used only as the reference.
function referenceAccumulate(startMs, endMs) {
  const resolveRate = db.createRateResolver();
  const resolveExportRate = db.createExportRateResolver();
  const rows = raw.prepare(`
    SELECT recorded_at, grid_w, MAX(0.0, consumption_w) AS consumption_w,
      MAX(0.0, COALESCE(eddi_w, 0)) AS load_hot_water,
      MAX(0.0, COALESCE(ev_w, 0)) AS load_car,
      MIN(COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 5000), 120000) / 3600000.0 AS interval_h
    FROM telemetry_log WHERE recorded_at >= ? AND recorded_at < ?`).all(startMs, endMs);
  const cats = ['house', 'hot_water', 'car'];
  const submeters = ['hot_water', 'car'];
  const gridOrder = [...cats].reverse();
  const agg = new Map(cats.map((k) => [k, { load: 0, solar: 0, grid: 0, gridCost: 0, saving: 0 }]));
  let kwhImported = 0, kwhExported = 0, importCost = 0, exportCredit = 0, unexplainedKwh = 0, coveredHours = 0;
  const days = new Set();
  for (const r of rows) {
    const h = r.interval_h;
    coveredHours += h;
    days.add(Math.floor(r.recorded_at / 86400000));
    const gridW = r.grid_w || 0;
    const rate = resolveRate(r.recorded_at);
    if (gridW < -50) { const kwh = -gridW * h / 1000.0; kwhExported += kwh; exportCredit += kwh * resolveExportRate(r.recorded_at); }
    let submeterW = 0; const load = new Map();
    for (const k of submeters) { const w = Math.max(0, r[`load_${k}`] || 0); load.set(k, w); submeterW += w; }
    const importW = gridW > 50 ? gridW : 0;
    let houseW = Math.max(0, r.consumption_w - submeterW);
    const unexplainedW = Math.max(0, importW - (houseW + submeterW));
    houseW += unexplainedW; unexplainedKwh += unexplainedW * h / 1000.0; load.set('house', houseW);
    let remaining = importW;
    for (const k of gridOrder) {
      const catLoad = load.get(k) || 0; const catGrid = Math.min(catLoad, remaining); remaining -= catGrid;
      const a = agg.get(k); const loadKwh = catLoad * h / 1000.0; const gridKwh = catGrid * h / 1000.0; const solarKwh = loadKwh - gridKwh;
      a.load += loadKwh; a.grid += gridKwh; a.solar += solarKwh; a.gridCost += gridKwh * rate; a.saving += solarKwh * rate;
    }
    if (importW > 0) { const kwh = importW * h / 1000.0; kwhImported += kwh; importCost += kwh * rate; }
  }
  return { kwhImported, kwhExported, importCost, exportCredit, unexplainedKwh, coveredHours, days: days.size,
    agg: Object.fromEntries([...agg].map(([k, v]) => [k, { ...v }])) };
}

const T0 = new Date(2026, 5, 1).getTime();
function seed() {
  raw.prepare('DELETE FROM telemetry_log').run();
  const ins = raw.prepare(`INSERT INTO telemetry_log (recorded_at, solar_w, consumption_w, grid_w, solar_excess_w, ev_w, eddi_w, charge_amps, battery_pct, controller_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 50, 'IDLE')`);
  let t = T0;
  let seedN = 12345;
  const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  for (let i = 0; i < 20000; i++) {
    // Mostly 10 s apart, with gaps (capped at 2 min), duplicates (0 s) and long outages.
    const r = rnd();
    t += r < 0.005 ? 3 * 3600e3 : r < 0.02 ? 0 : r < 0.05 ? 90e3 : 10e3;
    const solar = Math.max(0, Math.round(5000 * Math.sin((t / 86400e3) * Math.PI * 2) + (rnd() - 0.5) * 800));
    const ev = rnd() < 0.3 ? Math.round(rnd() * 7200) : 0;
    const eddi = rnd() < 0.2 ? Math.round(rnd() * 3000) : 0;
    const house = 300 + Math.round(rnd() * 2500);
    const consumption = house + ev + eddi + (rnd() < 0.05 ? -400 : 0);   // sometimes below the submeters
    const grid = consumption - solar + Math.round((rnd() - 0.5) * 120);  // noise around the deadband
    ins.run(t, solar, consumption, grid, solar - consumption, ev, eddi);
  }
  return t;
}

test('the fast breakdown is byte-identical to the original on awkward data', () => {
  const end = seed();
  const windows = [
    [T0, end + 1], [T0 + 3 * 86400e3, T0 + 9 * 86400e3], [T0 + 12345678, T0 + 98765432],
    [T0 + 86400e3, T0 + 86400e3 + 60e3], [T0 - 86400e3, T0], [end - 3600e3, end + 1],
  ];
  for (const [a, b] of windows) {
    const fast = db._getEnergyBreakdownUncached(a, b);
    const ref = referenceAccumulate(a, b);
    const round2 = (n) => Math.round(n * 100) / 100;
    assert.equal(fast.grid.kwh_imported, round2(ref.kwhImported), `import ${a}-${b}`);
    assert.equal(fast.grid.kwh_exported, round2(ref.kwhExported), `export ${a}-${b}`);
    assert.equal(fast.grid.import_cost, round2(ref.importCost), `import cost ${a}-${b}`);
    assert.equal(fast.grid.export_credit, round2(ref.exportCredit), `export credit ${a}-${b}`);
    assert.equal(fast.unexplained_kwh, round2(ref.unexplainedKwh), `unexplained ${a}-${b}`);
    assert.equal(fast.days_recorded, ref.days, `days ${a}-${b}`);
    for (const c of fast.categories) {
      assert.equal(c.load_kwh, round2(ref.agg[c.key].load), `${c.key} load ${a}-${b}`);
      assert.equal(c.est_savings_aud, round2(ref.agg[c.key].saving), `${c.key} saving ${a}-${b}`);
    }
  }
});

test('a duplicate timestamp and a long outage are handled exactly as before', () => {
  raw.prepare('DELETE FROM telemetry_log').run();
  const ins = raw.prepare(`INSERT INTO telemetry_log (recorded_at, solar_w, consumption_w, grid_w, solar_excess_w, ev_w, eddi_w, charge_amps, battery_pct, controller_state)
    VALUES (?, 0, 2000, 2000, -2000, 0, 0, 0, 50, 'IDLE')`);
  for (const t of [T0, T0, T0 + 10e3, T0 + 4 * 3600e3]) ins.run(t);
  const fast = db._getEnergyBreakdownUncached(T0, T0 + 5 * 3600e3);
  const ref = referenceAccumulate(T0, T0 + 5 * 3600e3);
  assert.equal(fast.grid.kwh_imported, Math.round(ref.kwhImported * 100) / 100);
  // 0 s + 10 s + 120 s (capped) + 5 s (last row) of 2 kW
  assert.ok(Math.abs(ref.coveredHours - (135 / 3600)) < 1e-12);
});

// ── The cache in front of it ─────────────────────────────────────────────────────────────────

test('a period ending "now" is served from the cache on the next request', () => {
  seed();
  const start = T0;
  const t1 = Date.now();
  const first = db.getEnergyBreakdownForPeriod(start, t1);
  let called = false;
  const orig = raw.prepare;
  raw.prepare = function (...args) { called = true; return orig.apply(this, args); };
  try {
    const second = db.getEnergyBreakdownForPeriod(start, t1 + 3000);   // a later "now"
    assert.equal(called, false, 'no query: served from the cache');
    assert.deepEqual(second, first);
  } finally {
    raw.prepare = orig;
  }
});

test('a period ending in the past keeps its own cache entry, not the live one', () => {
  const past = db.getEnergyBreakdownForPeriod(T0, T0 + 86400e3);
  const live = db.getEnergyBreakdownForPeriod(T0, Date.now());
  assert.notDeepEqual(past, live);
});

test('the Data page reuses its responses when switching time frames', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'history-v2.js'), 'utf8');
  assert.match(src, /const fresh = _periodFetch && _periodFetch\.qs === qs && \(Date\.now\(\) - _periodFetch\.at\) < PERIOD_FETCH_TTL_MS;/);
  assert.match(src, /_periodFetch\.promise\.catch\(\(\) => \{ _periodFetch = null; \}\);/, 'a failed fetch is not reused');
});
