/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Phantom-charge watchdog. Found live 2026-09-02: WattSnatch ran charging sessions for up
// to 11 hours on a battery frozen at 61% while the car was actually parked 5 km away, because
// a stale fleet-telemetry 'Charging' state was trusted indefinitely. It fabricated tens of
// kWh of "solar diversion" that TeslaMate confirms never happened. The watchdog must:
//   - not fire while SOC is genuinely progressing (a real charge), and
//   - end the session, drop out of a charging state, and force a re-check once SOC has been
//     frozen past the window while still claiming to charge.
// These are source-level assertions on controller.js: the live behaviour needs a running
// fleet-telemetry stream and a real vehicle, which a unit test cannot stand up, so we pin the
// exact guard wiring that the incident proved was missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
// Strip comments so prose that mentions a symbol cannot satisfy a code assertion.
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('a phantom-progress window is defined and is a real duration, not a flag', () => {
  const m = code.match(/PHANTOM_NO_PROGRESS_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/);
  assert.ok(m, 'PHANTOM_NO_PROGRESS_MS must be defined in minutes');
  const mins = parseInt(m[1], 10);
  assert.ok(mins >= 20 && mins <= 40,
    `window ${mins} min must be long enough not to trip a slow real charge, short enough to bound fabricated energy`);
});

test('SOC progress advances the watchdog clock', () => {
  assert.match(code, /batteryPct\s*>\s*this\._chargeProgressBattery/,
    'the clock must reset only when battery% actually rises');
  assert.match(code, /this\._chargeProgressAt\s*=\s*Date\.now\(\)/);
});

test('the excess add-back is gated on a confirmed-live charge', () => {
  assert.match(code, /const chargerWatts\s*=\s*\(currentlyCharging\s*&&\s*chargeConfirmedLive\)/,
    'a stale Charging flag must not inflate solar excess and keep the loop commanding');
});

test('logged EV watts are gated on a confirmed-live charge', () => {
  assert.match(code, /const evWatts\s*=\s*\(currentlyCharging\s*&&\s*chargeConfirmedLive\)/,
    'a stale Charging flag must not fabricate EV draw in the ledger or to Home Assistant');
});

test('the watchdog ends the session and re-checks the car when SOC is frozen', () => {
  assert.match(code, /currentlyCharging\s*&&\s*!chargeConfirmedLive/,
    'the trigger must require claiming-to-charge AND no confirmed progress');
  assert.match(code, /_endSession\([^)]*'phantom_no_soc_progress'\)/,
    'the phantom session must be ended with a distinct reason');
  assert.match(code, /this\._carSleeping\s*=\s*false/,
    'must clear the sleep suppression so the REST fallback can re-validate');
  assert.match(code, /this\._lastFallbackAt\s*=\s*0/,
    'must force the REST re-check on the next tick rather than waiting out the interval');
});

test('confirmed-live requires a real timestamp, so a never-charged controller reads not-live', () => {
  assert.match(code, /this\._chargeProgressAt\s*>\s*0\s*&&/,
    'chargeConfirmedLive must require _chargeProgressAt > 0, not treat epoch 0 as fresh');
});

test('before ending a suspected phantom, the watchdog REST-confirms the car is not charging', () => {
  // The dead-stream-but-really-charging case: frozen SOC must not be enough to stop a real
  // charge. The watchdog must make a direct REST read and only end the session when REST does
  // NOT confirm charging.
  assert.match(code, /getVehicleData\(vin,\s*teslaToken\)/,
    'must do a direct REST read to confirm the real state before ending');
  assert.match(code, /restConfirmsCharging/,
    'the end must be gated on REST failing to confirm charging');
  assert.match(code, /charging_state\s*===\s*'Charging'/,
    'a REST reading of Charging means keep the session');
});

test('a REST-confirmed live charge refreshes telemetry instead of ending the session', () => {
  assert.match(code, /telemetry\.updateFromApi\(/,
    'a confirmed real charge must feed the fresh snapshot back so the progress clock resets');
  assert.match(code, /telemetryHealth'\)\.checkAndRepair\(\)/,
    'a dead stream during a real charge is the config-wipe case - kick a re-registration');
});

test('the REST confirmation probe is rate-limited so it cannot poll-storm', () => {
  assert.match(code, /_lastPhantomProbeAt\)\s*>\s*PHANTOM_PROBE_GAP_MS/,
    'the probe must be gated by a minimum gap');
  assert.match(code, /PHANTOM_PROBE_GAP_MS\s*=\s*\d+\s*\*\s*60\s*\*\s*1000/,
    'the probe gap must be a real duration in minutes');
});
