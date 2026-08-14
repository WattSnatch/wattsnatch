/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// test/ocppProtocol.test.js proves the protocol works against fixtures I wrote
// myself - which can't catch a bug where my understanding of the OCPP-J spec
// is wrong on BOTH the client fixture and the server, since the same author
// wrote both. This file closes that gap: it drives the real CSMS
// (services/charging/ocpp) with `ocpp-rpc` (github.com/mikuso/ocpp-rpc), an
// independently-written, actively maintained OCPP-J client/server library,
// with strictMode enabled - every call and response is validated against the
// *official* OCPP 1.6 JSON schemas the library bundles, not just "did the
// round trip work". A schema violation on either side fails loudly here even
// if the hand-rolled fixtures in ocppProtocol.test.js would have missed it.
//
// Runs against a throwaway DB and an ephemeral local port, never touching the
// real database or the real production OCPP port. `ocpp-rpc` is a
// devDependency only - never loaded by the production server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RPCClient } = require('ocpp-rpc');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-ocpp-indep-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const TEST_PORT = 21000 + (process.pid % 4000);
db.setSetting('ocpp_ws_port', String(TEST_PORT));
db.setSetting('ocpp_charge_point_id', '');

const server = require('../src/services/charging/ocpp/server');
const state = require('../src/services/charging/ocpp/state');
const ocpp = require('../src/services/charging/ocpp');

test.after(() => {
  server.stop();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

function makeClient(identity) {
  const strictFailures = [];
  const cli = new RPCClient({
    endpoint: `ws://127.0.0.1:${TEST_PORT}/ocpp`,
    identity,
    protocols: ['ocpp1.6'],
    strictMode: ['ocpp1.6'], // validates every call/response against the official OCPP 1.6 schema
    reconnect: false,
  });
  cli.on('strictValidationFailure', (event) => strictFailures.push(event));
  return { cli, strictFailures };
}

test('full lifecycle, schema-validated by an independent OCPP-J client library', async () => {
  server.start();
  const { cli, strictFailures } = makeClient('INDEP-CP-1');

  // Inbound-to-client handlers, for the CSMS -> charge point direction.
  cli.handle('RemoteStartTransaction', ({ params }) => {
    cli.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' }).catch(() => {});
    cli.call('StartTransaction', { connectorId: 1, idTag: params.idTag, meterStart: 0, timestamp: new Date().toISOString() }).catch(() => {});
    return { status: 'Accepted' };
  });
  cli.handle('RemoteStopTransaction', () => ({ status: 'Accepted' }));
  cli.handle('SetChargingProfile', () => ({ status: 'Accepted' }));

  await cli.connect();

  const boot = await cli.call('BootNotification', { chargePointVendor: 'ocpp-rpc', chargePointModel: 'independent-test' });
  assert.equal(boot.status, 'Accepted');
  assert.equal(typeof boot.currentTime, 'string');
  assert.equal(typeof boot.interval, 'number');

  const hb = await cli.call('Heartbeat', {});
  assert.equal(typeof hb.currentTime, 'string');

  await cli.call('StatusNotification', { connectorId: 1, status: 'Preparing', errorCode: 'NoError' });
  assert.equal((await ocpp.getVehicleData('INDEP-CP-1', null)).chargeState.charging_state, 'Stopped');
  assert.equal(state.getChargeLimitAge(), Infinity, 'no-SoC OCPP backend must never claim a confirmed charge limit');

  const auth = await cli.call('Authorize', { idTag: 'ABC123' });
  assert.equal(auth.idTagInfo.status, 'Accepted');

  const start = await cli.call('StartTransaction', { connectorId: 1, idTag: 'ABC123', meterStart: 1000, timestamp: new Date().toISOString() });
  assert.equal(typeof start.transactionId, 'number');
  const txnId = start.transactionId;

  let d = await ocpp.getVehicleData('INDEP-CP-1', null);
  assert.equal(d.chargeState.charging_state, 'Charging');
  assert.equal(d.chargeState.battery_level, 0, 'OCPP backend must never report a battery percentage it does not have');

  await cli.call('MeterValues', {
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

  d = await ocpp.getVehicleData('INDEP-CP-1', null);
  assert.equal(d.chargeState.charger_power, 7.4);
  assert.equal(d.chargeState.charge_amps, 32);

  // Outbound: WattSnatch drives amps, then start/stop, via the independent client's own handlers above.
  const setAmpsResult = await ocpp.setChargingAmps('INDEP-CP-1', 16, null);
  assert.equal(setAmpsResult.status, 'Accepted');

  await cli.call('StopTransaction', { transactionId: txnId, meterStop: 1500, timestamp: new Date().toISOString() });
  d = await ocpp.getVehicleData('INDEP-CP-1', null);
  assert.equal(d.chargeState.charging_state, 'Stopped');

  const startResult = await ocpp.startCharging('INDEP-CP-1', null);
  assert.equal(startResult.status, 'Accepted');
  // The independent client's own RemoteStartTransaction handler (above) issues
  // a real StartTransaction back, so the CSMS has a transactionId to stop.
  await new Promise((r) => setTimeout(r, 100));
  const stopResult = await ocpp.stopCharging('INDEP-CP-1', null);
  assert.equal(stopResult.status, 'Accepted');

  assert.deepEqual(strictFailures, [], 'the independent client flagged an OCPP 1.6 schema violation - see strictFailures for details');

  await cli.close();
});
