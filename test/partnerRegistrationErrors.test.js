/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Friendly partner-registration errors (issue #19). Two real installs hit Tesla 424s that the
// app relayed verbatim: publishing the RSA proxy TLS cert instead of the EC key ("too large"),
// and not publishing the key at all ("got 404"). Both are self-inflicted and fixable in ten
// seconds once you know which - so the message must name the fix, not just echo Tesla.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-preg-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;
const db = require('../src/db');
db.initDb();
const tesla = require('../src/services/tesla');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('"too large" points at the wrong key file, not just the raw error', () => {
  const msg = tesla.partnerRegistrationErrorMessage(424,
    '{"response":null,"error":"Public key download failed for https://x.github.io/... error: too large"}');
  assert.match(msg, /public\.pem/, 'must name the correct EC key file to publish');
  assert.match(msg, /proxy-tls-cert\.pem/, 'must name the wrong file the user likely published');
  assert.doesNotMatch(msg, /status 424: \{/, 'must not just echo the raw Tesla JSON');
});

test('a 404 tells the user to publish the key at the exact path', () => {
  const msg = tesla.partnerRegistrationErrorMessage(424,
    '{"error":"Public key download failed ... must return 200 response code, got 404; body: ..."}');
  assert.match(msg, /404/);
  assert.match(msg, /com\.tesla\.3p\.public-key\.pem/, 'must name the exact well-known path');
  assert.match(msg, /public\.pem/, 'must tell them which file to publish there');
});

test('an unrecognised failure still surfaces the status and body', () => {
  const msg = tesla.partnerRegistrationErrorMessage(500, 'something else entirely');
  assert.match(msg, /500/);
  assert.match(msg, /something else entirely/, 'unknown errors must not be swallowed');
});
