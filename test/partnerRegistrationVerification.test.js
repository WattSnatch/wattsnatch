/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// A 200 from Tesla's partner_accounts POST is not evidence that Tesla stored anything.
//
// Issue #17. The wizard displayed "Registered" while Tesla held no public key at all
// for the domain. The reporter spent days chasing a virtual key pairing failure that
// the green tick had apparently ruled out, and only found the truth by running the
// read-back endpoint by hand with curl. In his own words: "the wizard's own
// registration call really was silently failing even though it displayed success."
//
// Three things were wrong at once, and all three had to be true for the lie to hold:
//   - tesla_partner_registered was written straight after the POST returned
//   - the Tesla-side read-back was treated as an optional extra, wrapped in a catch
//     that discarded the result with a comment saying it must never gate success
//   - the response said ok: true regardless, and all three front-end call sites read
//     only data.ok, so registrationVerified was computed and then ignored
//
// The read-back is now the success condition. These assertions are source-level
// because the route makes live Tesla calls and destructures its helpers at require
// time, so there is nothing to stub without a loader hook. Each slice asserts it
// found its block first, so a rename cannot leave the checks passing against an
// empty string.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'setup.js'), 'utf8');
const code = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'setup.js'), 'utf8');

// Isolate the register-partner handler so nothing here can be satisfied by another route.
const routeStart = code.indexOf("router.post('/api/setup/register-partner'");
const routeEnd   = code.indexOf("router.get('/api/setup/fetch-vehicles'", routeStart);
const route      = code.slice(routeStart, routeEnd);

test('the register-partner route is found and bounded', () => {
  assert.ok(routeStart >= 0, 'the route must exist');
  assert.ok(routeEnd > routeStart, 'the route must be bounded by the next route');
  assert.ok(route.length > 200, 'the isolated route body must be substantial');
});

test('the registered flag is no longer written before Tesla is asked', () => {
  // This ordering is the whole bug. Writing the flag first meant a later failure could
  // not retract it, and the wizard had already been told it succeeded.
  const askedTesla = route.indexOf('getRegisteredPublicKey(');
  const wroteFlag  = route.indexOf("setSetting('tesla_partner_registered', 'true')");
  assert.ok(askedTesla >= 0, 'the route must read the key back from Tesla');
  assert.ok(wroteFlag >= 0, 'the route must still record a confirmed registration');
  assert.ok(wroteFlag > askedTesla,
    'the flag must be written after the read-back, never before it');
});

test('the flag is written only on a confirmed match', () => {
  const trueBranch = route.slice(route.indexOf('if (registrationVerified === true) {'),
                                 route.indexOf('if (registrationVerified === false) {'));
  assert.ok(trueBranch.length > 0, 'there must be an explicit verified-true branch');
  assert.match(trueBranch, /setSetting\('tesla_partner_registered', 'true'\)/,
    'the confirmed branch is the only place that may claim registration');

  const occurrences = route.split("setSetting('tesla_partner_registered', 'true')").length - 1;
  assert.equal(occurrences, 1, 'exactly one place may set the flag true');
});

test('a key Tesla does not hold, or does not match, fails the request', () => {
  const falseBranch = route.slice(route.indexOf('if (registrationVerified === false) {'),
                                  route.indexOf('return res.json({\n      ok: true'));
  assert.ok(falseBranch.length > 0, 'there must be an explicit verified-false branch');
  assert.match(falseBranch, /ok: false/,
    'a registration Tesla cannot confirm must not report success');
  assert.match(falseBranch, /setSetting\('tesla_partner_registered', 'false'\)/,
    'a previously stored true must be retracted, not left stale');
});

test('the failure message tells the user which of the two cases they are in', () => {
  const falseBranch = route.slice(route.indexOf('if (registrationVerified === false) {'),
                                  route.indexOf('return res.json({\n      ok: true'));
  assert.match(falseBranch, /teslaHasKey\s*\n?\s*\?/,
    'the message must branch on whether Tesla holds a key at all');
  assert.match(falseBranch, /no public key stored/,
    'the no-key case must say so plainly');
  assert.match(falseBranch, /not this installation's key/,
    'the mismatch case must say so plainly, since the recovery differs');
  assert.match(falseBranch, /no endpoint for replacing a stored key/,
    'the mismatch case must explain why pressing Register again will not help');
});

test('being unable to reach Tesla does not fail the registration, but never claims success', () => {
  // Tesla being unreachable is not Tesla saying no. Blocking setup on a network blip
  // would be its own bug, so this path stays ok while reporting null.
  assert.match(route, /catch \(e\) \{[\s\S]*?verifyError = e\.message/,
    'a verification error must be captured rather than silently swallowed');
  const unknown = route.slice(route.lastIndexOf('return res.json({'));
  assert.ok(unknown.length > 0, 'there must be a final unknown-state response');
  assert.match(unknown, /registrationVerified: null/,
    'an unconfirmed registration must report null, not true');
  assert.match(unknown, /warning:/,
    'the caller must be given something to show rather than a bare success');
  assert.ok(!/setSetting\('tesla_partner_registered', 'true'\)/.test(unknown),
    'the unknown path must not record a confirmed registration');
});

test('the old unconditional success response is gone', () => {
  assert.ok(!/res\.json\(\{ ok: true, region: db\.getSetting\('tesla_region'\) \|\| 'na', teslaHasKey, registrationVerified \}\)/.test(route),
    'the single ok-regardless response that caused this must not return');
});

test('the wizard requires confirmation before it shows Registered', () => {
  assert.match(uiSrc, /data\.ok && data\.registrationVerified === true/,
    'the Bluetooth key step must require confirmation, not a bare ok');
  assert.ok(!/if \(data\.ok\) \{\s*\n\s*blePartnerRegistered = true;/.test(uiSrc),
    'the old bare-ok path that set the registered flag must be gone');
  assert.match(uiSrc, /Sent, but not confirmed by Tesla/,
    'an unconfirmed registration needs its own visible wording');
});

test('the vehicle step distinguishes confirmed from merely sent', () => {
  assert.match(uiSrc, /registrationVerified === true[\s\S]{0,140}confirmed by Tesla/,
    'the vehicle step must say which of the two happened');
  assert.ok(!/Registered! Fetching vehicle list/.test(uiSrc),
    'the old unconditional "Registered!" must be gone');
});
