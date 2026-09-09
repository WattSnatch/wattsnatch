/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Region discovery + the 412 handling behind issue #17. WattSnatch assumed region 'na'; when a
// user's Fleet account lives elsewhere, partner registration and vehicle calls fail - a vehicle
// list returns 412 "account must be registered in the current region <url>", and that body was
// being thrown away. parseRegionResponse turns both the happy 200 and the 412-with-hint into the
// right region, so the app can register against the region the account actually uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-region-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const tesla = require('../src/services/tesla');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

test('a 200 region reply maps the base URL to the internal region key', () => {
  const eu = tesla.parseRegionResponse(200,
    '{"response":{"region":"eu","fleet_api_base_url":"https://fleet-api.prd.eu.vn.cloud.tesla.com"}}');
  assert.deepEqual(eu, { region: 'eu', baseUrl: 'https://fleet-api.prd.eu.vn.cloud.tesla.com' });

  const na = tesla.parseRegionResponse(200,
    '{"response":{"region":"na","fleet_api_base_url":"https://fleet-api.prd.na.vn.cloud.tesla.com"}}');
  assert.equal(na.region, 'na');
});

test('a 412 that names the correct region in prose is still parsed (the swallowed-body bug)', () => {
  const body = '{"error":"Account 1234 must be registered in the current region '
    + 'https://fleet-api.prd.eu.vn.cloud.tesla.com before this API can be used."}';
  const parsed = tesla.parseRegionResponse(412, body);
  assert.ok(parsed, 'a 412 body naming a region must still yield a region');
  assert.equal(parsed.region, 'eu', 'must extract eu from the 412 message, not default to na');
});

test('the China host (.cn) is recognised', () => {
  const cn = tesla.parseRegionResponse(200,
    '{"response":{"region":"cn","fleet_api_base_url":"https://fleet-api.prd.cn.vn.cloud.tesla.cn"}}');
  assert.equal(cn.region, 'cn');
});

test('an unusable body returns null so the caller never re-registers on a blind failure', () => {
  assert.equal(tesla.parseRegionResponse(500, 'Internal Server Error'), null);
  assert.equal(tesla.parseRegionResponse(200, 'not json, no url'), null);
  assert.equal(tesla.parseRegionResponse(412, ''), null);
});

test('parseRegionResponse and getRegisteredPublicKey are exported for the setup flow', () => {
  assert.equal(typeof tesla.getUserRegion, 'function');
  assert.equal(typeof tesla.getRegisteredPublicKey, 'function');
});

test('the vehicle-list error now carries the response body (region hint), not a bare status', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'tesla.js'), 'utf8');
  // Both list paths must include res.body in the thrown message so a 412 explains itself.
  const matches = src.match(/List vehicles failed with status \$\{res\.status\}: \$\{\(res\.body/g) || [];
  assert.ok(matches.length >= 2, 'both listVehicles and getVehicleState must surface the 412 body');
});
