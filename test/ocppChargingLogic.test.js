/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// End-to-end charging-logic tests for the OCPP backend.
//
// test/ocppProtocol.test.js proves the wire protocol is correct. This file
// proves the thing that actually matters day to day: that controller.js's
// real solar-diversion logic drives a real OCPP charge point correctly -
// amps tracking solar up and down, stopping when solar goes away, and the
// manual/scheduled overrides doing what they say.
//
// Real CSMS + a real `ws` charge point client + the real controller. Only the
// solar meter is stubbed, because that is genuinely external hardware and is
// the natural seam - every meter provider has its own tests already.
//
// _loop() is driven manually rather than on its timer so each tick is
// deterministic. controller.js throttles vehicle commands to every OTHER tick
// (halving Tesla API cost), so `tick()` below runs two loops to guarantee one
// command tick.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-ocpp-logic-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const TEST_PORT = 25000 + (process.pid % 3000);
const VOLTAGE = 240;

db.setSetting('charging_backend', 'ocpp');
db.setSetting('ocpp_ws_port', String(TEST_PORT));
db.setSetting('ocpp_charge_point_id', '');
db.setSetting('tesla_vin', 'LOGIC-CP');
db.setSetting('charger_voltage', String(VOLTAGE));
db.setSetting('min_charge_amps', '5');
db.setSetting('max_charge_amps', '32');
db.setSetting('smoothing_window', '1');   // no rolling average - deterministic amps
db.setSetting('hold_minutes', '3');
db.setSetting('charging_control_enabled', 'true');
db.setSetting('manual_charge_enabled', 'false');
db.setSetting('schedule_enabled', 'false');
db.setSetting('free_power_enabled', 'false');
db.setSetting('battery_brand', 'none');

// Stub the solar meter before controller.js reads it.
const meters = require('../src/services/meters');
let fakeReadings = { solarW: 0, consumptionW: 0, gridW: 0, solarActEnergyDlvdWh: null, timestamp: Date.now() };
let meterConfigured = true;
meters.getActiveProvider = () => ({
  id: 'faketest',
  label: 'Fake test meter',
  isConfigured: () => meterConfigured,
  fetchReadings: async () => ({ ...fakeReadings, timestamp: Date.now() }),
  handleFetchError: () => false,
  supportsPanelHealth: false,
});

function setSolar(solarW, houseW) {
  // gridW is import-positive; negative means exporting.
  fakeReadings = {
    solarW,
    consumptionW: houseW,
    gridW: houseW - solarW,
    solarActEnergyDlvdWh: null,
    timestamp: Date.now(),
  };
}

const ocppServer = require('../src/services/charging/ocpp/server');
const controller = require('../src/controller');

// ── Fake charge point ────────────────────────────────────────────────────────

function makeChargePoint(id) {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ocpp/${id}`, 'ocpp1.6');
  const inbound = [];          // CALLs the CSMS sent us
  const pending = new Map();
  let nextId = 1;
  let txnId = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg[0] === 3 || msg[0] === 4) {
      const cb = pending.get(msg[1]);
      if (cb) { pending.delete(msg[1]); cb(msg[2]); }
      return;
    }
    if (msg[0] === 2) {
      const [, mid, action, payload] = msg;
      inbound.push({ action, payload });
      // Behave like a real charger: accept and apply.
      ws.send(JSON.stringify([3, mid, { status: 'Accepted' }]));
      if (action === 'RemoteStopTransaction') {
        api.call('StatusNotification', { connectorId: 1, status: 'Finishing', errorCode: 'NoError' });
        api.call('StopTransaction', { transactionId: payload.transactionId, meterStop: 0, timestamp: new Date().toISOString() });
        txnId = null;
      }
      if (action === 'RemoteStartTransaction') {
        api.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
        api.call('StartTransaction', { connectorId: 1, idTag: payload.idTag || 'x', meterStart: 0, timestamp: new Date().toISOString() });
      }
    }
  });

  const api = {
    ws,
    inbound,
    waitOpen: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    waitClose: () => new Promise((res) => ws.once('close', res)),
    call(action, payload) {
      const mid = 'cp-' + (nextId++);
      return new Promise((res) => { pending.set(mid, res); ws.send(JSON.stringify([2, mid, action, payload])); });
    },
    /** Amps from the most recent SetChargingProfile, or null if none sent. */
    lastAmps() {
      for (let i = inbound.length - 1; i >= 0; i--) {
        if (inbound[i].action === 'SetChargingProfile') {
          return inbound[i].payload?.csChargingProfiles?.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit ?? null;
        }
      }
      return null;
    },
    actions() { return inbound.map((c) => c.action); },
    clear() { inbound.length = 0; },
    async plugInAndCharge() {
      await api.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' });
      const r = await api.call('StartTransaction', { connectorId: 1, idTag: 'TEST', meterStart: 0, timestamp: new Date().toISOString() });
      txnId = r?.transactionId ?? null;
    },
    /** Report live draw so the controller's excess maths sees the EV load. */
    async reportPower(watts, amps) {
      await api.call('MeterValues', {
        connectorId: 1,
        meterValue: [{
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: String(watts), measurand: 'Power.Active.Import', unit: 'W' },
            { value: String(amps), measurand: 'Current.Import', unit: 'A' },
          ],
        }],
      });
    },
  };
  return api;
}

/** One logical controller tick (two loops - commands run every other tick). */
async function tick(n = 1) {
  for (let i = 0; i < n * 2; i++) {
    await controller._loop();
    await new Promise((r) => setTimeout(r, 15)); // let OCPP frames settle
  }
}

let cp;

test.before(async () => {
  ocppServer.start();
  cp = makeChargePoint('LOGIC-CP');
  await cp.waitOpen();
  await cp.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'LogicSim' });
});

test.after(() => {
  try { cp.ws.close(); } catch (_e) {}
  ocppServer.stop();
  controller.stop();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

// ── Solar tracking ───────────────────────────────────────────────────────────

test('starts charging when solar excess appears, at the matching amps', async () => {
  await cp.plugInAndCharge();
  cp.clear();

  // 8000W solar, 800W house -> 7200W excess -> 30A at 240V
  setSolar(8000, 800);
  await tick(3);

  assert.ok(cp.actions().includes('SetChargingProfile'), 'expected an amps command');
  assert.equal(cp.lastAmps(), 30, '7200W / 240V = 30A');
});

test('amps track solar downward', async () => {
  cp.clear();
  // 4400W solar, 800W house -> 3600W excess -> 15A
  setSolar(4400, 800);
  await tick(3);
  assert.equal(cp.lastAmps(), 15, '3600W / 240V = 15A');
});

test('amps track solar back upward, clamped to max_charge_amps', async () => {
  cp.clear();
  // 20000W excess would be 83A - must clamp to the configured 32A max
  setSolar(20800, 800);
  await tick(3);
  assert.equal(cp.lastAmps(), 32, 'must clamp to max_charge_amps');
});

test('existing EV draw is added back into the excess calculation', async () => {
  cp.clear();
  // The charger reports a live 4800W draw, which is already inside the 5600W
  // house consumption figure. Excess must add it back:
  //   6000 - 5600 + 4800 = 5200W -> 21A
  // Getting this wrong (treating the EV as house load) would give
  //   6000 - 5600 = 400W -> below minimum -> charging would stop dead.
  // Deliberately lands on an amps value distinct from the previous test's, since
  // the controller only re-sends SetChargingProfile when the target changes.
  await cp.reportPower(4800, 20);
  setSolar(6000, 5600);
  await tick(3);
  assert.equal(cp.lastAmps(), 21, '(6000 - 5600 + 4800) / 240 = 21A');
});

// ── Stopping ─────────────────────────────────────────────────────────────────

test('solar disappearing steps down to minimum, then stops after the hold timer', async () => {
  cp.clear();
  await cp.reportPower(0, 0);
  setSolar(0, 900); // night - no solar at all
  await tick(3);

  // Hold timer (3 min) must not have expired yet, so no stop command.
  assert.ok(!cp.actions().includes('RemoteStopTransaction'),
    'must not stop instantly - the hold timer exists to prevent short-cycling');

  // Force the hold timer to look expired, then tick again.
  controller.holdTimerStart = Date.now() - (4 * 60 * 1000);
  await tick(2);
  assert.ok(cp.actions().includes('RemoteStopTransaction'),
    'must stop once the hold period has elapsed with no solar');
});

// ── Manual + scheduled overrides ─────────────────────────────────────────────

test('CHARGE NOW forces full-rate charging regardless of solar', async () => {
  cp.clear();
  await cp.plugInAndCharge();
  setSolar(0, 900);                                  // no solar at all
  db.setSetting('manual_charge_enabled', 'true');    // CHARGE NOW
  try {
    await tick(3);
    assert.equal(cp.lastAmps(), 32,
      'CHARGE NOW must command max amps even with zero solar');
  } finally {
    db.setSetting('manual_charge_enabled', 'false');
  }
});

test('a scheduled charging window charges at full rate', async () => {
  cp.clear();
  await cp.plugInAndCharge();
  setSolar(0, 900);
  // A window covering all of today, every day.
  db.setSetting('schedule_enabled', 'true');
  db.setSetting('schedule_windows', JSON.stringify([
    { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
  ]));
  try {
    await tick(3);
    assert.equal(cp.lastAmps(), 32,
      'a scheduled window must command max amps regardless of solar');
  } finally {
    db.setSetting('schedule_enabled', 'false');
  }
});

test('the manual STOP command reaches the charger', async () => {
  cp.clear();
  await cp.plugInAndCharge();
  await controller.commandStop('user_stopped');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(cp.actions().includes('RemoteStopTransaction'),
    'pressing STOP must actually stop the charger');
});

// ── Resilience ───────────────────────────────────────────────────────────────

// ── The Tesla side of the command gate must be untouched ─────────────────────

test('_canSendCommands still requires a Tesla token on the Tesla backend', () => {
  const original = db.getSetting('charging_backend');
  try {
    db.setSetting('charging_backend', 'tesla');
    db.setSetting('tesla_command_backend', 'fleet');
    assert.equal(controller._canSendCommands(null), false,
      'Fleet mode with no token must still refuse to send commands');
    assert.equal(controller._canSendCommands(''), false,
      'an empty token must still refuse');
    assert.equal(controller._canSendCommands('a-real-token'), true,
      'Fleet mode with a token must still send');

    // BLE authenticates by paired key, so it never needed a token.
    db.setSetting('tesla_command_backend', 'ble');
    assert.equal(controller._canSendCommands(null), true,
      'BLE mode must still send without a token');

    // And OCPP, the case this fix added.
    db.setSetting('charging_backend', 'ocpp');
    db.setSetting('tesla_command_backend', 'fleet');
    assert.equal(controller._canSendCommands(null), true,
      'OCPP has no Tesla token concept and must not be gated on one');
  } finally {
    db.setSetting('charging_backend', original || 'ocpp');
    db.setSetting('tesla_command_backend', 'fleet');
  }
});

test('a charger disconnecting mid-charge does not crash the control loop', async () => {
  setSolar(8000, 800);
  cp.ws.close();
  await cp.waitClose();
  await new Promise((r) => setTimeout(r, 50));

  // Several ticks with no charge point connected must not throw.
  await tick(3);

  const st = require('../src/services/charging/ocpp/state').getState();
  assert.equal(st.isOnline, false, 'state must reflect the dropped connection');
});
