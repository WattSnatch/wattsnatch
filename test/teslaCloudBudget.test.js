/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Daily cap on billed Tesla Fleet API requests.
//
// In September 2026 an unnoticed path made ~6,500 billed requests a day until Tesla disabled
// the developer account. Nothing capped it. This pins the cap that now sits in front of every
// billed request:
//   - every request to a Fleet API host or the signing proxy is counted before it is sent
//   - past the limit, requests are refused without touching the network, and the owner is
//     told once, not once per refusal
//   - stopping a charge and setup steps are counted but never refused
//   - Bluetooth proxy traffic is not counted at all
//   - the count starts again each day
// The signing proxy is a local fake here, so no test can reach Tesla.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-cloudbudget-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const logger = require('../src/utils/logger');
const notifications = require('../src/services/notifications');
const budget = require('../src/services/teslaCloudBudget');

// Same setup as teslaAccountLockout.test.js: the signing proxy is https with a self-signed
// cert in real life, and PROXY_URL is read when tesla.js loads, so a fixed port lets it be set
// before the require. Bluetooth stays plain http on its own port, as in real config.
const FLEET_PORT = 18753;
const BLE_PORT = 18754;
process.env.TESLA_PROXY_URL = `https://127.0.0.1:${FLEET_PORT}`;

let hits = [];
const handler = (req, res) => {
  hits.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.includes('vehicle_data')) {
    res.end(JSON.stringify({ response: { result: true, response: { charge_state: { charging_state: 'Stopped' } } } }));
  } else {
    res.end(JSON.stringify({ response: { result: true, reason: '' } }));
  }
};
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-budget-cert-'));
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath,
  '-days', '1', '-subj', '/CN=127.0.0.1',
], { stdio: ['ignore', 'ignore', 'ignore'] });
const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler);
const bleServer = http.createServer(handler);

let tesla;
let notified = [];
let logged = [];
const origNotify = notifications.sendNotification;
const origLog = logger.logEvent;

test.before(async () => {
  await new Promise((r) => server.listen(FLEET_PORT, '127.0.0.1', r));
  await new Promise((r) => bleServer.listen(BLE_PORT, '127.0.0.1', r));
  db.setSetting('tesla_ble_proxy_url', `http://127.0.0.1:${BLE_PORT}`);
  tesla = require('../src/services/tesla');
  notifications.sendNotification = async (title, msg) => { notified.push(title); };
  logger.logEvent = (type, msg) => { logged.push([type, msg]); };
});

test.beforeEach(() => {
  hits = [];
  notified = [];
  logged = [];
  db.setSetting(budget.USAGE_KEY, '');
  db.setSetting(budget.LIMIT_KEY, '');
  db.setSetting('tesla_command_backend', 'fleet');
});

test.after(() => {
  notifications.sendNotification = origNotify;
  logger.logEvent = origLog;
  server.close();
  bleServer.close();
  fs.rmSync(certDir, { recursive: true, force: true });
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('automatic limit depends on where commands go; an explicit value wins; 0 turns it off', () => {
  db.setSetting('tesla_command_backend', 'ble');
  assert.equal(budget.getLimit(), budget.DEFAULT_LIMIT_BLE_COMMANDS);
  db.setSetting('tesla_command_backend', 'fleet');
  assert.equal(budget.getLimit(), budget.DEFAULT_LIMIT_FLEET_COMMANDS);
  db.setSetting(budget.LIMIT_KEY, '7');
  assert.equal(budget.getLimit(), 7);
  db.setSetting(budget.LIMIT_KEY, '0');
  assert.equal(budget.getLimit(), 0);
  db.setSetting(budget.LIMIT_KEY, 'nonsense');
  assert.equal(budget.getLimit(), budget.DEFAULT_LIMIT_FLEET_COMMANDS, 'garbage falls back to automatic');
});

test('billed requests are counted before they are sent', async () => {
  await tesla.startCharging('VINTEST', 'tok');
  await tesla.setChargingAmps('VINTEST', 10, 'tok');
  assert.equal(hits.length, 2);
  assert.equal(budget.getUsage().count, 2);
});

test('past the limit, requests are refused without touching the network', async () => {
  db.setSetting(budget.LIMIT_KEY, '2');
  await tesla.startCharging('VINTEST', 'tok');
  await tesla.setChargingAmps('VINTEST', 10, 'tok');
  await assert.rejects(() => tesla.startCharging('VINTEST', 'tok'), /daily request limit reached/);
  await assert.rejects(() => tesla.setChargingAmps('VINTEST', 12, 'tok'), /daily request limit reached/);
  assert.equal(hits.length, 2, 'refused requests never reach the network');
  const u = budget.getUsage();
  assert.equal(u.count, 2);
  assert.equal(u.refused, 2);
});

test('the owner is told once when the cap trips, not on every refusal', async () => {
  db.setSetting(budget.LIMIT_KEY, '1');
  await tesla.startCharging('VINTEST', 'tok');
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => tesla.startCharging('VINTEST', 'tok'));
  }
  assert.equal(notified.length, 1, 'one notification');
  assert.equal(logged.filter(([t, m]) => t === 'api_error' && /limit reached/.test(m)).length, 1, 'one log entry');
  const msg = logged.find(([t]) => t === 'api_error')[1];
  assert.doesNotMatch(msg, /VINTEST/, 'the VIN never goes into the log');
});

test('stopping a charge is never refused, but is still counted', async () => {
  db.setSetting(budget.LIMIT_KEY, '1');
  await tesla.startCharging('VINTEST', 'tok');
  await tesla.stopCharging('VINTEST', 'tok');
  assert.ok(hits.some((u) => u.includes('charge_stop')), 'stop went through at the cap');
  assert.equal(budget.getUsage().count, 2);
});

test('a limit of 0 never refuses', async () => {
  db.setSetting(budget.LIMIT_KEY, '0');
  for (let i = 0; i < 5; i++) await tesla.startCharging('VINTEST', 'tok');
  assert.equal(hits.length, 5);
});

test('Bluetooth proxy traffic is not counted', async () => {
  db.setSetting('tesla_command_backend', 'ble');
  db.setSetting(budget.LIMIT_KEY, '1');
  db.setSetting(budget.USAGE_KEY, JSON.stringify({ date: budget.getUsage().date, count: 1 }));
  await tesla.startCharging('VINTEST', 'tok');
  await tesla.setChargingAmps('VINTEST', 10, 'tok');
  await tesla.getVehicleDataBle('VINTEST');
  assert.equal(hits.length, 3, 'BLE requests still go out with the cloud cap reached');
  assert.equal(budget.getUsage().count, 1, 'and do not add to the count');
});

test('the count starts again each day', () => {
  db.setSetting(budget.USAGE_KEY, JSON.stringify({ date: '2000-01-01', count: 999, refused: 5, notified: true }));
  const u = budget.getUsage();
  assert.equal(u.count, 0);
  assert.equal(u.refused, 0);
  assert.equal(u.notified, false);
});

test('a corrupt usage record starts the day fresh rather than throwing', () => {
  db.setSetting(budget.USAGE_KEY, '{not json');
  assert.equal(budget.getUsage().count, 0);
});

// Paths that do not go through jsonFetch, and the essential markings, pinned at source level.
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the telemetry config check and send are counted too', () => {
  const src = read('src/services/telemetryHealth.js');
  assert.match(src, /cloudBudget\.beforeRequest\('GET fleet_telemetry_config'\); \} catch \(_e\) \{ return null; \}/,
    'a refused check reads as unknown, which never triggers a re-register');
  assert.match(src, /cloudBudget\.beforeRequest\('POST fleet_telemetry_config', \{ essential \}\)/);
  assert.match(read('src/routes/setup.js'), /telemetryHealth\.sendConfig\(\{ essential: true \}\)/,
    'the owner can always re-send the config by hand');
});

test('setup steps are marked essential so a capped day cannot lock the owner out', () => {
  const src = read('src/services/tesla.js');
  for (const fn of ['registerPartnerAccount', 'listVehicles', 'getUserRegion', 'getRegisteredPublicKey', 'stopCharging']) {
    const start = src.indexOf(`async function ${fn}(`);
    assert.ok(start > 0, `${fn} found`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /essential: true/, `${fn} is essential`);
  }
  const vd = src.slice(src.indexOf('async function getVehicleData('), src.indexOf('\n}\n', src.indexOf('async function getVehicleData(')));
  assert.doesNotMatch(vd, /essential/, 'vehicle_data, the call behind last month, is never exempt');
});
