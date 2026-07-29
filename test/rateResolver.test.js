/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Runs against a throwaway SQLite file (WATTSNATCH_DB_PATH), never the real
// database - see the module-level setup below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('fresh install defaults to flat mode at the seeded rate', () => {
  assert.equal(db.getSetting('electricity_rate_mode'), 'flat');
  const rate = db.getRateAtTimestamp(Date.now());
  assert.equal(rate, 0.30); // seeded from electricity_rate_aud default
});

test('flat mode: a later rate change only applies from its effective date onward', () => {
  const changeDate = new Date('2026-06-01').getTime();
  db.addRate(0.28, changeDate);

  assert.equal(db.getRateAtTimestamp(new Date('2026-05-31').getTime()), 0.30, 'before the change, old rate applies');
  assert.equal(db.getRateAtTimestamp(changeDate), 0.28, 'exactly at the effective date, new rate applies');
  assert.equal(db.getRateAtTimestamp(new Date('2026-07-01').getTime()), 0.28, 'after the change, new rate applies');
});

test('createRateResolver (flat mode) matches getRateAtTimestamp for the same instant', () => {
  const resolve = db.createRateResolver();
  const now = Date.now();
  assert.equal(resolve(now), db.getRateAtTimestamp(now));
});

test('TOU mode: falls back to flat rate before the TOU config takes effect', () => {
  db.setSetting('electricity_rate_mode', 'tou');
  const configId = db.addTouConfig({
    default_rate_aud: 0.20,
    effective_from: new Date('2026-07-01').getTime(),
    windows: [
      { label: 'Peak', rate_aud: 0.55, days: [1, 2, 3, 4, 5], start_time: '15:00', end_time: '21:00' },
    ],
  });

  try {
    const beforeTou = new Date('2026-06-15').getTime();
    assert.equal(db.getRateAtTimestamp(beforeTou), 0.28, 'before the TOU config exists, flat history still applies');
  } finally {
    db.deleteTouConfig(configId);
    db.setSetting('electricity_rate_mode', 'flat');
  }
});

test('TOU mode: resolves the matching window by day and time, and the default rate outside all windows', () => {
  db.setSetting('electricity_rate_mode', 'tou');
  const configId = db.addTouConfig({
    default_rate_aud: 0.20,
    effective_from: new Date('2026-07-01').getTime(),
    windows: [
      { label: 'Peak', rate_aud: 0.55, days: [1, 2, 3, 4, 5], start_time: '15:00', end_time: '21:00' },
    ],
  });

  try {
    // 2026-07-13 is a Monday.
    const mondayPeak    = new Date('2026-07-13T16:00:00').getTime();
    const mondayOffPeak = new Date('2026-07-13T09:00:00').getTime();
    // 2026-07-12 is a Sunday - the Peak window only covers weekdays.
    const sundaySamePeakHour = new Date('2026-07-12T16:00:00').getTime();

    assert.equal(db.getRateAtTimestamp(mondayPeak), 0.55, 'inside the peak window on a weekday');
    assert.equal(db.getRateAtTimestamp(mondayOffPeak), 0.20, 'outside the peak window, same weekday');
    assert.equal(db.getRateAtTimestamp(sundaySamePeakHour), 0.20, 'same clock time but a weekend, peak window excludes it');
  } finally {
    db.deleteTouConfig(configId);
    db.setSetting('electricity_rate_mode', 'flat');
  }
});

test('TOU mode: an overnight window (e.g. 22:00-07:00) wraps across midnight correctly', () => {
  db.setSetting('electricity_rate_mode', 'tou');
  const configId = db.addTouConfig({
    default_rate_aud: 0.30,
    effective_from: 0,
    windows: [
      { label: 'Off-peak', rate_aud: 0.15, days: [0, 1, 2, 3, 4, 5, 6], start_time: '22:00', end_time: '07:00' },
    ],
  });

  try {
    const lateNight = new Date('2026-07-13T23:30:00').getTime();
    const earlyMorning = new Date('2026-07-14T05:00:00').getTime();
    const midday = new Date('2026-07-13T13:00:00').getTime();

    assert.equal(db.getRateAtTimestamp(lateNight), 0.15, 'late night falls inside the overnight window');
    assert.equal(db.getRateAtTimestamp(earlyMorning), 0.15, 'early morning falls inside the overnight window');
    assert.equal(db.getRateAtTimestamp(midday), 0.30, 'midday falls outside the overnight window');
  } finally {
    db.deleteTouConfig(configId);
    db.setSetting('electricity_rate_mode', 'flat');
  }
});

// ── Export (feed-in) rate resolver - mirrors the import-rate tests above ──────

test('export rate: defaults to flat mode, falling back to the flat feed-in tariff', () => {
  assert.equal(db.getSetting('export_rate_mode'), 'flat');
  assert.equal(db.getExportRateAtTimestamp(Date.now()), db.getTariffAtDate('feed_in', Date.now()));
});

test('createExportRateResolver (flat mode) matches getExportRateAtTimestamp for the same instant', () => {
  const resolve = db.createExportRateResolver();
  const now = Date.now();
  assert.equal(resolve(now), db.getExportRateAtTimestamp(now));
});

test('export TOU mode: falls back to flat feed-in tariff before the export config takes effect', () => {
  db.setSetting('export_rate_mode', 'tou');
  const configId = db.addExportConfig({
    default_rate_aud: 0.02,
    effective_from: new Date('2026-07-01').getTime(),
    windows: [
      { label: 'Midday near-zero', rate_aud: 0.01, days: [0, 1, 2, 3, 4, 5, 6], start_time: '10:00', end_time: '16:00' },
    ],
  });

  try {
    const beforeConfig = new Date('2026-06-15').getTime();
    assert.equal(
      db.getExportRateAtTimestamp(beforeConfig),
      db.getTariffAtDate('feed_in', beforeConfig),
      'before the export config exists, flat feed-in tariff still applies'
    );
  } finally {
    db.deleteExportConfig(configId);
    db.setSetting('export_rate_mode', 'flat');
  }
});

test('export TOU mode: resolves a NEM-3.0-style near-zero midday window vs. the default rate outside it', () => {
  db.setSetting('export_rate_mode', 'tou');
  const configId = db.addExportConfig({
    default_rate_aud: 0.08,
    effective_from: new Date('2026-07-01').getTime(),
    windows: [
      { label: 'Midday near-zero', rate_aud: 0.01, days: [0, 1, 2, 3, 4, 5, 6], start_time: '10:00', end_time: '16:00' },
    ],
  });

  try {
    // 2026-07-13 is a Monday.
    const midday = new Date('2026-07-13T12:00:00').getTime();
    const evening = new Date('2026-07-13T19:00:00').getTime();

    assert.equal(db.getExportRateAtTimestamp(midday), 0.01, 'inside the near-zero midday export window');
    assert.equal(db.getExportRateAtTimestamp(evening), 0.08, 'outside the window, the higher default export rate applies');
  } finally {
    db.deleteExportConfig(configId);
    db.setSetting('export_rate_mode', 'flat');
  }
});

test('import and export TOU modes are independent - configuring one does not affect the other', () => {
  db.setSetting('electricity_rate_mode', 'flat');
  db.setSetting('export_rate_mode', 'tou');
  const configId = db.addExportConfig({
    default_rate_aud: 0.01,
    effective_from: 0,
    windows: [],
  });

  try {
    const now = Date.now();
    assert.equal(db.getExportRateAtTimestamp(now), 0.01, 'export TOU config applies');
    assert.equal(db.getRateAtTimestamp(now), db.getFlatRateAtDate(now), 'import rate is unaffected, still flat');
  } finally {
    db.deleteExportConfig(configId);
    db.setSetting('export_rate_mode', 'flat');
  }
});

test('deleteRate refuses to remove the only remaining rate entry', () => {
  const rates = db.getRates();
  // Delete all but one, then the last delete should throw.
  for (let i = 0; i < rates.length - 1; i++) db.deleteRate(rates[i].id);
  const remaining = db.getRates();
  assert.equal(remaining.length, 1);
  assert.throws(() => db.deleteRate(remaining[0].id), /Cannot delete the only rate entry/);
});
