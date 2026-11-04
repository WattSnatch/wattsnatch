/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Spent and saved, per load and in total, for today, this month and this year, published to
// Home Assistant over MQTT.
//
// Pinned here: the figures are the Data page's own (one reconciled breakdown, per-load spend
// adding up to the metered import cost); HA gets monetary sensors it accepts (state_class
// 'total' with a last_reset, since money can go negative and starts again each period); each
// period is refreshed on its own interval and straight away when it rolls over; a failed
// calculation never throws into the caller. Runs against a throwaway DB with a fake broker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-mqttcosts-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const mqttPublisher = require('../src/services/mqttPublisher');

let published;
const fakeClient = { publish: (topic, msg, opts) => published.push({ topic, msg, opts }) };

test.beforeEach(() => {
  published = [];
  mqttPublisher._setClientForTests(fakeClient);
});
test.after(() => {
  mqttPublisher._setClientForTests(null);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true });
});

// A day of readings: solar in the middle of the day, grid at night, car and hot water on solar.
function seed(dayStart) {
  const raw = db.getDb();
  raw.prepare('DELETE FROM telemetry_log').run();
  const ins = raw.prepare(`INSERT INTO telemetry_log (recorded_at, solar_w, consumption_w, grid_w, solar_excess_w, ev_w, eddi_w, charge_amps, battery_pct, controller_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 50, 'IDLE')`);
  for (let t = dayStart; t < dayStart + 86400e3; t += 60e3) {
    const hour = new Date(t).getHours();
    const sunny = hour >= 9 && hour < 15;
    const ev = sunny && hour < 12 ? 3000 : 0;
    const eddi = sunny && hour >= 12 ? 2000 : 0;
    const house = 600;
    const solar = sunny ? 5000 : 0;
    const consumption = house + ev + eddi;
    ins.run(t, solar, consumption, consumption - solar, solar - consumption, ev, eddi);
  }
}

// ── The figures ──────────────────────────────────────────────────────────────────────────────

test('the message carries every figure from the breakdown, and an absent load reads 0', () => {
  const b = {
    categories: [
      { key: 'house', grid_cost_aud: 1.65, est_savings_aud: 4.01 },
      { key: 'car',   grid_cost_aud: 0.06, est_savings_aud: 3.61 },
    ],
    grid: { import_cost: 1.71, export_credit: 0.25 },
    est_savings_aud: 7.62,
    supply_charge_aud: 1.32,
    net_cost_aud: 2.78,
  };
  const start = new Date(2026, 10, 4).getTime();
  assert.deepEqual(mqttPublisher._costPayload(b, start), {
    last_reset: new Date(start).toISOString(),
    car_spent: 0.06, car_saved: 3.61,
    hot_water_spent: 0, hot_water_saved: 0,
    house_spent: 1.65, house_saved: 4.01,
    total_spent: 1.71, total_saved: 7.62,
    export_credit: 0.25, supply_charge: 1.32, net_cost: 2.78,
  });
});

test('on real readings the published figures are the Data page\'s, and the loads add up to the total', () => {
  db.addRate(0.30, 0);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  seed(today - 86400e3);   // yesterday, so "this month" and "this year" have a full day in them
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  mqttPublisher.publishCosts({ force: true, now });
  const year = JSON.parse(published.find((p) => p.topic === 'wattsnatch/costs/year').msg);
  const b = db.getEnergyBreakdownForPeriod(yearStart, now.getTime());
  assert.equal(year.total_spent, b.grid.import_cost);
  assert.equal(year.total_saved, b.est_savings_aud);
  assert.equal(year.net_cost, b.net_cost_aud);
  assert.ok(year.total_spent > 0 && year.car_saved > 0 && year.hot_water_saved > 0, 'non-trivial data');
  const sum = Math.round((year.car_spent + year.hot_water_spent + year.house_spent) * 100) / 100;
  assert.equal(sum, year.total_spent, 'per-load spend adds up to the metered import cost');
});

// ── What Home Assistant is told ─────────────────────────────────────────────────────────────

test('33 monetary sensors HA accepts, each with its own id, reading its own field', () => {
  const device = { identifiers: ['wattsnatch_costs'] };
  const configs = [];
  for (const p of mqttPublisher.COST_PERIODS) for (const f of mqttPublisher.COST_FIGURES) {
    configs.push(mqttPublisher._costDiscoveryConfig(p, f, device));
  }
  assert.equal(configs.length, 33);
  assert.equal(new Set(configs.map((c) => c.unique_id)).size, 33);
  for (const c of configs) {
    assert.equal(c.device_class, 'monetary');
    assert.equal(c.state_class, 'total', 'HA rejects total_increasing for money');
    assert.equal(c.last_reset_value_template, '{{ value_json.last_reset }}');
    assert.match(c.state_topic, /^wattsnatch\/costs\/(today|month|year)$/);
    assert.match(c.value_template, /^\{\{ value_json\.[a-z_]+ \}\}$/);
  }
  const carToday = configs.find((c) => c.unique_id === 'wattsnatch_cost_today_car_spent');
  assert.equal(carToday.name, 'Car Spent Today');
  assert.equal(carToday.value_template, '{{ value_json.car_spent }}');
});

test('the currency follows the country setting', () => {
  const p = mqttPublisher.COST_PERIODS[0];
  const f = mqttPublisher.COST_FIGURES[0];
  db.setSetting('country', 'AU');
  assert.equal(mqttPublisher._costDiscoveryConfig(p, f, {}).unit_of_measurement, 'AUD');
  db.setSetting('country', 'US');
  assert.equal(mqttPublisher._costDiscoveryConfig(p, f, {}).unit_of_measurement, 'USD');
  db.setSetting('country', 'AU');
});

// ── When it publishes ───────────────────────────────────────────────────────────────────────

const topics = () => published.map((p) => p.topic.split('/').pop()).sort();

test('first check publishes all three periods, retained', () => {
  mqttPublisher.publishCosts({ now: new Date(2026, 10, 4, 10, 0) });
  assert.deepEqual(topics(), ['month', 'today', 'year']);
  assert.ok(published.every((p) => p.opts && p.opts.retain));
});

test('today and this month every minute, this year every 15 minutes', () => {
  const t0 = new Date(2026, 10, 4, 10, 0).getTime();
  mqttPublisher.publishCosts({ now: new Date(t0) });
  published = [];
  mqttPublisher.publishCosts({ now: new Date(t0 + 30e3) });
  assert.deepEqual(topics(), [], 'nothing due after 30 s');
  mqttPublisher.publishCosts({ now: new Date(t0 + 61e3) });
  assert.deepEqual(topics(), ['month', 'today']);
  published = [];
  mqttPublisher.publishCosts({ now: new Date(t0 + 15 * 60e3) });
  assert.deepEqual(topics(), ['month', 'today', 'year']);
});

test('a period that rolls over is republished straight away with the new start', () => {
  mqttPublisher.publishCosts({ now: new Date(2026, 11, 31, 23, 59, 30) });
  published = [];
  mqttPublisher.publishCosts({ now: new Date(2027, 0, 1, 0, 0, 5) });   // 35 s later, new year
  assert.deepEqual(topics(), ['month', 'today', 'year']);
  const year = JSON.parse(published.find((p) => p.topic.endsWith('/year')).msg);
  assert.equal(year.last_reset, new Date(2027, 0, 1).toISOString());
});

test('force republishes everything (used on connect)', () => {
  const now = new Date(2026, 10, 4, 10, 0);
  mqttPublisher.publishCosts({ now });
  published = [];
  mqttPublisher.publishCosts({ now, force: true });
  assert.deepEqual(topics(), ['month', 'today', 'year']);
});

test('nothing is published while disconnected', () => {
  mqttPublisher._setClientForTests(null);
  mqttPublisher.publishCosts({ force: true });
  assert.deepEqual(published, []);
});

test('a failed calculation is kept for the status display, not thrown', () => {
  const orig = db.getEnergyBreakdownForPeriod;
  db.getEnergyBreakdownForPeriod = () => { throw new Error('database is locked'); };
  try {
    assert.doesNotThrow(() => mqttPublisher.publishCosts({ force: true }));
    assert.equal(mqttPublisher.getState().costError, 'database is locked');
    assert.deepEqual(published, []);
  } finally {
    db.getEnergyBreakdownForPeriod = orig;
  }
  mqttPublisher.publishCosts({ force: true });
  assert.equal(mqttPublisher.getState().costError, null, 'cleared once it works again');
});
