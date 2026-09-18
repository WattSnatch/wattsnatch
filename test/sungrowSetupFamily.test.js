/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The setup wizard must let a Sungrow owner say which product line they have.
//
// Reported as issue #20: an SG10RS string inverter timed out in WattSnatch while
// the user's own Modbus diagnostic against the same host worked. The two Sungrow
// lines do not share a register map. SG-series string inverters have no 13xxx
// block at all and their meter data sits in the 5xxx block instead, so reading an
// SG with the SH map returns nothing and the connection simply times out.
//
// sungrow_inverter_family selects the map and defaults to 'sh'. The wizard saved
// host, port and unit ID but never the family, so every fresh SG setup silently
// got the wrong map. The only selector lived inside the Sungrow home-battery card
// in Settings, which is the last place an SG owner with no battery would look.
//
// These are source-level assertions. The wizard is browser code with no DOM
// harness in this suite, so what is pinned here is the wiring that was missing:
// a control the user can reach, a collector that reads it, and an allowlist that
// lets it persist. A break in any one of those silently restores the bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const setupHtml = read('public', 'setup.html');
const setupJs   = read('public', 'js', 'setup.js');
const apiJs     = read('src', 'routes', 'api.js');
const dbJs      = read('src', 'db.js');
const meterJs   = read('src', 'services', 'meters', 'sungrow.js');

test('the wizard offers an inverter family choice for Sungrow', () => {
  const block = setupHtml.slice(setupHtml.indexOf('id="brand-fields-sungrow"'),
                                setupHtml.indexOf('id="brand-fields-mqtt"'));
  assert.ok(block.length > 0, 'the Sungrow field block must be found');
  assert.match(block, /id="sungrow-family-input"/,
    'without a control in the wizard, an SG owner has no way to say so during setup');
  assert.match(block, /value="sg"/, 'SG series must be selectable');
  assert.match(block, /value="sh"/, 'SH series must remain selectable');
});

test('the wizard collects the family when saving Sungrow settings', () => {
  const block = setupJs.slice(setupJs.indexOf("selectedInverterBrand === 'sungrow'"),
                              setupJs.indexOf("selectedInverterBrand === 'mqtt'"));
  assert.ok(block.length > 0, 'the Sungrow collector must be found');
  assert.match(block, /sungrow_inverter_family/,
    'a control nobody reads is the same bug in a different place');
  assert.match(block, /sungrow-family-input/, 'it must read the control the wizard renders');
});

test('the family survives the settings save, rather than being dropped by the allowlist', () => {
  // The wizard posts to /api/settings, which filters to an allowlist. A key
  // missing from it is discarded in silence, which is exactly how a setting can
  // appear to save and then not exist.
  assert.match(apiJs, /'sungrow_inverter_family'/,
    'the key must be accepted by the settings allowlist');
});

test('the default stays SH so existing installs are untouched', () => {
  assert.match(dbJs, /sungrow_inverter_family:\s*'sh'/,
    'changing the default would silently repoint every existing Sungrow install');
});

test('the meter still selects its register map from that setting', () => {
  // If this stops being the consumer, the wizard field becomes decorative.
  assert.match(meterJs, /getSetting\('sungrow_inverter_family'\)/,
    'the setting must still drive the register map the meter reads');
});
