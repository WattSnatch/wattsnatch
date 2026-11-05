/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Home Assistant's Charge Mode select: Solar, Charge Now or Stop, the dashboard's three buttons.
//
// Pinned here: it is opt-in, and switched off its entity is removed and commands are ignored; a
// retained command is never acted on, since it would be replayed on every reconnect; each choice
// runs the same controller command as the dashboard; choosing the mode already in force does
// nothing, because AUTO would interrupt a running solar charge; the select shows the mode
// actually in force, published when it changes. Runs against a throwaway DB with a fake broker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-test-chargemode-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();
const mqttPublisher = require('../src/services/mqttPublisher');
const controller = require('../src/controller');

let published;
const fakeClient = { publish: (topic, msg, opts) => published.push({ topic, msg, opts }) };
const orig = {};

test.before(() => {
  // No car to talk to: STOP still changes state, it just has no charge to stop.
  orig.canSend = controller._canSendCommands;
  controller._canSendCommands = () => false;
});

test.beforeEach(() => {
  published = [];
  mqttPublisher._setClientForTests(fakeClient);
  db.setSetting('mqtt_ha_charge_mode_enabled', 'true');
  db.setSetting('manual_charge_enabled', 'false');
  controller.state = 'IDLE';
});

test.after(() => {
  controller._canSendCommands = orig.canSend;
  mqttPublisher._setClientForTests(null);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + s, { force: true });
});

const send = (mode, packet = { retain: false }) =>
  mqttPublisher._onMessage(mqttPublisher.CHARGE_MODE_COMMAND_TOPIC, Buffer.from(mode), packet);
const lastState = () => [...published].reverse().find((p) => p.topic === mqttPublisher.CHARGE_MODE_STATE_TOPIC);

// ── Commands ────────────────────────────────────────────────────────────────────────────────

test('Charge Now, Stop and Solar run the dashboard\'s commands', async () => {
  await send('Charge Now');
  assert.equal(controller.state, 'OVERRIDE');
  assert.equal(db.getSetting('manual_charge_enabled'), 'true');
  assert.equal(lastState().msg, 'Charge Now');

  await send('Stop');
  assert.equal(controller.state, 'STOPPED');
  assert.equal(db.getSetting('manual_charge_enabled'), 'false');
  assert.equal(lastState().msg, 'Stop');

  await send('Solar');
  assert.equal(controller.state, 'IDLE');
  assert.equal(lastState().msg, 'Solar');
  assert.ok(published.filter((p) => p.topic === mqttPublisher.CHARGE_MODE_STATE_TOPIC).every((p) => p.opts.retain));
});

test('choosing Solar while a solar charge runs does not interrupt it', async () => {
  controller.state = 'CHARGING';
  await send('Solar');
  assert.equal(controller.state, 'CHARGING');
  assert.equal(lastState().msg, 'Solar', 'HA is still told the mode, so the select settles');
});

test('a retained command is ignored', async () => {
  await send('Charge Now', { retain: true });
  assert.equal(controller.state, 'IDLE');
  assert.equal(db.getSetting('manual_charge_enabled'), 'false');
});

test('with the setting off, commands are ignored', async () => {
  db.setSetting('mqtt_ha_charge_mode_enabled', 'false');
  await send('Charge Now');
  assert.equal(controller.state, 'IDLE');
});

test('an unknown mode is ignored and reported', async () => {
  await send('Turbo');
  assert.equal(controller.state, 'IDLE');
  assert.match(mqttPublisher.getState().commandError, /Unknown charge mode "Turbo"/);
  await send('Stop');
  assert.equal(mqttPublisher.getState().commandError, null);
});

test('other topics are not commands', async () => {
  await mqttPublisher._onMessage('wattsnatch/car/charge_mode', Buffer.from('Charge Now'), { retain: false });
  assert.equal(controller.state, 'IDLE');
});

// ── What the select shows ───────────────────────────────────────────────────────────────────

test('the mode shown is the one in force, with automatic charging under Solar', () => {
  for (const [state, manual, mode] of [
    ['IDLE', 'false', 'Solar'], ['CHARGING', 'false', 'Solar'], ['DEPARTURE', 'false', 'Solar'],
    ['SCHEDULED', 'false', 'Solar'], ['STOPPED', 'false', 'Stop'], ['OVERRIDE', 'false', 'Charge Now'],
    ['IDLE', 'true', 'Charge Now'],   // Charge Now survives a restart through the setting
  ]) {
    controller.state = state;
    db.setSetting('manual_charge_enabled', manual);
    assert.equal(controller.chargeMode(), mode, `${state} / manual ${manual}`);
  }
});

test('published once per change, not every tick', () => {
  mqttPublisher.publishChargeMode('Solar');
  mqttPublisher.publishChargeMode('Solar');
  mqttPublisher.publishChargeMode('Solar');
  mqttPublisher.publishChargeMode('Stop');
  assert.deepEqual(published.map((p) => p.msg), ['Solar', 'Stop']);
});

test('the controller publishes the mode every tick', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  assert.match(src, /mqttPublisher\.publishCar\(telemetry\.getState\(\), this\._isAtHome\);\s*mqttPublisher\.publishChargeMode\(this\.chargeMode\(\)\);/);
  assert.match(src, /mqttPublisher\.setChargeModeHandler\(\(mode\) => this\.setChargeModeFromHomeAssistant\(mode\)\)/);
});

// ── Discovery ───────────────────────────────────────────────────────────────────────────────

const discovery = () => {
  published = [];
  mqttPublisher._publishDiscovery();
  return published.find((p) => p.topic === mqttPublisher.CHARGE_MODE_DISCOVERY_TOPIC);
};

test('on: a select with the three options on the car device', () => {
  const d = discovery();
  assert.ok(d.opts.retain);
  const c = JSON.parse(d.msg);
  assert.deepEqual(c.options, ['Solar', 'Charge Now', 'Stop']);
  assert.equal(c.command_topic, 'wattsnatch/car/charge_mode/set');
  assert.equal(c.state_topic, 'wattsnatch/car/charge_mode');
  assert.deepEqual(c.device.identifiers, ['wattsnatch_car']);
});

test('off: an empty retained config, which removes the entity from HA', () => {
  db.setSetting('mqtt_ha_charge_mode_enabled', 'false');
  const d = discovery();
  assert.equal(d.msg, '');
  assert.ok(d.opts.retain);
});

test('changing the setting reconnects the publisher, and Settings saves it', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');
  assert.match(api, /'mqtt_ha_charge_mode_enabled',/);
  assert.match(api, /\|\| key === 'mqtt_ha_charge_mode_enabled'\) mqttOutChanged = true;/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
  assert.match(js, /saveToggleNow\('mqtt_ha_charge_mode_enabled'/);
});
