/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Proves the OCPP adapter cannot change Tesla behaviour.
//
// Two separate guarantees, tested separately because they hold for different
// reasons:
//
// 1. services/charging/tesla.js is a static re-export, evaluated once and
//    never mutated - every property on it is LITERALLY the same function
//    object as services/tesla.js / services/telemetry.js export. Reference
//    equality, not "looks the same".
//
// 2. services/charging/index.js (the dispatcher controller.js actually
//    requires) forwards every call, with the default 'tesla' backend, to
//    services/charging/tesla.js with the arguments unchanged, and returns or
//    throws exactly what that call returns or throws. Proven by monkey-
//    patching services/charging/tesla.js's own exports (which the dispatcher
//    re-requires - and Node caches - on every call) and inspecting what it
//    was called with.
//
// Together: charging_backend='tesla' (the default every existing install
// has) means controller.js's calls are indistinguishable from calling
// services/tesla.js / services/telemetry.js directly, by construction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-chargingbackend-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const realTesla = require('../src/services/tesla');
const realTelemetry = require('../src/services/telemetry');
const chargingTesla = require('../src/services/charging/tesla');
const dispatcher = require('../src/services/charging');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

const COMMAND_FNS = [
  'wakeVehicle', 'setChargingAmps', 'startCharging', 'stopCharging',
  'getVehicleState', 'getVehicleData', 'useBleCommands',
  'getVehicleDataBle', 'getBodyStateBle',
];
const TELEMETRY_FNS = [
  'startTelemetryListener', 'onVehicleUpdate', 'getState', 'getAge', 'isStale',
  'updateFromApi', 'getChargeLimitAge', 'setChargeLimitLocal',
];

test('charging_backend defaults to tesla', () => {
  assert.equal(db.getSetting('charging_backend'), 'tesla');
});

test('services/charging/tesla.js re-exports are reference-identical to services/tesla.js', () => {
  for (const name of COMMAND_FNS) {
    assert.equal(chargingTesla[name], realTesla[name], `${name} is not the real services/tesla.js function`);
  }
});

test('services/charging/tesla.js telemetry re-exports are reference-identical to services/telemetry.js', () => {
  for (const name of TELEMETRY_FNS) {
    assert.equal(chargingTesla.telemetry[name], realTelemetry[name], `telemetry.${name} is not the real services/telemetry.js function`);
  }
});

test('dispatcher forwards command calls with unchanged arguments and return value (backend=tesla)', async () => {
  for (const name of COMMAND_FNS) {
    const original = chargingTesla[name];
    let received = null;
    const sentinel = { ok: `sentinel-${name}` };
    chargingTesla[name] = (...args) => { received = args; return sentinel; };
    try {
      const args = [`arg1-${name}`, `arg2-${name}`, `arg3-${name}`];
      const result = dispatcher[name](...args);
      assert.deepEqual(received, args, `${name}: dispatcher altered the arguments`);
      assert.equal(result, sentinel, `${name}: dispatcher altered the return value`);
    } finally {
      chargingTesla[name] = original;
    }
  }
});

test('dispatcher forwards command call throws unchanged (backend=tesla)', () => {
  const original = chargingTesla.stopCharging;
  const err = new Error('sentinel-throw');
  chargingTesla.stopCharging = () => { throw err; };
  try {
    assert.throws(() => dispatcher.stopCharging('vin', 'token'), (e) => e === err);
  } finally {
    chargingTesla.stopCharging = original;
  }
});

test('dispatcher forwards async command rejection unchanged (backend=tesla)', async () => {
  const original = chargingTesla.startCharging;
  const err = new Error('sentinel-rejection');
  chargingTesla.startCharging = () => Promise.reject(err);
  try {
    await assert.rejects(() => dispatcher.startCharging('vin', 'token'), (e) => e === err);
  } finally {
    chargingTesla.startCharging = original;
  }
});

test('dispatcher forwards telemetry calls with unchanged arguments and return value (backend=tesla)', () => {
  for (const name of TELEMETRY_FNS) {
    const original = chargingTesla.telemetry[name];
    let received = null;
    const sentinel = { ok: `sentinel-telemetry-${name}` };
    chargingTesla.telemetry[name] = (...args) => { received = args; return sentinel; };
    try {
      const args = [`arg1-${name}`, `arg2-${name}`];
      const result = dispatcher.telemetry[name](...args);
      assert.deepEqual(received, args, `telemetry.${name}: dispatcher altered the arguments`);
      assert.equal(result, sentinel, `telemetry.${name}: dispatcher altered the return value`);
    } finally {
      chargingTesla.telemetry[name] = original;
    }
  }
});

test('dispatcher only routes to ocpp when charging_backend is exactly "ocpp"', () => {
  const originalTesla = chargingTesla.wakeVehicle;
  const ocpp = require('../src/services/charging/ocpp');
  const originalOcpp = ocpp.wakeVehicle;
  let calledTesla = false;
  let calledOcpp = false;
  chargingTesla.wakeVehicle = () => { calledTesla = true; return 'tesla-result'; };
  ocpp.wakeVehicle = () => { calledOcpp = true; return 'ocpp-result'; };
  try {
    for (const unsetLike of ['', 'tesla', 'anything-else']) {
      calledTesla = false; calledOcpp = false;
      db.setSetting('charging_backend', unsetLike);
      const result = dispatcher.wakeVehicle();
      assert.equal(calledTesla, true, `charging_backend=${JSON.stringify(unsetLike)} should route to tesla`);
      assert.equal(calledOcpp, false, `charging_backend=${JSON.stringify(unsetLike)} should not route to ocpp`);
      assert.equal(result, 'tesla-result');
    }

    calledTesla = false; calledOcpp = false;
    db.setSetting('charging_backend', 'ocpp');
    const result = dispatcher.wakeVehicle();
    assert.equal(calledOcpp, true, 'charging_backend=ocpp should route to ocpp');
    assert.equal(calledTesla, false, 'charging_backend=ocpp should not route to tesla');
    assert.equal(result, 'ocpp-result');
  } finally {
    chargingTesla.wakeVehicle = originalTesla;
    ocpp.wakeVehicle = originalOcpp;
    db.setSetting('charging_backend', 'tesla');
  }
});
