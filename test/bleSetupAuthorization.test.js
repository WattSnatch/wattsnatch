/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Bluetooth setups could never pair a virtual key.
//
// Issue #17, second defect. Tesla refuses to add a virtual key for an application the
// account has not authorised, and says so with "have not granted this app access to
// your account". Bluetooth LE mode skipped the Tesla sign-in entirely and told the user
// on screen that no login was needed, so every Bluetooth setup reached the pairing step
// unable to complete it. The reporter got past it only by switching to Fleet API mode,
// signing in, switching back, and retrying the pairing link.
//
// The sign-in has to sit after domain registration and before pairing. Not earlier:
// Tesla will not authorise users for an application whose domain it does not yet know,
// which is the "No policy rules" dead end the Fleet path already registers ahead of, and
// Bluetooth mode does not register its domain until the public-key step. So the wizard
// collects the redirect URI at the credentials step, registers the domain at the key
// step, and requires the sign-in at the pairing step.
//
// The check deliberately runs in both modes. Fleet users signed in several steps earlier
// so it stays hidden for them, and anyone arriving unauthorised for any other reason is
// told before walking out to the car, which is what that step asks them to do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const routeSrc = read('src', 'routes', 'setup.js');
const uiSrc    = read('public', 'js', 'setup.js');
const htmlSrc  = read('public', 'setup.html');

test('the wizard can ask whether the account has authorised the app', () => {
  // Nothing in settings records this, so the stored token row is the only signal.
  assert.match(routeSrc, /router\.get\('\/api\/setup\/tesla-auth-status'/,
    'there must be an endpoint the pairing step can consult');
  const route = routeSrc.slice(routeSrc.indexOf("router.get('/api/setup/tesla-auth-status'"),
                               routeSrc.indexOf("router.get('/api/setup/fetch-vehicles'"));
  assert.ok(route.length > 0, 'the endpoint body must be found');
  assert.match(route, /authorized:\s*!!db\.getToken\('tesla'\)/,
    'it must report on the real token, not a settings flag that nothing maintains');
});

test('Bluetooth mode no longer hides the redirect URI', () => {
  // Tesla's login cannot run without one, and this mode now has to sign in.
  const fn = uiSrc.slice(uiSrc.indexOf('function initStep5DevApp()'),
                         uiSrc.indexOf('async function saveTeslaCredsAndRedirect()'));
  assert.ok(fn.length > 0, 'the step 5 initialiser must be found');
  assert.match(fn, /tesla-redirect-uri-group'\)\?\.classList\.remove\('hidden'\)/,
    'the redirect URI must be shown in both modes');
  assert.ok(!/tesla-redirect-uri-group'\)\?\.classList\.toggle\('hidden', isBle\)/.test(fn),
    'the old Bluetooth-hides-it behaviour must be gone');
});

test('the domain field stays hidden in Bluetooth mode, which registers it later', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('function initStep5DevApp()'),
                         uiSrc.indexOf('async function saveTeslaCredsAndRedirect()'));
  assert.match(fn, /tesla-domain-group'\)\?\.classList\.toggle\('hidden', isBle\)/,
    'Bluetooth mode registers its domain at the key step, so it is not asked for here');
});

test('the Bluetooth credentials step requires and stores the redirect URI', () => {
  const branch = uiSrc.slice(uiSrc.indexOf("if (selectedVehicleMode === 'ble') {"),
                             uiSrc.indexOf('const redirectUri = document.getElementById'));
  assert.ok(branch.length > 0, 'the Bluetooth branch must be found');
  assert.match(branch, /bleRedirectUri/, 'it must read the redirect URI');
  assert.match(branch, /tesla_redirect_uri: bleRedirectUri/,
    'it must persist it, otherwise the later sign-in cannot run');
  assert.match(branch, /!clientId \|\| !clientSecret \|\| !bleRedirectUri/,
    'all three are required now');
});

test('the screen no longer claims a login is unnecessary', () => {
  assert.ok(!/No login or redirect URI is needed for Bluetooth LE mode/.test(uiSrc),
    'that sentence is what sent Bluetooth users into an unpairable setup');
  assert.ok(!/it does not redirect anywhere or log in to your Tesla account/.test(uiSrc),
    'the info alert must not promise there is no sign-in at all');
});

test('the pairing step is initialised when it is reached', () => {
  assert.match(uiSrc, /if \(n === 8\) initStep8Pairing\(\);/,
    'without the dispatch the check never runs');
  assert.match(uiSrc, /async function initStep8Pairing\(\)/, 'the initialiser must exist');
});

test('the pairing step shows the notice only when the account has not authorised', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('async function initStep8Pairing()'),
                         uiSrc.indexOf("document.getElementById('step8-authorise-btn')"));
  assert.ok(fn.length > 0, 'the pairing initialiser must be found');
  assert.match(fn, /api\('\/api\/setup\/tesla-auth-status'\)/, 'it must consult the endpoint');
  assert.match(fn, /classList\.toggle\('hidden', !!\(data && data\.authorized\)\)/,
    'an authorised account must not be nagged');
});

test('a failed check does not block the step', () => {
  // Being unable to ask is not evidence the user has not authorised. Blocking on a
  // failed request would be a new dead end in place of the old one.
  const fn = uiSrc.slice(uiSrc.indexOf('async function initStep8Pairing()'),
                         uiSrc.indexOf("document.getElementById('step8-authorise-btn')"));
  assert.match(fn, /catch[\s\S]{0,120}classList\.add\('hidden'\)/,
    'a failed status check must leave the step usable');
});

test('the check is not restricted to Bluetooth mode', () => {
  const fn = uiSrc.slice(uiSrc.indexOf('async function initStep8Pairing()'),
                         uiSrc.indexOf("document.getElementById('step8-authorise-btn')"));
  assert.ok(!/selectedVehicleMode/.test(fn),
    'it is a safety net for any unauthorised arrival, not a Bluetooth special case');
});

test('the pairing step has a hidden notice and a way to sign in', () => {
  const step8 = htmlSrc.slice(htmlSrc.indexOf('id="step-8"'), htmlSrc.indexOf('id="step-9"'));
  assert.ok(step8.length > 0, 'the pairing step markup must be found');
  assert.match(step8, /id="step8-auth-gate"[^>]*class="[^"]*hidden/,
    'the notice must start hidden so authorised users never see it');
  assert.match(step8, /id="step8-authorise-btn"/, 'there must be a button to sign in');
  assert.match(step8, /have not granted this app access/,
    'the notice should quote the error Tesla actually shows');
});

test('the mode picker does not promise there is no Tesla login', () => {
  // The claim that Bluetooth mode needs no OAuth login survived in the step 4 mode
  // picker after the rest of this fix landed, which would have gone on telling people
  // the opposite of what the pairing step now requires of them.
  const picker = htmlSrc.slice(htmlSrc.indexOf('id="vehicle-mode-picker"'),
                               htmlSrc.indexOf('id="vehicle-mode-picker"') + 2200);
  assert.ok(picker.length > 0, 'the mode picker must be found');
  assert.ok(!/no Tesla OAuth login/.test(picker),
    'Bluetooth mode does need a one-time sign-in before pairing');
  assert.match(picker, /one-time Tesla sign-in/,
    'and the picker should say so where the choice is actually made');
});

test('the sign-in button goes through the normal OAuth start', () => {
  assert.match(uiSrc, /step8-authorise-btn[\s\S]{0,200}\/auth\/tesla\/start/,
    'it must reuse the existing OAuth entry point rather than a second implementation');
});
