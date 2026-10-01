/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Getting "car is home / away" to Home Assistant as fast as possible.
//
// Two delays stacked up. The car streamed its GPS every 30s, so it could be in the driveway
// before the first position inside the geofence arrived. Then presence was only published at
// the end of a control loop tick, and a tick can sit for ~35s inside a Bluetooth command to a
// car that is pulling away. Garage door automations wait on exactly that signal.
//
// Pinned here:
//   - Location streams every second, and a changed field list reaches the car on its own
//     (the health check used to re-send only when Tesla had dropped the config entirely)
//   - an unreadable stored config never triggers a re-send, so the check cannot loop
//   - a GPS update that crosses the geofence publishes immediately, and updates _isAtHome
//     so the loop's own end-of-tick publish cannot flip Home Assistant back
// Runs against a throwaway DB, with Tesla and the MQTT broker stubbed out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-fastpresence-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const telemetryHealth = require('../src/services/telemetryHealth');
const mqttPublisher = require('../src/services/mqttPublisher');
const controller = require('../src/controller');

test.after(() => {
  telemetryHealth.stop();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

// --- Telemetry config ---------------------------------------------------------------------

test('Location streams every second; charge fields keep their intervals', () => {
  const f = telemetryHealth.DESIRED_FIELDS;
  assert.equal(f.Location.interval_seconds, 1);
  assert.equal(f.DetailedChargeState.interval_seconds, 1);
  assert.equal(f.ChargeAmps.interval_seconds, 1);
});

test('fieldDrift names what differs, and nothing when it all matches', () => {
  const matching = JSON.parse(JSON.stringify(telemetryHealth.DESIRED_FIELDS));
  assert.deepEqual(telemetryHealth.fieldDrift(matching), []);

  const old = { ...matching, Location: { interval_seconds: 30 } };
  assert.deepEqual(telemetryHealth.fieldDrift(old), ['Location']);

  const missing = { ...matching };
  delete missing.Soc;
  assert.deepEqual(telemetryHealth.fieldDrift(missing), ['Soc']);

  const asStrings = Object.fromEntries(Object.entries(matching)
    .map(([k, v]) => [k, { interval_seconds: String(v.interval_seconds) }]));
  assert.deepEqual(telemetryHealth.fieldDrift(asStrings), [],
    'a numeric string from Tesla is the same interval, not drift');
});

test('an unrecognisable stored config means unknown, never drift', () => {
  assert.equal(telemetryHealth.fieldDrift(undefined), null);
  assert.equal(telemetryHealth.fieldDrift(null), null);
  assert.equal(telemetryHealth.fieldDrift('x'), null);
});

async function repairWith(status) {
  const deps = telemetryHealth._deps;
  const saved = { ...deps };
  let sends = 0;
  deps.getConfigStatus = async () => status;
  deps.sendConfig = async () => { sends++; return { ok: true }; };
  telemetryHealth._resetRepairClock();
  try {
    const result = await telemetryHealth.checkAndRepair();
    return { result, sends };
  } finally {
    Object.assign(deps, saved);
  }
}

test('an out-of-date config on Tesla is re-sent', async () => {
  const { result, sends } = await repairWith({ hasConfig: true, drift: ['Location'] });
  assert.equal(sends, 1);
  assert.equal(result.repaired, true);
});

test('a matching config is left alone', async () => {
  const { result, sends } = await repairWith({ hasConfig: true, drift: [] });
  assert.equal(sends, 0);
  assert.equal(result.healthy, true);
});

test('an unreadable fields list is left alone (no re-send loop)', async () => {
  const { sends } = await repairWith({ hasConfig: true, drift: null });
  assert.equal(sends, 0);
});

test('a dropped config is still re-registered, as before', async () => {
  const { sends } = await repairWith({ hasConfig: false, drift: null });
  assert.equal(sends, 1);
});

test('re-sends stay rate limited', async () => {
  const deps = telemetryHealth._deps;
  const saved = { ...deps };
  let sends = 0;
  deps.getConfigStatus = async () => ({ hasConfig: true, drift: ['Location'] });
  deps.sendConfig = async () => { sends++; return { ok: true }; };
  telemetryHealth._resetRepairClock();
  try {
    await telemetryHealth.checkAndRepair();
    const second = await telemetryHealth.checkAndRepair();
    assert.equal(sends, 1, 'a second check straight after must not send again');
    assert.equal(second.throttled, true);
  } finally {
    Object.assign(deps, saved);
  }
});

// --- Instant presence ---------------------------------------------------------------------

// Home at a fixed point, 300 m radius. ~0.009 degrees of latitude is about 1 km.
const HOME = { lat: -30, lon: 150 };
const AT_HOME = { latitude: -30.0005, longitude: 150 };   // ~55 m away
const AWAY    = { latitude: -30.02,   longitude: 150 };   // ~2.2 km away

function withPublishSpy(fn) {
  const calls = [];
  const orig = mqttPublisher.publishCar;
  mqttPublisher.publishCar = (state, home) => calls.push(home);
  try { fn(calls); } finally { mqttPublisher.publishCar = orig; }
}

test.beforeEach(() => {
  db.setSetting('tesla_state_source', 'telemetry');
  db.setSetting('home_latitude', String(HOME.lat));
  db.setSetting('home_longitude', String(HOME.lon));
  db.setSetting('home_radius_km', '0.3');
  controller._lastLatLng = { lat: AT_HOME.latitude, lon: AT_HOME.longitude };
  controller._isAtHome = true;
});

test('leaving the geofence publishes straight away and updates _isAtHome', () => {
  withPublishSpy((calls) => {
    controller._onVehicleLocation({ ...AWAY });
    assert.deepEqual(calls, [false], 'published away immediately');
    assert.equal(controller._isAtHome, false,
      'the loop publishes _isAtHome too, so it must agree or HA would flip back');
    assert.deepEqual(controller._lastLatLng, { lat: AWAY.latitude, lon: AWAY.longitude });
  });
});

test('arriving publishes straight away', () => {
  controller._lastLatLng = { lat: AWAY.latitude, lon: AWAY.longitude };
  controller._isAtHome = false;
  withPublishSpy((calls) => {
    controller._onVehicleLocation({ ...AT_HOME });
    assert.deepEqual(calls, [true]);
    assert.equal(controller._isAtHome, true);
  });
});

test('moving within the same side of the fence does not publish', () => {
  withPublishSpy((calls) => {
    controller._onVehicleLocation({ latitude: -30.0006, longitude: 150.0001 });
    assert.deepEqual(calls, [], 'only crossings are pushed; the loop keeps the steady state fresh');
  });
});

test('updates without a position (charge fields only) are ignored', () => {
  withPublishSpy((calls) => {
    controller._onVehicleLocation({ latitude: null, longitude: null, batteryPct: 70 });
    assert.deepEqual(calls, []);
    assert.equal(controller._isAtHome, true);
  });
});

test('in BLE state mode presence stays with Bluetooth reachability', () => {
  db.setSetting('tesla_state_source', 'ble');
  withPublishSpy((calls) => {
    controller._onVehicleLocation({ ...AWAY });
    assert.deepEqual(calls, []);
    assert.equal(controller._isAtHome, true);
  });
});

test('the controller wires the listener up when it starts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  assert.match(src, /telemetry\.onVehicleUpdate\(\(snap\) => this\._onVehicleLocation\(snap\)\);/);
});
