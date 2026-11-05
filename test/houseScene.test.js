/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// GET /api/house-scene's data (src/services/houseScene.js): panels on the face their nickname
// names, the house turned to show the most of them, latest output (zero once stale), the
// month's peak, a clear-day reference, and no serials or coordinates sent to the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-housescene-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const hs = require('../src/services/houseScene');

test.after(() => { for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true }); });

test('nicknames name the face and the order', () => {
  const cases = {
    'North 3': { face: 'N', order: 3 }, 'west 1': { face: 'W', order: 1 }, 'S2': { face: 'S', order: 2 },
    'E-4': { face: 'E', order: 4 }, 'South': { face: 'S', order: null }, 'Garage left 2': { face: null, order: 2 },
    'Northern': { face: null, order: null }, '': { face: null, order: null },
  };
  for (const [name, want] of Object.entries(cases)) assert.deepEqual(hs.parseNickname(name), want, name);
});

test('the house turns to show the most panels', () => {
  assert.deepEqual(hs.chooseTurn({ N: 8, W: 5, S: 2 }), { front: 'N', side: 'W', back: 'S', hidden: 'E' });
  assert.equal(hs.chooseTurn({ S: 10, E: 4 }).front, 'S');
  assert.equal(hs.chooseTurn({ E: 6, N: 6 }).front, 'E', 'E front, N side shows both');
  assert.equal(hs.chooseTurn({}).front, 'N');
});

function seed(now, { ageMs = 60e3 } = {}) {
  const raw = db.getDb();
  raw.prepare('DELETE FROM panel_production').run();
  raw.prepare('DELETE FROM telemetry_log').run();
  const ins = raw.prepare('INSERT INTO panel_production (recorded_at, panel_id, wh_produced, irradiance_approx) VALUES (?, ?, ?, 0)');
  const ids = { '100000000001': 'North 2', '100000000002': 'North 1', '100000000003': 'West 1', '100000000004': 'South 1', '100000000005': '' };
  for (const id of Object.keys(ids)) {
    ins.run(now - 3 * 86400e3, id, 390);                    // the month's best
    ins.run(now - ageMs, id, 200 + Number(id.slice(-1)));    // latest
  }
  db.setSetting('panel_nicknames', JSON.stringify(Object.fromEntries(Object.entries(ids).filter(([, v]) => v))));
  const tl = raw.prepare(`INSERT INTO telemetry_log (recorded_at, solar_w, consumption_w, grid_w, solar_excess_w, ev_w, eddi_w, charge_amps, battery_pct, controller_state)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0, 50, 'IDLE')`);
  tl.run(now - 2 * 86400e3 + 5 * 60e3, 5200);   // two days ago, 5 minutes later in the day
  tl.run(now - 3 * 86400e3 - 30 * 60e3, 6400);  // outside the 10-minute window
  hs._resetCacheForTests();
}

test('panels: placed by nickname, ordered, latest output, the month\'s peak, no serials', () => {
  const now = Date.now();
  seed(now);
  const s = hs.getScene(now);
  assert.deepEqual(s.panels.map((p) => [p.name, p.place, p.watts]), [
    ['North 1', 'front', 202], ['West 1', 'side', 203], ['South 1', 'back', 204],
    ['North 2', 'front', 201], [null, 'front', 205],      // unnamed goes on the main face, last
  ]);
  assert.equal(s.peakW, 390);
  assert.equal(s.clearDayW, 5200);
  assert.deepEqual(s.turn, { front: 'N', side: 'W' });
  assert.ok(!JSON.stringify(s).includes('10000000000'), 'serial numbers stay on the server');
});

test('stale panel readings show as zero', () => {
  const now = Date.now();
  seed(now, { ageMs: 40 * 60e3 });
  const s = hs.getScene(now);
  assert.ok(s.stale);
  assert.ok(s.panels.every((p) => p.watts === 0));
});

test('sky: weather and today\'s sunrise and sunset, never the coordinates', () => {
  const now = Date.now();
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  db.upsertWeatherCache({
    current: { cloudCover: 40, weatherCode: 2, label: 'Partly cloudy', windKmh: 12 },
    daily: [{ date: day, sunrise: `${day}T05:10`, sunset: `${day}T18:40` }],
    lat: -12.3456, lng: 123.4567,
  });
  hs._resetCacheForTests();
  const s = hs.getScene(now);
  assert.equal(s.sky.cloudCover, 40);
  assert.equal(new Date(s.sky.sunrise).getHours(), 5);
  assert.equal(new Date(s.sky.sunset).getMinutes(), 40);
  assert.ok(!JSON.stringify(s).includes('123.4567'));
});

test('no panel data: an empty list, not an error', () => {
  db.getDb().prepare('DELETE FROM panel_production').run();
  hs._resetCacheForTests();
  assert.deepEqual(hs.getScene().panels, []);
});

test('the route exists and the dashboard polls it while the house view is on', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');
  assert.match(api, /router\.get\('\/api\/house-scene'/);
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
  assert.match(dash, /setInterval\(loadHouseScene, 60 \* 1000\)/);
  assert.match(dash, /scene: _houseScene/);
});
