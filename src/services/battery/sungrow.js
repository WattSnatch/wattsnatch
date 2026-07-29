/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Sungrow SH-series hybrid inverter adapter - local Modbus TCP via the
// WiNet-S dongle (WiFi or LAN).
//
// Register addresses and the EMS-mode control sequence below are taken from
// evcc-io/evcc's templates/definition/meter/sungrow-hybrid.yaml (MIT licensed,
// see THIRD_PARTY_LICENSES.md) - NOT verified against real Sungrow hardware,
// same "best-effort" status as the SPAN Panel provider. Please open an issue
// if your inverter reports something different.
//
// EVCC's own docs note older WiNet-S firmware doesn't expose all needed
// registers - if readings look wrong, the dongle firmware is the first
// thing to check.

const ModbusRTU = require('modbus-serial');
const db = require('../../db');

const REG = {
  BATTERY_RUNNING_STATE: 13000, // input, uint16
  BATTERY_CURRENT:       13020, // input, int16
  BATTERY_POWER:         13021, // input, int16
  BATTERY_SOC:           13022, // input, int16, scale 0.1
  BATTERY_CAPACITY:      5638,  // input, uint16, scale 0.01 -> kWh
  EMS_MODE:              13049, // holding, uint16, writesingle
  CHARGE_DISCHARGE_CMD:  13050, // holding, uint16, writesingle
  MAX_CHARGE_POWER:      13051, // holding, uint16, writesingle, W
  MAX_DISCHARGE_POWER:   33047, // holding, uint16, writesingle, raw*10 = W
};

const EMS_MODE_SELF_CONSUMPTION = 0;
const EMS_MODE_FORCED           = 2;
const CMD_STOP   = 0xCC;
const CMD_CHARGE = 0xAA;

function _toInt16(u16) {
  return u16 > 32767 ? u16 - 65536 : u16;
}

function isConfigured() {
  return !!db.getSetting('sungrow_host');
}

async function _connect() {
  const host = db.getSetting('sungrow_host');
  const port = parseInt(db.getSetting('sungrow_port') || '502', 10);
  const id   = parseInt(db.getSetting('sungrow_unit_id') || '1', 10);
  if (!host) throw new Error('Sungrow host/IP not configured');

  const client = new ModbusRTU();
  client.setTimeout(5000);
  await client.connectTCP(host, { port });
  client.setID(id);
  return client;
}

async function fetchReadings() {
  const client = await _connect();
  try {
    const [state, current, power, soc] = await Promise.all([
      client.readInputRegisters(REG.BATTERY_RUNNING_STATE, 1),
      client.readInputRegisters(REG.BATTERY_CURRENT, 1),
      client.readInputRegisters(REG.BATTERY_POWER, 1),
      client.readInputRegisters(REG.BATTERY_SOC, 1),
    ]);

    const runningState  = state.data[0];
    const batteryCurrent = _toInt16(current.data[0]);
    const batteryPowerRaw = _toInt16(power.data[0]);
    const socPct = _toInt16(soc.data[0]) * 0.1;

    // Some Sungrow firmware reports battery power as an unsigned magnitude
    // and relies on the running-state flag (bit 0x2) or current sign to
    // tell you the direction - replicated verbatim from EVCC's handling of
    // both old and new firmware. Our contract: + = charging, - = discharging.
    let powerW = batteryPowerRaw;
    if ((runningState & 0x2) !== 0 || batteryCurrent < 0) {
      if (batteryPowerRaw >= 0) powerW = -batteryPowerRaw;
    }

    let capacityWh = null;
    try {
      const cap = await client.readInputRegisters(REG.BATTERY_CAPACITY, 1);
      capacityWh = Math.round(cap.data[0] * 0.01 * 1000);
    } catch (_e) {
      // Not all firmware/dongle versions expose this - non-fatal, capacity is cosmetic.
    }

    return { socPct, powerW, capacityWh, timestamp: Date.now() };
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

// setMode('normal' | 'hold_for_ev'):
//   normal      - restore default self-consumption behavior (EMS mode 0), the
//                 same state the inverter is in if WattSnatch never touches it.
//   hold_for_ev - force the battery to stop charging (EMS forced mode + stop
//                 command + max charge power capped near zero), so solar
//                 excess that would have gone into the battery flows to the
//                 house/EV instead. This deliberately differs from EVCC's own
//                 "hold" case (which only limits *discharge* power, for a
//                 different purpose) - ours targets *charge* power, since
//                 that's what "prioritize the EV over the battery" requires.
//
// Refuses to enter hold_for_ev unless sungrow_max_charge_power_w and
// sungrow_max_discharge_power_w are both configured, since those are needed
// to safely restore normal operation afterwards - better to not engage the
// override at all than to leave the battery stuck with no known-good values
// to restore to.
async function setMode(mode) {
  const maxCharge    = parseInt(db.getSetting('sungrow_max_charge_power_w') || '', 10);
  const maxDischarge = parseInt(db.getSetting('sungrow_max_discharge_power_w') || '', 10);

  if (mode === 'hold_for_ev') {
    if (!maxCharge || !maxDischarge) {
      throw new Error('sungrow_max_charge_power_w and sungrow_max_discharge_power_w must be configured before ev_first priority can control this battery');
    }
    const client = await _connect();
    try {
      await client.writeRegister(REG.EMS_MODE, EMS_MODE_FORCED);
      await client.writeRegister(REG.CHARGE_DISCHARGE_CMD, CMD_STOP);
      await client.writeRegister(REG.MAX_CHARGE_POWER, 0);
    } finally {
      client.close(() => {});
    }
    return;
  }

  if (mode === 'normal') {
    const client = await _connect();
    try {
      await client.writeRegister(REG.EMS_MODE, EMS_MODE_SELF_CONSUMPTION);
      await client.writeRegister(REG.CHARGE_DISCHARGE_CMD, CMD_STOP);
      if (maxCharge)    await client.writeRegister(REG.MAX_CHARGE_POWER, maxCharge);
      if (maxDischarge) await client.writeRegister(REG.MAX_DISCHARGE_POWER, Math.round(maxDischarge / 10));
    } finally {
      client.close(() => {});
    }
    return;
  }

  throw new Error(`Unknown battery mode: ${mode}`);
}

module.exports = {
  id: 'sungrow',
  label: 'Sungrow SH Series Hybrid',
  authType: 'local-modbus',
  capabilities: ['read', 'control'],
  isConfigured,
  fetchReadings,
  testConnection,
  setMode,
};
