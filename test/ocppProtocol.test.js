/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Drives the real OCPP CSMS (services/charging/ocpp) against a real `ws`
// client acting as a charge point - full lifecycle over the actual protocol,
// not mocked-away message handling. Same "spin up a real protocol partner
// in-process" rigor as test/bleStatePolling.test.js (fake HTTP server + real
// client) and this session's mock-Modbus-server Sungrow tests.
//
// Runs against a throwaway DB and an ephemeral local port, never touching
// the real database or the real production OCPP port.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-ocpp-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const TEST_PORT = 20000 + (process.pid % 10000);
db.setSetting('ocpp_ws_port', String(TEST_PORT));

const server = require('../src/services/charging/ocpp/server');
const state = require('../src/services/charging/ocpp/state');
const ocpp = require('../src/services/charging/ocpp');
const controller = require('../src/controller');

test.after(() => {
  server.stop();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

/** A minimal fake charge point: a real ws client with helpers for OCPP-J framing. */
function makeFakeChargePoint(chargePointId) {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ocpp/${chargePointId}`, 'ocpp1.6');
  const pendingByOurId = new Map();
  const inboundCalls = [];
  let nextId = 1;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const [type] = msg;
    if (type === 3 || type === 4) {
      // CALLRESULT or CALLERROR replying to a CALL we sent.
      const [, id, ...rest] = msg;
      const p = pendingByOurId.get(id);
      if (p) { pendingByOurId.delete(id); p(type === 3 ? { ok: true, payload: rest[0] } : { ok: false, error: rest }); }
    } else if (type === 2) {
      // A CALL sent TO us by the CSMS (RemoteStartTransaction, RemoteStopTransaction, SetChargingProfile).
      inboundCalls.push({ id: msg[1], action: msg[2], payload: msg[3] });
    }
  });

  function waitOpen() {
    return new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
  }

  function waitClose() {
    return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  }

  function call(action, payload) {
    const id = String(nextId++);
    return new Promise((resolve) => {
      pendingByOurId.set(id, resolve);
      ws.send(JSON.stringify([2, id, action, payload]));
    });
  }

  async function waitForInboundCall(action, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = inboundCalls.findIndex((c) => c.action === action);
      if (idx !== -1) return inboundCalls.splice(idx, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for inbound ${action}`);
  }

  function replyTo(call_, payload) {
    ws.send(JSON.stringify([3, call_.id, payload]));
  }

  return { ws, waitOpen, waitClose, call, waitForInboundCall, replyTo };
}

test('full lifecycle: boot, status, authorize, start, meter values, stop', async () => {
  db.setSetting('ocpp_charge_point_id', '');
  server.start();
  const cp = makeFakeChargePoint('CP-1');
  await cp.waitOpen();

  const boot = await cp.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'Sim' });
  assert.equal(boot.ok, true);
  assert.equal(boot.payload.status, 'Accepted');
  assert.equal(typeof boot.payload.interval, 'number');

  const hb = await cp.call('Heartbeat', {});
  assert.equal(hb.ok, true);
  assert.equal(typeof hb.payload.currentTime, 'string');

  const statusPreparing = await cp.call('StatusNotification', { connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
  assert.equal(statusPreparing.ok, true);
  assert.equal((await ocpp.getVehicleData('CP-1', null)).chargeState.charging_state, 'Stopped');
  assert.equal(state.getChargeLimitAge(), Infinity, 'no-SoC OCPP backend must never claim a confirmed charge limit');

  const auth = await cp.call('Authorize', { idTag: 'ABC123' });
  assert.equal(auth.payload.idTagInfo.status, 'Accepted');

  const start = await cp.call('StartTransaction', { connectorId: 1, idTag: 'ABC123', meterStart: 1000, timestamp: new Date().toISOString() });
  assert.equal(start.ok, true);
  assert.equal(typeof start.payload.transactionId, 'number');
  const txnId = start.payload.transactionId;

  let d = await ocpp.getVehicleData('CP-1', null);
  assert.equal(d.chargeState.charging_state, 'Charging');
  assert.equal(d.chargeState.battery_level, 0, 'OCPP backend must never report a battery percentage it does not have');

  const mv = await cp.call('MeterValues', {
    connectorId: 1,
    meterValue: [{
      timestamp: new Date().toISOString(),
      sampledValue: [
        { value: '7400', measurand: 'Power.Active.Import', unit: 'W' },
        { value: '1500', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
        { value: '32', measurand: 'Current.Import', unit: 'A' },
      ],
    }],
  });
  assert.equal(mv.ok, true);

  d = await ocpp.getVehicleData('CP-1', null);
  assert.equal(d.chargeState.charger_power, 7.4);
  assert.equal(d.chargeState.charge_amps, 32);
  assert.equal(state.getState().energyDeliveredWh, 500, '1500 Wh meter reading minus 1000 Wh meterStart');

  const stop = await cp.call('StopTransaction', { transactionId: txnId, meterStop: 1500, timestamp: new Date().toISOString() });
  assert.equal(stop.ok, true);

  d = await ocpp.getVehicleData('CP-1', null);
  assert.equal(d.chargeState.charging_state, 'Stopped');
  assert.equal(state.getState().transactionId, null);

  cp.ws.close();
  await cp.waitClose();
});

test('outbound commands: SetChargingProfile, RemoteStartTransaction, RemoteStopTransaction', async () => {
  server.start();
  const cp = makeFakeChargePoint('CP-1');
  await cp.waitOpen();
  await cp.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'Sim' });

  const setAmpsPromise = ocpp.setChargingAmps('CP-1', 16, null);
  const setProfileCall = await cp.waitForInboundCall('SetChargingProfile');
  assert.equal(setProfileCall.payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].limit, 16);
  cp.replyTo(setProfileCall, { status: 'Accepted' });
  assert.deepEqual(await setAmpsPromise, { status: 'Accepted' });

  const startPromise = ocpp.startCharging('CP-1', null);
  const remoteStartCall = await cp.waitForInboundCall('RemoteStartTransaction');
  assert.equal(remoteStartCall.payload.connectorId, 1);
  assert.equal(typeof remoteStartCall.payload.idTag, 'string');
  cp.replyTo(remoteStartCall, { status: 'Accepted' });
  assert.deepEqual(await startPromise, { status: 'Accepted' });

  // Simulate the transaction actually starting, so stopCharging has a
  // transactionId to reference (mirrors the first test's real lifecycle).
  await cp.call('StartTransaction', { connectorId: 1, idTag: 'ABC123', meterStart: 0, timestamp: new Date().toISOString() });

  const stopPromise = ocpp.stopCharging('CP-1', null);
  const remoteStopCall = await cp.waitForInboundCall('RemoteStopTransaction');
  assert.equal(typeof remoteStopCall.payload.transactionId, 'number');
  cp.replyTo(remoteStopCall, { status: 'Accepted' });
  assert.deepEqual(await stopPromise, { status: 'Accepted' });

  cp.ws.close();
  await cp.waitClose();
});

test('stopCharging with no active transaction is a no-op success, not a command failure', async () => {
  server.start();
  const cp = makeFakeChargePoint('CP-1');
  await cp.waitOpen();
  await cp.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'Sim' });
  // No StartTransaction has happened - state.transactionId is null.
  await cp.call('StopTransaction', { transactionId: 999, meterStop: 0, timestamp: new Date().toISOString() });

  const result = await ocpp.stopCharging('CP-1', null);
  assert.deepEqual(result, { status: 'Accepted' });

  cp.ws.close();
  await cp.waitClose();
});

test('wakeVehicle and useBleCommands are safe no-ops for the OCPP backend', async () => {
  assert.deepEqual(await ocpp.wakeVehicle('CP-1', null), { ok: true });
  assert.equal(ocpp.useBleCommands(), false);
});

test('getVehicleDataBle / getBodyStateBle throw explicitly rather than return wrong data', async () => {
  await assert.rejects(() => ocpp.getVehicleDataBle('CP-1'), /not supported by the OCPP backend/);
  await assert.rejects(() => ocpp.getBodyStateBle('CP-1'), /not supported by the OCPP backend/);
});

test('getVehicleState reflects live connection state', async () => {
  server.start();
  const cp = makeFakeChargePoint('CP-1');
  await cp.waitOpen();
  assert.equal(await ocpp.getVehicleState('CP-1', null), 'online');

  cp.ws.close();
  await cp.waitClose();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await ocpp.getVehicleState('CP-1', null), 'offline');
});

test('a connection presenting the wrong charge point id is rejected when one is configured', async () => {
  db.setSetting('ocpp_charge_point_id', 'THE-REAL-ONE');
  server.start();
  const cp = makeFakeChargePoint('SOME-OTHER-ID');
  await cp.waitOpen();
  const code = await cp.waitClose();
  assert.equal(code, 1008);
  db.setSetting('ocpp_charge_point_id', '');
});

test('a malformed frame is logged and dropped without crashing the connection', async () => {
  server.start();
  const cp = makeFakeChargePoint('CP-1');
  await cp.waitOpen();
  cp.ws.send('not json at all {{{');
  cp.ws.send('[1, "not-a-valid-message-type"]');
  // The connection must still work after garbage input.
  const boot = await cp.call('BootNotification', { chargePointVendor: 'Test', chargePointModel: 'Sim' });
  assert.equal(boot.payload.status, 'Accepted');

  cp.ws.close();
  await cp.waitClose();
});

test('a second connection replaces the first rather than being rejected silently', async () => {
  server.start();
  const cp1 = makeFakeChargePoint('CP-1');
  await cp1.waitOpen();
  const cp1Closed = cp1.waitClose();

  const cp2 = makeFakeChargePoint('CP-1');
  await cp2.waitOpen();

  await cp1Closed;
  assert.equal(await ocpp.getVehicleState('CP-1', null), 'online', 'the new connection should still report online');

  cp2.ws.close();
  await cp2.waitClose();
});

test('OCPP backend is always "at home" regardless of GPS geofence settings', () => {
  // A real regression this test exists to catch: an OCPP charge point has no
  // GPS, so state.getState().latitude/longitude are always null. Before the
  // charging_backend check in _checkAtHome(), a leftover/irrelevant
  // last_car_latitude/longitude from a previous Tesla session (or none at
  // all) could evaluate against a configured home geofence and wrongly read
  // as "away", permanently suspending OCPP charging control.
  const originalBackend = db.getSetting('charging_backend');
  const originalLat = db.getSetting('home_latitude');
  const originalLon = db.getSetting('home_longitude');
  try {
    db.setSetting('charging_backend', 'ocpp');
    // A home geofence configured, and a stale/irrelevant coordinate nowhere
    // near it - exactly the scenario that produced a false "away" reading.
    db.setSetting('home_latitude', '-27.4698');
    db.setSetting('home_longitude', '153.0251');
    controller._lastLatLng = { lat: 51.5074, lon: -0.1278 }; // London - nowhere near the geofence above
    assert.equal(controller._checkAtHome(), true, 'OCPP backend must never report "away" - it has no GPS concept');
  } finally {
    db.setSetting('charging_backend', originalBackend || 'tesla');
    db.setSetting('home_latitude', originalLat || '');
    db.setSetting('home_longitude', originalLon || '');
    controller._lastLatLng = null;
  }
});

test('Tesla backend geofencing is unchanged by the OCPP check', () => {
  const originalBackend = db.getSetting('charging_backend');
  const originalLat = db.getSetting('home_latitude');
  const originalLon = db.getSetting('home_longitude');
  try {
    db.setSetting('charging_backend', 'tesla');
    db.setSetting('home_latitude', '-27.4698');
    db.setSetting('home_longitude', '153.0251');
    controller._lastLatLng = { lat: 51.5074, lon: -0.1278 }; // London - genuinely far away
    assert.equal(controller._checkAtHome(), false, 'Tesla backend must still geofence normally');
    controller._lastLatLng = { lat: -27.4699, lon: 153.0252 }; // a few metres from home
    assert.equal(controller._checkAtHome(), true, 'Tesla backend must still recognise being at home');
  } finally {
    db.setSetting('charging_backend', originalBackend || 'tesla');
    db.setSetting('home_latitude', originalLat || '');
    db.setSetting('home_longitude', originalLon || '');
    controller._lastLatLng = null;
  }
});
