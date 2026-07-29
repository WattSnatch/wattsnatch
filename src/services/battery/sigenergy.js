/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Sigenergy (Sigen Hybrid / PV Max / SigenStore EC) adapter - local Modbus
// TCP. Requires Modbus TCP to be enabled in the configuration app with
// installer rights - it is NOT available in the mySigen customer app.
//
// Register addresses taken from evcc-io/evcc's
// templates/definition/meter/sigenergy.yaml (MIT licensed, see
// THIRD_PARTY_LICENSES.md) - NOT verified against real Sigenergy hardware,
// same "best-effort" status as the SPAN Panel provider.
//
// Read-only by design: EVCC's Sigenergy template exposes only one write
// register (a discharge cut-off SoC floor, reg 40048) - nothing that lets
// WattSnatch cap or pause charge power the way Sungrow's EMS-mode registers
// do. So `ev_first` priority has no effect on Sigenergy batteries; selecting
// it is accepted in Settings but surfaced there as unsupported for this brand.

const ModbusRTU = require('modbus-serial');
const db = require('../../db');

const REG = {
  BATTERY_POWER: 30599, // holding, int32, scale -1 (per-inverter charge/discharge power)
  BATTERY_SOC:   30601, // holding, uint16, scale 0.1
};

function isConfigured() {
  return !!db.getSetting('sigenergy_host');
}

async function _connect() {
  const host = db.getSetting('sigenergy_host');
  const port = parseInt(db.getSetting('sigenergy_port') || '502', 10);
  const id   = parseInt(db.getSetting('sigenergy_unit_id') || '1', 10);
  if (!host) throw new Error('Sigenergy host/IP not configured');

  const client = new ModbusRTU();
  client.setTimeout(5000);
  await client.connectTCP(host, { port });
  client.setID(id);
  return client;
}

async function fetchReadings() {
  const client = await _connect();
  try {
    const [powerRegs, socReg] = await Promise.all([
      client.readHoldingRegisters(REG.BATTERY_POWER, 2),
      client.readHoldingRegisters(REG.BATTERY_SOC, 1),
    ]);

    // int32, big-endian register pair, per EVCC's default modbus decode order.
    const raw32 = (powerRegs.data[0] << 16) | powerRegs.data[1];
    // EVCC applies scale: -1 to this register to reach its own convention;
    // our contract (+ = charging) matches that scaled value directly.
    const powerW = -raw32;
    const socPct = socReg.data[0] * 0.1;

    return { socPct, powerW, capacityWh: null, timestamp: Date.now() };
  } finally {
    client.close(() => {});
  }
}

async function testConnection() {
  try {
    const readings = await fetchReadings();
    return { ok: true, readings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  id: 'sigenergy',
  label: 'Sigenergy (Sigen Hybrid / PV Max / SigenStore)',
  authType: 'local-modbus',
  capabilities: ['read'],
  isConfigured,
  fetchReadings,
  testConnection,
};
