/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Bluetooth setups can now avoid Tesla's cloud completely.
//
// TeslaBleHttpProxy generates its own keypair and pairs it with the car over Bluetooth,
// approved by tapping an NFC key card on the console. No Tesla developer application, no
// public key hosted on a domain, no partner registration, no OAuth sign-in. WattSnatch
// required all four because of a design choice of its own: it generated the keypair, got
// it paired through Tesla's virtual key flow, and had the proxy sign with a copy of that
// same private key. Step 9 still says so: "Copy the same keys/private.pem WattSnatch
// generated onto that machine."
//
// tesla_pairing_mode records which of the two happened. It defaults to 'cloud', so every
// existing install keeps exactly the setup it has. A good half of these assertions exist
// to hold that line, because the risk in this change is not the new path failing, it is
// the new path disturbing a working one.
//
// The Charging Manager key the local path recommends covers waking, starting, stopping
// and setting the charge rate, and deliberately cannot unlock or drive the car. It also
// cannot set the charge limit, so anything built on that has to stand down rather than
// fail twice a day for ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-localpair-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const banking = require('../src/services/solarBanking');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const setupJs   = read('public', 'js', 'setup.js');
const setupHtml = read('public', 'setup.html');
const apiJs     = read('src', 'routes', 'api.js');
const ctrlJs    = read('src', 'controller.js');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

// ── The setting ──────────────────────────────────────────────────────────────

test('pairing mode ships as cloud, so no existing install changes behaviour', () => {
  assert.equal(db.getSetting('tesla_pairing_mode'), 'cloud',
    'an upgrade must not silently move anyone onto the new path');
});

test('the pairing mode can be saved through the settings API', () => {
  assert.match(apiJs, /'tesla_pairing_mode'/,
    'a key missing from the allowlist is discarded in silence');
});

// ── The wizard routing ───────────────────────────────────────────────────────

test('local pairing is a separate flag, not a third vehicle mode', () => {
  // Every other branch in the wizard tests selectedVehicleMode === 'ble'. A third value
  // would quietly fall out of all of them.
  assert.match(setupJs, /let selectedPairingMode = 'cloud';/,
    'the pairing choice must be tracked separately');
  assert.match(setupJs, /function isLocalPairing\(\) \{ return selectedVehicleMode === 'ble' && selectedPairingMode === 'local'; \}/,
    'local pairing must require Bluetooth mode as well, not stand alone');
});

test('the mode picker offers the local option and marks it as needing no account', () => {
  const picker = setupHtml.slice(setupHtml.indexOf('id="vehicle-mode-picker"'),
                                 setupHtml.indexOf('id="vehicle-mode-picker"') + 4000);
  assert.ok(picker.length > 0, 'the mode picker must be found');
  assert.match(picker, /data-mode="ble" data-pairing="local"/,
    'the third choice must be Bluetooth mode with local pairing');
  assert.match(picker, /no Tesla account at all/,
    'the distinguishing property should be what the user sees');
  assert.match(picker, /charge limit is not available/i,
    'the one real limitation belongs where the choice is made, not three steps later');
});

test('the developer app, key hosting and Tesla pairing steps are skipped', () => {
  assert.match(setupJs, /goToStep\(isLocalPairing\(\) \? 6 : 5\)/,
    'step 5 asks for a developer app that local pairing does not need');
  assert.match(setupJs, /step6-next[\s\S]{0,80}isLocalPairing\(\) \? 9 : 7/,
    'steps 7 and 8 host a key and pair it through Tesla, neither of which applies');
});

test('going back from the proxy step returns to where the user actually came from', () => {
  assert.match(setupJs, /step9-back[\s\S]{0,80}isLocalPairing\(\) \? 6 : 8/,
    'back must not land on a step that was skipped');
  assert.match(setupJs, /step6-back[\s\S]{0,80}isLocalPairing\(\) \? 4 : 5/,
    'nor on the developer app step');
});

test('the proxy step carries the pairing instructions in local mode', () => {
  assert.match(setupJs, /step9-local-pairing'\)\?\.classList\.toggle\('hidden', !local\)/,
    'the local instructions must be shown only in local mode');
  assert.match(setupJs, /step9-copy-key-item'\)\?\.classList\.toggle\('hidden', local\)/,
    'the instruction to copy WattSnatch\'s private key is wrong in this mode');

  const step9 = setupHtml.slice(setupHtml.indexOf('id="step-9"'), setupHtml.indexOf('id="step-10"'));
  assert.ok(step9.length > 0, 'the proxy step must be found');
  assert.match(step9, /id="step9-local-pairing"[^>]*class="hidden"/,
    'the local block must start hidden so cloud setups never see it');
  assert.match(step9, /Charging Manager/, 'it must name the key role to generate');
  assert.match(step9, /NFC key card/, 'and how the pairing is approved');
  assert.match(step9, /cannot unlock or drive the car/,
    'the security property that justifies the role should be stated');
});

// ── Cloud mode must be undisturbed ───────────────────────────────────────────

test('local mode tells the user to actually start the proxy', () => {
  // The copy-the-private-key step is also the only one that says to run the proxy, and
  // local mode hides it. Without a replacement the path builds a binary, never says to
  // start it, and then asks the user to open a dashboard that is not running.
  assert.match(setupJs, /step9-run-item'\)\?\.classList\.toggle\('hidden', !local\)/,
    'the run step must be shown exactly when the copy step is hidden');
  const step9 = setupHtml.slice(setupHtml.indexOf('id="step-9"'), setupHtml.indexOf('id="step-10"'));
  assert.match(step9, /id="step9-run-item"/, 'there must be a run step for local mode');
  assert.match(step9, /Start it:/, 'it must say to start it');
  assert.match(step9, /Leave it running/, 'and that it stays running');
  assert.match(step9, /Nothing needs copying from WattSnatch/,
    'and correct the expectation set by the step it replaces');
});

test('the dashboard address is tied to the field the user fills in', () => {
  const step9 = setupHtml.slice(setupHtml.indexOf('id="step-9"'), setupHtml.indexOf('id="step-10"'));
  assert.match(step9, /the same machine and port you will enter in the <strong>BLE Proxy URL<\/strong> box below/,
    'two unexplained addresses on one screen is how people get stuck');
  assert.match(step9, /When the key is paired,/,
    'the step needs an ending that says what to do next');
});

test('cloud mode still walks the original step order', () => {
  // Each of these is the false branch of a ternary added above. If any of them changed,
  // an existing Fleet or Bluetooth setup would take a different path through the wizard.
  assert.match(setupJs, /goToStep\(isLocalPairing\(\) \? 6 : 5\)/, 'step 4 still goes to 5');
  assert.match(setupJs, /isLocalPairing\(\) \? 9 : 7/, 'step 6 still goes to 7');
  assert.match(setupJs, /isLocalPairing\(\) \? 6 : 8/, 'step 9 still goes back to 8');
  assert.match(setupJs, /isLocalPairing\(\) \? 4 : 5/, 'step 6 still goes back to 5');
});

test('the existing Bluetooth choice is unchanged and still defaults to cloud pairing', () => {
  const picker = setupHtml.slice(setupHtml.indexOf('id="vehicle-mode-picker"'),
                                 setupHtml.indexOf('id="vehicle-mode-picker"') + 4000);
  const bleNoPairing = /data-mode="ble"(?! data-pairing)/.test(picker);
  assert.ok(bleNoPairing, 'the original Bluetooth pill must remain, without a pairing attribute');
  assert.match(setupJs, /selectedPairingMode = pairing \|\| 'cloud'/,
    'a pill with no pairing attribute must mean cloud, which is what that pill is');
});

// ── Runtime consequences ─────────────────────────────────────────────────────

test('a missing Tesla token is not reported as a fault in local mode', () => {
  // There is deliberately no token. Warning once a minute for ever would be noise about
  // a setup working exactly as designed.
  assert.match(ctrlJs, /if \(db\.getSetting\('tesla_pairing_mode'\) !== 'local'\) this\._logTokenProblem\('not authenticated'\)/,
    'the warning must be suppressed only for local pairing, not in general');
});

test('the charge limit control refuses with a reason rather than a raw proxy error', () => {
  const route = apiJs.slice(apiJs.indexOf("router.post('/api/charge/limit'"),
                            apiJs.indexOf("router.post('/api/charge/limit'") + 1800);
  assert.ok(route.length > 0, 'the charge limit route must be found');
  assert.match(route, /tesla_pairing_mode'\) === 'local'/, 'it must know about the mode');
  assert.match(route, /Charging Manager/, 'and name what is actually refusing');
  assert.match(route, /Set the limit in the Tesla app instead/,
    'a refusal without a way forward is just a dead end');
});

test('solar banking stands down under local pairing instead of failing twice a day', () => {
  const plan = banking.planAction({
    enabled: true, backendIsOcpp: false, localPairing: true,
    chargingState: 'Charging', activeBoost: null, today: '2026-09-21',
    atHome: true, limitTrustworthy: true, forecastFresh: true,
    currentLimit: 80, ceiling: 90, forecast: { boost: true, reason: 'strong today, weak ahead' },
  });
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /local pairing cannot set the charge limit/);
});

test('solar banking is unaffected when pairing is cloud', () => {
  const plan = banking.planAction({
    enabled: true, backendIsOcpp: false, localPairing: false,
    chargingState: 'Charging', activeBoost: null, today: '2026-09-21',
    atHome: true, limitTrustworthy: true, forecastFresh: true,
    currentLimit: 80, ceiling: 90, forecast: { boost: true, reason: 'strong today, weak ahead' },
  });
  assert.equal(plan.action, 'boost', 'the existing feature must keep working as it does today');
});

test('the settings card says the feature is unavailable in local mode', () => {
  const html = read('public', 'settings.html');
  const card = html.slice(html.indexOf('Solar Banking'), html.indexOf('Solar Banking') + 2500);
  assert.match(card, /Not available with fully local Bluetooth pairing/,
    'offering a feature that silently cannot work is worse than saying so');
});
