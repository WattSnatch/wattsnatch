/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The overnight trip check must plan the day that is starting, not the one after.
//
// Found 2026-10-24. The check runs at 00:00 and took "tomorrow" relative to the moment it ran.
// By then the date has already rolled over, so it planned 24 to 48 hours ahead. A midday trip
// added to the calendar the previous afternoon was never planned: the run before it had already
// passed, and the run after it looked at the following day and logged "no driving events
// tomorrow". The car was found not charging at 7:30am with the trip at 12:00.
//
// Runs the real check at 00:00:08 against a throwaway DB, with the calendar, TeslaMate and live
// telemetry stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-midnight-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const calendar = require('../src/services/calendar');
const teslamate = require('../src/services/teslamate');
const telemetry = require('../src/services/telemetry');
const notifications = require('../src/services/notifications');
const departureScheduler = require('../src/services/departureScheduler');
const tripPlanner = require('../src/services/tripPlanner');

const realNow = Date.now;
const orig = {};
let trips = [];
let sent = [];

// 00:00:08 local on a Saturday, as the scheduled run fires.
const RUN = new Date(2026, 9, 24, 0, 0, 8).getTime();
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();

test.before(() => {
  orig.isConfigured = calendar.isConfigured; orig.poll = calendar.poll; orig.getState = calendar.getState;
  orig.tm = { ...teslamate }; orig.telemetryState = telemetry.getState;
  orig.notify = notifications.notifyMidnightChargeScheduled;
  calendar.isConfigured = () => true;
  calendar.poll = async () => {};
  calendar.getState = () => ({ trips });
  teslamate.getEfficiencyKwhPerKm = async () => ({ kwh_per_km: 0.134 });
  teslamate.getSentryDrainRateKwhPerHour = async () => ({ kwh_per_hour: 0.2 });
  teslamate.getBatteryHealthPercent = async () => ({ health_pct: 96.9 });
  telemetry.getState = () => ({ ...orig.telemetryState(), batteryPct: 65, chargeLimit: 80 });
  notifications.notifyMidnightChargeScheduled = async (...args) => { sent.push(args); };
  db.setSetting('tesla_battery_kwh', '62.5');
  db.setSetting('tesla_pairing_mode', 'cloud');
});

test.beforeEach(() => {
  Date.now = () => RUN;
  trips = [];
  sent = [];
  departureScheduler.clearDeparture();
});

test.after(() => {
  Date.now = realNow;
  calendar.isConfigured = orig.isConfigured; calendar.poll = orig.poll; calendar.getState = orig.getState;
  Object.assign(teslamate, orig.tm);
  telemetry.getState = orig.telemetryState;
  notifications.notifyMidnightChargeScheduled = orig.notify;
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true });
});

const trip = (departureTime, km, summary = 'Trip') =>
  ({ summary, location: 'Destination', departureTime, distanceKm: km, eventDurationHours: 4 });

test('the morning\'s case: a midday trip later the same day is planned at midnight', async () => {
  trips = [trip(at(24, 12), 205)];
  await tripPlanner.runMidnightTripCheck();
  const dep = departureScheduler.getActiveDeparture();
  assert.ok(dep, 'a departure must be scheduled');
  assert.equal(Number(dep.departure_time ?? dep.departureTime), at(24, 12));
  assert.equal(Number(dep.target_soc ?? dep.targetSoc), 100, 'a long trip needs a full battery');
  assert.equal(sent.length, 1, 'the owner is told');
});

test('the notification says Today for a trip later the same day, Tomorrow otherwise', () => {
  const msg = (dep) => notifications.midnightChargeMessage([[trip(dep, 205)]], 65, 100, dep, 55.4, '', RUN);
  assert.match(msg(at(24, 12)), /^Today: /);
  assert.match(msg(at(25, 9)), /^Tomorrow: /);
});

test('a trip more than 24 hours away is left for the next night', async () => {
  trips = [trip(at(25, 9), 205)];
  await tripPlanner.runMidnightTripCheck();
  assert.equal(departureScheduler.getActiveDeparture(), null);
});

test('a short trip the battery already covers schedules nothing', async () => {
  trips = [trip(at(24, 10), 10)];
  await tripPlanner.runMidnightTripCheck();
  assert.equal(departureScheduler.getActiveDeparture(), null);
});

test('several trips today are planned together, against the first departure', async () => {
  trips = [trip(at(24, 15), 120, 'Later'), trip(at(24, 9), 120, 'Earlier')];
  await tripPlanner.runMidnightTripCheck();
  const dep = departureScheduler.getActiveDeparture();
  assert.equal(Number(dep.departure_time ?? dep.departureTime), at(24, 9), 'ready for the earliest one');
});
