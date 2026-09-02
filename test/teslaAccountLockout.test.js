/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Tesla returns a 403 "account disabled: EXCEEDED_LIMIT" when the developer app itself has
// been rate-limited, not just one call. Found live on 2026-08-28: the app kept retrying a
// failed command every ~10s against an already-locked-out account for two hours straight,
// which is exactly what stops the car being commandable and adds to whatever tripped the
// lockout in the first place. This must back off hard on sight of that specific error rather
// than retrying on the normal poll cadence, and must never apply to BLE, which never touches
// Tesla's cloud account at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-lockout-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

// tesla.js reads TESLA_PROXY_URL into a module-level const at require time, so it must be
// set before the require below - a fixed port rather than the usual listen(0) lets us do that
// synchronously instead of waiting on the server to bind first. The real proxy is https with a
// self-signed cert (jsonFetch's proxyAgent sets rejectUnauthorized: false for exactly that
// reason), so the Fleet test server has to be https too - a plain http one hits an unrelated
// Node quirk (an https.Agent handed to http.request throws "Protocol not supported") that
// production never sees, since PROXY_URL is always https there. BLE stays http and on a
// separate port: it never starts with TESLA_PROXY_URL in real config, so it never gets that
// agent attached, and re-creating that with two servers on one port would test a case that
// cannot occur outside this file.
const FLEET_PORT = 18743;
const BLE_PORT = 18744;
const base = `https://127.0.0.1:${FLEET_PORT}`;
const bleBase = `http://127.0.0.1:${BLE_PORT}`;
process.env.TESLA_PROXY_URL = base;

let requestCount = 0;
let nextResponse = { code: 200, body: '{"response":{"result":true}}' };
const handler = (req, res) => {
  requestCount += 1;
  res.writeHead(nextResponse.code, { 'Content-Type': 'application/json' });
  res.end(nextResponse.body);
};

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-lockout-cert-'));
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', certPath,
  '-days', '1', '-subj', '/CN=127.0.0.1',
], { stdio: ['ignore', 'ignore', 'ignore'] });
const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
  handler,
);
const bleServer = http.createServer(handler);

test.before(async () => {
  await new Promise((r) => server.listen(FLEET_PORT, '127.0.0.1', r));
  await new Promise((r) => bleServer.listen(BLE_PORT, '127.0.0.1', r));
});

test.after(() => {
  server.close();
  bleServer.close();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
  fs.rmSync(certDir, { recursive: true, force: true });
});

const db = require('../src/db');
db.initDb();
db.setSetting('tesla_command_backend', 'fleet');
const tesla = require('../src/services/tesla');

test('a command that hits the lockout error throws it through as usual', async () => {
  requestCount = 0;
  nextResponse = { code: 403, body: '{"error":"account disabled: EXCEEDED_LIMIT"}' };
  await assert.rejects(
    () => tesla.setChargingAmps('VIN1', 10, 'tok'),
    /account disabled/,
  );
  assert.equal(requestCount, 1, 'the real call must still go out the first time');
});

test('the next command backs off instead of calling out again', async () => {
  requestCount = 0;
  nextResponse = { code: 200, body: '{"response":{"result":true}}' }; // would succeed if called
  await assert.rejects(
    () => tesla.setChargingAmps('VIN1', 10, 'tok'),
    /rate-limited/i,
  );
  assert.equal(requestCount, 0, 'must fail fast without making a real request');
});

test('the breaker applies across different commands, not just the one that tripped it', async () => {
  await assert.rejects(() => tesla.stopCharging('VIN1', 'tok'), /rate-limited/i);
  await assert.rejects(() => tesla.startCharging('VIN1', 'tok'), /rate-limited/i);
  await assert.rejects(() => tesla.wakeVehicle('VIN1', 'tok'), /rate-limited/i);
  assert.equal(requestCount, 0);
});

test('BLE mode is never affected by a Fleet API lockout', async () => {
  db.setSetting('tesla_command_backend', 'ble');
  db.setSetting('tesla_ble_proxy_url', bleBase);
  requestCount = 0;
  nextResponse = { code: 200, body: '{"response":{"result":true}}' };
  await tesla.setChargingAmps('VIN1', 10, 'tok');
  assert.equal(requestCount, 1, 'BLE must reach the proxy even while the Fleet breaker is tripped');
  db.setSetting('tesla_command_backend', 'fleet');
});
