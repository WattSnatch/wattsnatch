/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Free power windows: retailer schemes (Solar Sharer and similar) that give
// away electricity for set periods, expressed as events in the calendar the
// user has already connected for trip planning.
//
// Runs against a throwaway SQLite file (WATTSNATCH_DB_PATH), never the real
// database - see the module-level setup below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-fp-test-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const calendar = require('../src/services/calendar');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

const ev = (summary, opts = {}) => ({
  summary,
  location: opts.location || '',
  startDate: opts.startDate || new Date('2026-08-12T11:00:00'),
  endDate: opts.endDate || new Date('2026-08-12T14:00:00'),
  isAllDay: !!opts.isAllDay,
});

// ── Defaults ─────────────────────────────────────────────────────────────────

test('the feature is off on a fresh install', () => {
  assert.equal(db.getSetting('free_power_enabled'), 'false');
  assert.equal(calendar.isFreePowerEnabled(), false);
  // Even with a matching window in the calendar, nothing is active while off.
  assert.equal(calendar.isFreePowerActive(), false);
});

// ── Event matching ───────────────────────────────────────────────────────────

test('matches the default keyword, case-insensitively', () => {
  assert.equal(calendar.isFreePowerEvent(ev('Free Power')), true);
  assert.equal(calendar.isFreePowerEvent(ev('free power')), true);
  assert.equal(calendar.isFreePowerEvent(ev('FREE POWER')), true);
  assert.equal(calendar.isFreePowerEvent(ev('Retailer free power window')), true);
});

test('ignores unrelated events', () => {
  assert.equal(calendar.isFreePowerEvent(ev('Dentist')), false);
  assert.equal(calendar.isFreePowerEvent(ev('Powerlifting class')), false);
  assert.equal(calendar.isFreePowerEvent(ev('Free coffee')), false);
  assert.equal(calendar.isFreePowerEvent(ev('')), false);
});

test('matches the title only, never the location', () => {
  // Driving to somewhere that happens to be called this must not trigger it.
  assert.equal(
    calendar.isFreePowerEvent(ev('Lunch', { location: 'Free Power Cafe, Hobart' })),
    false
  );
});

test('keywords are configurable, including several', () => {
  db.setSetting('free_power_keywords', 'solar sharer, gratis juice');
  assert.equal(calendar.isFreePowerEvent(ev('Solar Sharer window')), true);
  assert.equal(calendar.isFreePowerEvent(ev('gratis juice')), true);
  // The default no longer applies once overridden.
  assert.equal(calendar.isFreePowerEvent(ev('Free Power')), false);

  // Blank entries and stray whitespace must not match everything.
  db.setSetting('free_power_keywords', 'free power, ,  ');
  assert.equal(calendar.isFreePowerEvent(ev('Dentist')), false);
  assert.equal(calendar.isFreePowerEvent(ev('Free Power')), true);

  // An empty setting falls back to the default rather than matching nothing.
  db.setSetting('free_power_keywords', '');
  assert.equal(calendar.isFreePowerEvent(ev('Free Power')), true);
});

test('an event with no start date is never a window', () => {
  assert.equal(calendar.isFreePowerEvent({ summary: 'Free Power' }), false);
});

// ── Window activation ────────────────────────────────────────────────────────
//
// poll() is the only thing that populates the window list, so these stub the
// calendar provider and run a real poll rather than reaching into module state.
// That keeps the tests honest about what the controller actually consumes.

test('active only inside the window, and only while enabled', async () => {
  db.setSetting('free_power_enabled', 'true');
  db.setSetting('free_power_keywords', 'free power');

  const start = new Date('2026-08-12T11:00:00');
  const end   = new Date('2026-08-12T14:00:00');

  const providers = require('../src/services/calendar/index.js');
  const original = providers.getActiveProvider;
  providers.getActiveProvider = () => ({
    label: 'Stub',
    isConfigured: () => true,
    fetchEvents: async () => [
      ev('Free Power', { startDate: start, endDate: end }),
      ev('Dentist', { location: '12 Main St, Hobart' }),
    ],
  });
  db.setSetting('home_latitude', '-42.88');
  db.setSetting('home_longitude', '147.32');

  try {
    await calendar.poll();
    const windows = calendar.getFreePowerWindows();
    assert.equal(windows.length, 1, 'exactly one window detected');
    assert.equal(windows[0].summary, 'Free Power');
    assert.equal(windows[0].startMs, start.getTime());
    assert.equal(windows[0].endMs, end.getTime());

    // Boundaries: start is inclusive, end is exclusive.
    assert.equal(calendar.isFreePowerActive(start.getTime()), true, 'active at start');
    assert.equal(calendar.isFreePowerActive(start.getTime() - 1), false, 'not active just before');
    assert.equal(calendar.isFreePowerActive(end.getTime() - 1), true, 'active just before end');
    assert.equal(calendar.isFreePowerActive(end.getTime()), false, 'not active at end');

    // The active window is reported for the banner/logging.
    const active = calendar.getActiveFreePowerWindow(start.getTime() + 60000);
    assert.ok(active && active.summary === 'Free Power');

    // Turning the feature off makes it inert without clearing the windows.
    db.setSetting('free_power_enabled', 'false');
    assert.equal(calendar.isFreePowerActive(start.getTime()), false);
    assert.equal(calendar.getActiveFreePowerWindow(start.getTime()), null);
    assert.equal(calendar.getFreePowerWindows().length, 1, 'windows still listed for the UI');
  } finally {
    providers.getActiveProvider = original;
  }
});

test('a free power event is never also treated as a trip', async () => {
  db.setSetting('free_power_enabled', 'true');
  const providers = require('../src/services/calendar/index.js');
  const original = providers.getActiveProvider;
  providers.getActiveProvider = () => ({
    label: 'Stub',
    isConfigured: () => true,
    fetchEvents: async () => [
      // Deliberately carries a location, which would otherwise make it a trip.
      ev('Free Power', {
        location: '12 Main St, Hobart',
        startDate: new Date(Date.now() + 3600000),
        endDate: new Date(Date.now() + 7200000),
      }),
    ],
  });

  try {
    await calendar.poll();
    assert.equal(calendar.getFreePowerWindows().length, 1, 'counted as a free power window');
    assert.equal(calendar.getState().trips.length, 0, 'not counted as a driving trip');
  } finally {
    providers.getActiveProvider = original;
  }
});

test('all-day events are ignored', async () => {
  // An all-day "Free Power" entry would otherwise force full-rate grid charging
  // for 24 hours, which is the opposite of what this feature is for.
  db.setSetting('free_power_enabled', 'true');
  const providers = require('../src/services/calendar/index.js');
  const original = providers.getActiveProvider;
  providers.getActiveProvider = () => ({
    label: 'Stub',
    isConfigured: () => true,
    fetchEvents: async () => [
      ev('Free Power', {
        isAllDay: true,
        startDate: new Date(Date.now() + 3600000),
        endDate: new Date(Date.now() + 90000000),
      }),
    ],
  });

  try {
    await calendar.poll();
    assert.equal(calendar.getFreePowerWindows().length, 0);
  } finally {
    providers.getActiveProvider = original;
  }
});

test('windows that have already finished are dropped', async () => {
  db.setSetting('free_power_enabled', 'true');
  const providers = require('../src/services/calendar/index.js');
  const original = providers.getActiveProvider;
  providers.getActiveProvider = () => ({
    label: 'Stub',
    isConfigured: () => true,
    fetchEvents: async () => [
      ev('Free Power', {
        startDate: new Date(Date.now() - 7200000),
        endDate: new Date(Date.now() - 3600000),
      }),
      ev('Free Power', {
        startDate: new Date(Date.now() + 3600000),
        endDate: new Date(Date.now() + 7200000),
      }),
    ],
  });

  try {
    await calendar.poll();
    const windows = calendar.getFreePowerWindows();
    assert.equal(windows.length, 1, 'only the future window kept');
    assert.ok(windows[0].startMs > Date.now());
  } finally {
    providers.getActiveProvider = original;
  }
});

// ── Force-charge gating ──────────────────────────────────────────────────────

// The controller's gate, transcribed. Free power feeds the same force-charge
// path as an ordinary scheduled window, so this is the one place existing
// charging behaviour could have changed, and it is worth pinning exactly.
const oldGate = (schedule, touPeak, stopped) => schedule && !touPeak && !stopped;
const newGate = (schedule, freePower, touPeak, stopped) => {
  const force = schedule || freePower;
  return force && (freePower || !touPeak) && !stopped;
};

test('with free power off, the gate is identical to the old behaviour', () => {
  for (const schedule of [false, true]) {
    for (const touPeak of [false, true]) {
      for (const stopped of [false, true]) {
        assert.equal(
          newGate(schedule, false, touPeak, stopped),
          oldGate(schedule, touPeak, stopped),
          `schedule=${schedule} touPeak=${touPeak} stopped=${stopped}`
        );
      }
    }
  }
});

test('free power charges even during a TOU peak, but never when stopped', () => {
  // The power is free, so a peak-rate window is not a reason to hold off.
  assert.equal(newGate(false, true, true, false), true, 'free power overrides TOU peak');
  assert.equal(newGate(false, true, false, false), true, 'free power alone charges');
  // An explicit user stop still wins over everything.
  assert.equal(newGate(false, true, false, true), false, 'user stop beats free power');
  assert.equal(newGate(true, true, true, true), false, 'user stop beats both');
  // An ordinary scheduled window is still blocked by a TOU peak, as before.
  assert.equal(newGate(true, false, true, false), false, 'TOU peak still blocks schedule');
});

test('an event with no end time is ignored rather than run open-ended', async () => {
  db.setSetting('free_power_enabled', 'true');
  const providers = require('../src/services/calendar/index.js');
  const original = providers.getActiveProvider;
  providers.getActiveProvider = () => ({
    label: 'Stub',
    isConfigured: () => true,
    fetchEvents: async () => [
      { summary: 'Free Power', location: '', startDate: new Date(Date.now() + 3600000), endDate: null, isAllDay: false },
    ],
  });

  try {
    await calendar.poll();
    assert.equal(calendar.getFreePowerWindows().length, 0);
  } finally {
    providers.getActiveProvider = original;
  }
});
