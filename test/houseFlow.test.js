/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The house view of the dashboard's Energy Flow card (public/js/houseFlow.js).
//
// Pinned here: a line is drawn only for power that is moving, and the grid line runs backwards
// while exporting; the callouts show the right figures and units; the car is drawn only when it
// is home; the animation is offset by the clock so a redraw does not restart it; the Settings
// switch is saved, sent to the dashboard and turns the classic diagram off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HouseFlow = require('../public/js/houseFlow.js');

const base = {
  solarW: 4000, homeW: 1800, evW: 0, hwW: 0, gridW: -2200, batteryPct: 80, carHome: true, night: false,
  today: { solar: 36.7, home: 15.3, ev: 6, hw: 6.3, gridImport: 1.9, gridExport: 11 },
  nowMs: 0,
};
const flows = (svg) => [...svg.matchAll(/class="hf-flow hf-flow-(\w+)"/g)].map((m) => m[1]).sort();
const text = (svg) => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('lines are drawn only for power that is moving', () => {
  assert.deepEqual(flows(HouseFlow.render(base)), ['grid', 'home', 'solar']);
  assert.deepEqual(flows(HouseFlow.render({ ...base, evW: 7100, hwW: 2000 })), ['car', 'grid', 'home', 'hw', 'solar']);
  assert.deepEqual(flows(HouseFlow.render({ ...base, solarW: 0, gridW: 30, homeW: 40 })), [], 'under 50 W is not a flow');
});

test('the grid line runs backwards while exporting, forwards while importing', () => {
  const dir = (svg) => svg.match(/hf-flow-grid"[^>]*animation-direction:(\w+)/)[1];
  assert.equal(dir(HouseFlow.render(base)), 'reverse');
  assert.equal(dir(HouseFlow.render({ ...base, gridW: 900 })), 'normal');
});

test('the callouts carry the figures, units and today\'s totals', () => {
  const t = text(HouseFlow.render(base));
  for (const s of ['Solar 4.0 kW', 'Home 1.8 kW', 'Car 0 W 80%', 'Hot water 0 W', 'Grid · export 2.2 kW',
    '36.7 kWh today', '15.3 kWh today', '↓1.9 · ↑11 kWh today']) {
    assert.ok(t.includes(s), `missing "${s}" in: ${t}`);
  }
  assert.ok(text(HouseFlow.render({ ...base, gridW: 640 })).includes('Grid · import 640 W'));
  assert.ok(text(HouseFlow.render({ ...base, gridW: 10 })).includes('Grid 0 W'));
});

test('missing totals and battery are left out, not shown as NaN', () => {
  const svg = HouseFlow.render({ solarW: 0, homeW: null, evW: undefined, gridW: 'x', batteryPct: null, today: {} });
  assert.ok(!/NaN|undefined|null/.test(text(svg)), text(svg));
  assert.ok(!svg.includes('kWh today'));
  assert.ok(!svg.includes('#34d399" dx="4"'), 'no battery percentage');
});

test('the car is drawn only when it is home', () => {
  const home = HouseFlow.render(base);
  const away = HouseFlow.render({ ...base, carHome: false });
  assert.ok(home.includes('fill="#ef4444"') && !away.includes('fill="#ef4444"'));
  assert.ok(text(away).includes('Car · away'));
});

test('night lights the windows and the garage', () => {
  assert.ok(HouseFlow.render({ ...base, night: true }).includes('fill="url(#hfWin)"'));
  assert.ok(HouseFlow.render(base).includes('fill="url(#hfWinDay)"'));
});

test('the animation is offset by the clock, so a redraw continues where it was', () => {
  const delay = (nowMs) => Number(HouseFlow.render({ ...base, nowMs }).match(/hf-flow-solar"[^>]*animation-delay:(-?[\d.]+)s/)[1]);
  assert.equal(delay(0), 0);
  assert.equal(delay(300), -0.3);
  assert.equal(delay(900), 0, 'one full period later it is in the same place');
});

test('compact crops the margins, the full view keeps them', () => {
  assert.match(HouseFlow.render(base), /viewBox="0 0 560 232"/);
  assert.match(HouseFlow.render({ ...base, compact: true }), /viewBox="84 2 446 222"/);
});

test('the drawing is deterministic for the same inputs', () => {
  assert.equal(HouseFlow.render(base), HouseFlow.render({ ...base }));
});

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('Settings saves the switch, and the API accepts it', () => {
  assert.match(read('src', 'routes', 'api.js'), /'dashboard_house_flow',/);
  assert.match(read('public', 'settings.html'), /id="dashboard_house_flow_toggle"/);
  assert.match(read('public', 'js', 'settings.js'), /saveToggleNow\('dashboard_house_flow'/);
});

test('the dashboard is told which view to show, live and on load', () => {
  const ctrl = read('src', 'controller.js');
  assert.equal((ctrl.match(/houseFlowView: db\.getSetting\('dashboard_house_flow'\) === 'true'/g) || []).length, 2);
  const dash = read('public', 'js', 'dashboard.js');
  assert.match(dash, /houseFlowView: s\.houseFlowView/);
  assert.match(dash, /updateHouseFlow\(d, houseNodeW\)/);
  const html = read('public', 'index.html');
  assert.match(html, /<div id="house-flow" class="house-flow"><\/div>/);
  assert.ok(html.indexOf('/js/houseFlow.js') < html.indexOf('/js/dashboard.js'));
  const css = read('public', 'css', 'dashboard.css');
  assert.match(css, /\.flow-section\.house-view \.flow-diagram,/);
});
