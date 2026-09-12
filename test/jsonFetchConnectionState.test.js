/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// jsonFetch tags every error with err.wattsnatchConnected, tracked from the actual TCP socket
// state rather than guessed from the error message afterward. Found live 2026-09-09: a BLE proxy
// whose own Bluetooth link had wedged looked identical to a dead network path, because Node's
// request-level 'timeout' event fires the same way whether the connection ever completed or not.
// This is the mechanism that makes those two cases tell-apart-able; controller.js's outage
// reminder (test/bleStatePolling.test.js) is what actually uses it in the wild.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-jsonfetch-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;
const db = require('../src/db');
db.initDb();
const tesla = require('../src/services/tesla');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('a refused connection is tagged wattsnatchConnected: false', async () => {
  // Port 1 is not listening - the TCP handshake itself fails, so the socket never connects.
  await assert.rejects(
    () => tesla.jsonFetch('http://127.0.0.1:1/x', { timeout: 2000 }),
    (err) => {
      assert.equal(err.wattsnatchConnected, false, 'a connection that never completed must read false');
      return true;
    },
  );
});

test('a connection that succeeds but the server never replies is tagged wattsnatchConnected: true', async () => {
  // Raw TCP accept with no HTTP response at all: the socket connects, so our tracking must see
  // that, then the client-side timeout fires while still waiting for a reply - this is exactly
  // the wedged-proxy case, and it must read as "connected" rather than "never reached it."
  const server = net.createServer((socket) => { /* accept and do nothing - never respond */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => tesla.jsonFetch(`http://127.0.0.1:${port}/x`, { timeout: 500 }),
      (err) => {
        assert.equal(err.wattsnatchConnected, true,
          'a connection that completed and then got no reply must read true, not false');
        assert.match(err.message, /waiting for a response after connecting/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('a normal successful response resolves and needs no connection-state tag at all', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await tesla.jsonFetch(`http://127.0.0.1:${port}/x`, { timeout: 2000 });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"ok":true}');
  } finally {
    server.close();
  }
});
