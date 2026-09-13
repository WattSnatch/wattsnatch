/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Drives the BLE state-source path (tesla.js reads + controller._blePollState/_checkAtHome)
// against a fake TeslaBleHttpProxy. Runs against a throwaway DB, never the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-blestate-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const logger = require('../src/utils/logger');
logger.setDb(db); // outage-reminder tests below verify persisted events_log rows, not just console output
const tesla = require('../src/services/tesla');
const telemetry = require('../src/services/telemetry');
const controller = require('../src/controller');

// Fake proxy whose responses each test can set. Shaped exactly like the real
// wimaha/tesla-ble-http-proxy: one outer envelope ({response: {result, reason, vin, command,
// response: <payload>}}), with the actual data a SECOND level deeper under another nested
// "response" key. Confirmed live 2026-09-09 against a real proxy - the code used to unwrap only
// the outer layer, landing one level short, so every poll "succeeded" over HTTP while every
// field came back missing. These fixtures previously used a single-wrapped shape that matched
// the bug rather than reality, which is exactly how it went undetected - never revert to that.
let bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
  command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
let dataResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
  command: 'vehicle_data', response: { charge_state: {
  charging_state: 'Charging', battery_level: 55, charge_limit_soc: 80, charge_amps: 16, charger_power: 11,
} } } }) };

const server = http.createServer((req, res) => {
  const target = req.url.includes('body_controller_state') ? bodyResp : dataResp;
  res.writeHead(target.code, { 'Content-Type': 'application/json' });
  res.end(target.body);
});

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.setSetting('tesla_state_source', 'ble');
  db.setSetting('tesla_ble_proxy_url', base);
  db.setSetting('tesla_vin', 'VINTEST');
});

test.after(() => {
  server.close();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('getVehicleDataBle parses charge_state from the Fleet-shaped response', async () => {
  const d = await tesla.getVehicleDataBle('VINTEST');
  assert.equal(d.chargingState, 'Charging');
  assert.equal(d.batteryPct, 55);
  assert.equal(d.chargeLimit, 80);
  assert.equal(d.chargeAmps, 16);
});

test('getVehicleDataBle throws when charge_state is absent (never feeds zeros)', async () => {
  const saved = dataResp;
  dataResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'vehicle_data', response: {} } }) };
  await assert.rejects(() => tesla.getVehicleDataBle('VINTEST'), /no charge_state/);
  dataResp = saved;
});

test('getVehicleDataBle unwraps the real double envelope, not a single-wrapped guess', async () => {
  // Locks in the exact shape captured from a live proxy - the previous version of this fixture
  // (single-wrapped) matched the bug instead of reality and let it ship undetected.
  const saved = dataResp;
  dataResp = { code: 200, body: JSON.stringify({ response: { result: true,
    reason: 'The request was successfully processed.', vin: 'VINTEST', command: 'vehicle_data',
    response: { charge_state: { charging_state: 'Charging', battery_level: 45, charge_limit_soc: 80,
      charge_amps: 6, charger_power: 1 } } } }) };
  const d = await tesla.getVehicleDataBle('VINTEST');
  assert.equal(d.chargingState, 'Charging');
  assert.equal(d.batteryPct, 45);
  assert.equal(d.chargerPowerKw, 1);
  dataResp = saved;
});

test('getBodyStateBle reports awake vs asleep', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_ASLEEP' } } }) };
  assert.equal((await tesla.getBodyStateBle('VINTEST')).asleep, true);
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
  assert.equal((await tesla.getBodyStateBle('VINTEST')).asleep, false);
});

test('getBodyStateBle waits out a slow-but-legitimate scan instead of cancelling it', { timeout: 40000 }, async () => {
  // Found live 2026-09-13: the proxy's own scanTimeout (30s, docker-compose.yml) is how long a
  // fresh BLE scan can legitimately take - most notably right as the car comes back into range,
  // since it only advertises intermittently. The client-side timeout used to be shorter (15s for
  // this call), so it cancelled the proxy's in-progress scan before it had a fair chance to
  // succeed, and the resulting "context canceled" on the proxy side came back here as a plain
  // timeout - misread as the proxy being stuck, when it just needed more time. A server that
  // waits 32s (past the old 15s timeout, short of the new one) before answering successfully
  // proves the fix: this must resolve, not throw.
  const slowServer = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
        command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }));
    }, 32000);
  });
  await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
  const slowUrl = `http://127.0.0.1:${slowServer.address().port}`;
  try {
    db.setSetting('tesla_ble_proxy_url', slowUrl);
    const result = await tesla.getBodyStateBle('VINTEST');
    assert.equal(result.asleep, false);
  } finally {
    slowServer.close();
    db.setSetting('tesla_ble_proxy_url', base);
  }
});

test('_blePollState: awake car marks reachable, not sleeping, and updates telemetry', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
  controller._lastBleSleepCheckAt = 0;
  controller._lastBlePollAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true);
  assert.equal(controller._carSleeping, false);
  assert.equal(controller._checkAtHome(), true, 'reachable car reads as at home');
  const st = telemetry.getState();
  assert.equal(st.chargingState, 'Charging');
  assert.equal(st.batteryPct, 55);
});

test('_blePollState: asleep car is present (at home) but its state is not re-read', async () => {
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_ASLEEP' } } }) };
  controller._lastBleSleepCheckAt = 0;
  controller._lastBlePollAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true, 'a sleeping car in range is still at home');
  assert.equal(controller._carSleeping, true);
  assert.equal(controller._checkAtHome(), true);
});

test('_blePollState: a single missed check within the grace window keeps trusting the car is home', async () => {
  // Found live 2026-09-09: one dropped request between WattSnatch and the proxy (never even
  // reached the proxy's own logs) used to flip reachability to false immediately, which didn't
  // just flicker the dashboard - it issued a real charge_stop mid-session. This is the fix under
  // test: a lone miss right after a confirmed-reachable moment must not be trusted as "left."
  controller._lastBleReachableAt = Date.now(); // just confirmed reachable, as the prior tests did
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1'); // nothing listening - this call fails
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, true, 'one miss inside the grace window must not flip to away');
  assert.equal(controller._checkAtHome(), true);
  db.setSetting('tesla_ble_proxy_url', base); // restore for any later tests
});

test('_blePollState: sustained failures past the grace window mean the car has genuinely left', async () => {
  // Same failing proxy, but the last confirmed-reachable moment is now well outside the grace
  // window - this is what a real departure (or a truly dead proxy) looks like, and it must still
  // be caught, not masked forever by the leniency above.
  controller._lastBleReachableAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1'); // nothing listening
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, false, 'a sustained run of failures must still be treated as away');
  assert.equal(controller._checkAtHome(), false, 'genuinely away after the grace window expires');
  db.setSetting('tesla_ble_proxy_url', base); // restore for any later tests
});

test('_blePollState: a fresh boot (never yet confirmed reachable) starts away, not home', async () => {
  // _lastBleReachableAt defaults to 0 - Date.now() - 0 is always far past the grace window, so a
  // process that has never once confirmed the car is present must not default to "home" on
  // unproven ground just because the grace-period math technically allows a large gap.
  controller._lastBleReachableAt = 0;
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(controller._bleReachable, false);
  db.setSetting('tesla_ble_proxy_url', base);
});

// --- Sustained-outage reminder ------------------------------------------------------------
// Found live 2026-09-02: a 5+ hour failure to reach the proxy produced zero log output, because
// the "away" transition logs once and then stays silent for however long the outage runs - a
// real network failure looked identical to "car's just not home," and an unsupervised charge
// started and had to be stopped by hand during it. These tests are the fix: a sustained outage
// must become visible in the log, distinct from the deliberately-quiet single-miss case.

function apiErrorCount() {
  return db.getEvents(1, 50, 'api_error').events
    .filter((e) => /unable to reach the car over Bluetooth/i.test(e.details || '')).length;
}

// db.getEvents orders by occurred_at (millisecond Date.now()), and these tests fire in rapid
// succession with no real delay between them, so two rows can land on the same millisecond -
// "the latest row" is then ambiguous by timestamp alone. Match on content instead of position.
function latestApiErrorMatching(pattern) {
  const hit = db.getEvents(1, 50, 'api_error').events.find((e) => pattern.test(e.details || ''));
  assert.ok(hit, `expected a recent api_error event matching ${pattern}`);
  return hit;
}

test('outage reminder: silent within the grace window, even though a check just failed', async () => {
  controller._lastBleReachableAt = Date.now() - 5000; // 5s ago - well inside the 90s grace window
  controller._lastBleOutageReminderAt = 0;
  const before = apiErrorCount();
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(apiErrorCount(), before, 'must not remind about an outage that has not even been declared yet');
  db.setSetting('tesla_ble_proxy_url', base);
});

test('outage reminder: fires promptly once the outage is genuinely declared, not after a full 30 minutes', async () => {
  controller._lastBleReachableAt = Date.now() - 5 * 60 * 1000; // 5 min ago - past the 90s grace window
  controller._lastBleOutageReminderAt = 0; // never reminded yet
  const before = apiErrorCount();
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1'); // nothing listening - network-level failure
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(apiErrorCount(), before + 1, 'the first reminder must not wait for the full 30-minute cadence');
  latestApiErrorMatching(/network problem between WattSnatch and the machine running the proxy/);
  db.setSetting('tesla_ble_proxy_url', base);
});

test('outage reminder: does not repeat again inside the 30-minute cadence', async () => {
  controller._lastBleReachableAt = Date.now() - 40 * 60 * 1000; // outage has been running 40 min
  controller._lastBleOutageReminderAt = Date.now() - 5 * 60 * 1000; // but we only reminded 5 min ago
  const before = apiErrorCount();
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(apiErrorCount(), before, 'must not spam a reminder more often than the cadence allows');
  db.setSetting('tesla_ble_proxy_url', base);
});

test('outage reminder: fires again once the 30-minute cadence has elapsed', async () => {
  controller._lastBleReachableAt = Date.now() - 90 * 60 * 1000; // outage running 90 min
  controller._lastBleOutageReminderAt = Date.now() - 31 * 60 * 1000; // last reminder 31 min ago
  const before = apiErrorCount();
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(apiErrorCount(), before + 1, 'a sustained outage must keep reminding, not just once');
  db.setSetting('tesla_ble_proxy_url', base);
});

test('outage reminder: classifies a reply FROM the proxy reporting failure differently than an unreachable one', async () => {
  // The proxy itself answers (network path to it is fine) but reports an error - this points at
  // the car/Bluetooth link, not at WattSnatch's connection to the proxy machine, and the message
  // must say so rather than reusing the network-problem wording.
  bodyResp = { code: 500, body: 'proxy-side error' };
  controller._lastBleReachableAt = Date.now() - 5 * 60 * 1000;
  controller._lastBleOutageReminderAt = 0;
  const before = apiErrorCount();
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  assert.equal(apiErrorCount(), before + 1);
  const hit = latestApiErrorMatching(/points at the car or the Bluetooth link/);
  assert.doesNotMatch(hit.details, /network problem/,
    'a response the proxy actually sent must not be blamed on the network path to it');
  // Restore the working fixture for any later runs.
  bodyResp = { code: 200, body: JSON.stringify({ response: { result: true, reason: 'ok', vin: 'VINTEST',
    command: 'body-controller-state', response: { vehicle_sleep_status: 'VEHICLE_SLEEP_STATUS_AWAKE' } } }) };
});

test('outage reminder: a proxy that accepts the connection but never replies is diagnosed as stuck, not a network problem or the car being away', { timeout: 40000 }, async () => {
  // This is the actual bug found live 2026-09-09: the proxy's own Bluetooth link had wedged, so
  // every request connected fine (the network was completely healthy) but got no reply at all -
  // and the old message-text-guessing classification called that "a network problem between
  // WattSnatch and the machine running the proxy," which sent troubleshooting in the wrong
  // direction entirely. A raw TCP server that accepts and never responds reproduces exactly
  // that: connected, then silence. This genuinely waits out the real 35s BLE-read timeout rather
  // than faking the clock, since the whole point under test is jsonFetch's own timeout path.
  const hangServer = net.createServer((socket) => { /* accept, then do nothing - ever */ });
  await new Promise((r) => hangServer.listen(0, '127.0.0.1', r));
  const hangUrl = `http://127.0.0.1:${hangServer.address().port}`;
  try {
    controller._lastBleReachableAt = Date.now() - 5 * 60 * 1000;
    controller._lastBleOutageReminderAt = 0;
    const before = apiErrorCount();
    db.setSetting('tesla_ble_proxy_url', hangUrl);
    controller._lastBleSleepCheckAt = 0;
    await controller._blePollState('VINTEST');
    assert.equal(apiErrorCount(), before + 1);
    const hit = latestApiErrorMatching(/proxy itself being stuck/);
    assert.match(hit.details, /Restarting the proxy is the known fix/);
    assert.doesNotMatch(hit.details, /network problem between WattSnatch/,
      'a connection that succeeded must never be blamed on the network path to the proxy');
  } finally {
    hangServer.close();
    db.setSetting('tesla_ble_proxy_url', base);
  }
});

test('outage reminder: a fresh boot that has never confirmed reachability reports a sane duration', async () => {
  // Found live the moment this shipped: _lastBleReachableAt is 0 on a fresh boot, and computing
  // the reminder's displayed duration as Date.now() - 0 read as "after 29816036 min" (56 years).
  // The real, sane answer is how long this controller has been running, not since the epoch.
  controller._lastBleReachableAt = 0; // never confirmed this run
  controller._constructedAt = Date.now() - 7 * 60 * 1000; // controller "started" 7 min ago
  controller._lastBleOutageReminderAt = 0;
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST');
  const hit = latestApiErrorMatching(/since starting up 7 min ago/);
  assert.doesNotMatch(hit.details, /Still unable to reach.*after/,
    'the never-confirmed case has its own wording, distinct from the normal "after N min" case');
  db.setSetting('tesla_ble_proxy_url', base);
});

test('outage reminder: the timer resets once reachable again, so a later outage reminds promptly too', async () => {
  controller._lastBleOutageReminderAt = Date.now(); // pretend we just reminded
  controller._lastBleSleepCheckAt = 0;
  await controller._blePollState('VINTEST'); // succeeds against the restored fixture
  assert.equal(controller._bleReachable, true);
  assert.equal(controller._lastBleOutageReminderAt, 0, 'a fresh success must clear the reminder clock');
});
