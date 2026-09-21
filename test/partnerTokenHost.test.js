/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Partner tokens go to Tesla's Fleet Auth host; user logins do not.
//
// Tesla documents https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token for the
// client-credentials exchange used to register a partner account. WattSnatch was sending
// that request to auth.tesla.com, the account login host, which is where the user OAuth
// flow belongs.
//
// This is a standards correction and deliberately nothing more. Issue #6 reports newly
// created developer applications failing partner registration with invalid_audience, and
// that reporter already tested both hosts and saw the same failure on each. Moving the
// host does not fix #6 and must never be offered to them as though it does.
//
// The user OAuth exchange and refresh are deliberately left on auth.tesla.com. They work
// for every existing install, and changing a working login path to satisfy a
// documentation change nobody has reported a problem with would risk locking people out.
// These tests pin that split, because the tempting "tidy-up" is to move all three.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'tesla.js'), 'utf8');

test('the Fleet Auth host is defined separately from the login host', () => {
  assert.match(src, /const TESLA_FLEET_AUTH = 'https:\/\/fleet-auth\.prd\.vn\.cloud\.tesla\.com'/,
    'the partner-token host must be its own constant');
  assert.match(src, /const TESLA_AUTH = 'https:\/\/auth\.tesla\.com'/,
    'the user login host must remain');
});

test('the partner token request uses the Fleet Auth host', () => {
  const fn = src.slice(src.indexOf('async function getPartnerToken('),
                       src.indexOf('async function registerPartnerAccount('));
  assert.ok(fn.length > 0, 'getPartnerToken must be found');
  assert.match(fn, /\$\{TESLA_FLEET_AUTH\}\/oauth2\/v3\/token/,
    'the client-credentials exchange is what Tesla documents against Fleet Auth');
  assert.ok(!/\$\{TESLA_AUTH\}\/oauth2\/v3\/token/.test(fn),
    'it must no longer post the partner token to the account login host');
  assert.match(fn, /grant_type: 'client_credentials'/,
    'guard that this is still the partner flow being asserted about');
});

test('the user login flow is untouched', () => {
  // Moving these would risk locking out every working install to satisfy a docs change.
  const exchange = src.slice(src.indexOf('async function exchangeCode('),
                             src.indexOf('async function refreshAccessToken('));
  const refresh = src.slice(src.indexOf('async function refreshAccessToken('),
                            src.indexOf('async function listVehicles('));
  assert.ok(exchange.length > 0 && refresh.length > 0, 'both OAuth functions must be found');
  assert.match(exchange, /\$\{TESLA_AUTH\}\/oauth2\/v3\/token/,
    'the code exchange must stay on the account login host');
  assert.match(refresh, /\$\{TESLA_AUTH\}\/oauth2\/v3\/token/,
    'the refresh must stay on the account login host');
});

test('the authorize URL stays on the login host', () => {
  assert.match(src, /\$\{TESLA_AUTH\}\/oauth2\/v3\/authorize/,
    'the browser-facing login page is not a Fleet Auth endpoint');
});
