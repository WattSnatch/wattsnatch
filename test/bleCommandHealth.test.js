/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A stuck Bluetooth proxy must be retried on a growing delay and reported, not hammered in
// silence.
//
// Found live 2026-10-12. The proxy's adapter got stuck and rejected everything with "Command
// Disallowed". The controller wanted to stop a grid charge, sent a stop every 10 seconds, got
// the same refusal 133 times and told nobody. About 20 minutes of grid charging later the owner
// noticed on the dashboard.
//
// The boundary that matters is what counts as a fault. Only definite proxy faults do. A car
// that is simply away ("not in range"), transient contention ("maximum number of BLE devices")
// and a command the car refused all prove the proxy is working, so they must never trigger a
// back-off, or legitimate commands to a car that is merely out of range would be blocked.
// Runs against a fake proxy and a throwaway DB, never the real ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// tesla.js reads this into a constant when it loads. A fixed unused port means a Fleet-mode
// test can never reach the real signing proxy on 4443.
process.env.TESLA_PROXY_URL = 'https://127.0.0.1:18761';
const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-blehealth-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const logger = require('../src/utils/logger');
const notifications = require('../src/services/notifications');
const health = require('../src/services/bleCommandHealth');
const tesla = require('../src/services/tesla');

const WEDGE = { code: 503, body: '{"response":{"result":false,"reason":"failed to connect to vehicle (A): ble: failed to scan for VIN: Command Disallowed"}}' };
const AWAY  = { code: 503, body: '{"response":{"result":false,"reason":"failed to connect to vehicle (A): ble: Vehicle is not in range"}}' };
const CAP   = { code: 503, body: '{"response":{"result":false,"reason":"ble: maximum number of BLE devices connected"}}' };
const GOOD  = { code: 200, body: '{"response":{"result":true,"reason":"The request was successfully processed."}}' };

let next = GOOD;
let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  res.writeHead(next.code, { 'Content-Type': 'application/json' });
  res.end(next.body);
});

let clock;
const realNow = Date.now;
let sent = [];
let logged = [];
const origNotify = notifications.sendNotification;
const origLog = logger.logEvent;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  db.setSetting('tesla_ble_proxy_url', `http://127.0.0.1:${server.address().port}`);
  db.setSetting('tesla_command_backend', 'ble');
  notifications.sendNotification = async (title, msg) => { sent.push(title); };
  logger.logEvent = (type, msg) => { logged.push([type, msg]); };
});

test.beforeEach(() => {
  health._reset();
  hits = 0; sent = []; logged = [];
  next = GOOD;
  clock = realNow();
  Date.now = () => clock;
  db.setSetting('tesla_command_backend', 'ble');
});

test.afterEach(() => { Date.now = realNow; });

test.after(() => {
  Date.now = realNow;
  notifications.sendNotification = origNotify;
  logger.logEvent = origLog;
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

const stop = () => tesla.stopCharging('VIN', 'tok');

test('classification: only definite proxy faults count', () => {
  assert.equal(health.classifyResponse(200, GOOD.body), 'ok');
  assert.equal(health.classifyResponse(503, WEDGE.body), 'fault');
  assert.equal(health.classifyResponse(503, 'ble: can\'t read hci socket: broken pipe'), 'fault');
  assert.equal(health.classifyResponse(503, AWAY.body), 'ok', 'car away proves the adapter works');
  assert.equal(health.classifyResponse(503, CAP.body), 'ok', 'device cap is transient contention');
  assert.equal(health.classifyResponse(500, 'something nobody has seen before'), 'ok',
    'unknown is not a fault here, so a surprise cannot block commands');
  const neverConnected = Object.assign(new Error('x'), { wattsnatchConnected: false });
  const timedOutAfter = Object.assign(new Error('x'), { wattsnatchConnected: true });
  assert.equal(health.classifyError(neverConnected), 'fault');
  assert.equal(health.classifyError(timedOutAfter), 'ignore', 'a slow scan looks like a stuck proxy');
  assert.equal(health.classifyError(new Error('x')), 'ignore');
});

test('one fault does not back off; the second does, and blocked calls never reach the proxy', async () => {
  next = WEDGE;
  await assert.rejects(stop(), /Command Disallowed/);
  assert.equal(hits, 1);
  await assert.rejects(stop(), /Command Disallowed/);     // 2nd fault arms the back-off
  assert.equal(hits, 2);
  await assert.rejects(stop(), (e) => e.wattsnatchBleBackoff === true && /retrying in/.test(e.message));
  await assert.rejects(stop(), /backing off/);
  assert.equal(hits, 2, 'blocked calls must not touch the network');
});

test('the delay grows 15s, 30s, then 60s and never goes beyond', async () => {
  next = WEDGE;
  const waits = [];
  for (let i = 0; i < 6; i++) {
    await assert.rejects(stop());                         // goes to the proxy, faults
    if (health.getState().streak >= 2) waits.push(health.getState().until - clock);
    clock = health.getState().until || clock;             // wait out whatever back-off applies
    clock += 1;
  }
  assert.deepEqual(waits, [15000, 30000, 60000, 60000, 60000]);
});

test('once the delay passes, the next attempt goes through and success clears everything', async () => {
  next = WEDGE;
  await assert.rejects(stop());
  await assert.rejects(stop());
  assert.ok(health.getState().until > clock);
  clock = health.getState().until + 1;
  next = GOOD;
  await stop();
  assert.deepEqual(health.getState(), { streak: 0, firstAt: 0, until: 0, notified: false, kind: '' });
  await stop();
  assert.equal(hits, 4, 'back to normal sending');
});

test('a car that is away is never a fault and never backs off', async () => {
  next = AWAY;
  for (let i = 0; i < 8; i++) await assert.rejects(stop(), /not in range/);
  assert.equal(hits, 8, 'every attempt was sent');
  assert.equal(health.getState().streak, 0);
});

test('device cap contention is never a fault', async () => {
  next = CAP;
  for (let i = 0; i < 5; i++) await assert.rejects(stop());
  assert.equal(hits, 5);
  assert.equal(health.getState().streak, 0);
});

test('an away or contended reply in the middle of a fault run clears it', async () => {
  next = WEDGE;
  await assert.rejects(stop());
  assert.equal(health.getState().streak, 1);
  next = AWAY;
  await assert.rejects(stop());
  assert.equal(health.getState().streak, 0, 'the adapter answered properly, so it is not stuck');
});

test('failing to reach the proxy at all is a fault', async () => {
  const good = db.getSetting('tesla_ble_proxy_url');
  db.setSetting('tesla_ble_proxy_url', 'http://127.0.0.1:1');
  try {
    await assert.rejects(stop());
    assert.equal(health.getState().streak, 1);
    assert.equal(health.getState().kind, 'unreachable');
  } finally {
    db.setSetting('tesla_ble_proxy_url', good);
  }
});

test('the owner is told once after repeated faults over two minutes, and again when it clears', async () => {
  next = WEDGE;
  await assert.rejects(stop());                                   // t = 0
  clock += 20000; await assert.rejects(stop());
  clock += 40000; await assert.rejects(stop());                   // 3 faults but only 60s
  assert.equal(sent.length, 0, 'not yet: earlier episodes cleared by themselves in about two minutes');
  clock += 70000; await assert.rejects(stop());                   // 130s
  assert.deepEqual(sent, ['WattSnatch: Bluetooth link to the car is down']);
  clock += 70000; await assert.rejects(stop());
  clock += 70000; await assert.rejects(stop());
  assert.equal(sent.length, 1, 'once, however long it goes on');
  const down = logged.filter(([t, m]) => t === 'api_error' && /Bluetooth/.test(m));
  assert.equal(down.length, 1);
  assert.doesNotMatch(down[0][1], /VIN|127\.0\.0\.1|192\.168/, 'no vehicle or network details in the message');

  next = GOOD; clock += 70000;
  await stop();
  assert.deepEqual(sent, ['WattSnatch: Bluetooth link to the car is down', 'WattSnatch: Bluetooth link to the car is back']);
  await stop();
  assert.equal(sent.length, 2, 'the all-clear is sent once');
});

test('no recovery message when no outage message was ever sent', async () => {
  next = WEDGE;
  await assert.rejects(stop());
  next = GOOD;
  clock += 5000;
  await stop();
  assert.deepEqual(sent, []);
});

test('Fleet API commands are untouched: no back-off, no tracking', async () => {
  db.setSetting('tesla_command_backend', 'fleet');
  for (let i = 0; i < 4; i++) await assert.rejects(stop());     // nothing listens on the fake Fleet port
  assert.equal(health.getState().streak, 0);
  assert.equal(sent.length, 0);
});

test('every command type goes through the same guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'tesla.js'), 'utf8');
  for (const cmd of ["'set_charging_amps'", "'charge_start'", "'set_charge_limit'", "'charge_stop'"]) {
    assert.match(src, new RegExp(`commandFetch\\(commandUrl\\(vin, ${cmd}\\)`), `${cmd} uses the guard`);
  }
  const wake = src.slice(src.indexOf('async function wakeVehicle('), src.indexOf('async function setChargingAmps('));
  assert.match(wake, /commandFetch\(url,/, 'wake uses it too');
  assert.doesNotMatch(wake, /jsonFetch\(/);
});
