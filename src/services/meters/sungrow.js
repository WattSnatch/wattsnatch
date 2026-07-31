/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Sungrow SH-series hybrid inverter - solar/grid meter adapter, local Modbus TCP
// via the WiNet-S dongle. Deliberately reuses the exact same sungrow_host/
// sungrow_port/sungrow_unit_id settings as the battery integration
// (src/services/battery/sungrow.js) - it's the same physical connection to the
// same device, so a user who has already configured Sungrow as their battery
// doesn't need to enter the connection details a second time to also use it
// as their meter.
//
// Register addresses, decode types and scale factors are taken from
// evcc-io/evcc's templates/definition/meter/sungrow-hybrid.yaml (MIT licensed,
// see THIRD_PARTY_LICENSES.md) - NOT verified against real Sungrow hardware,
// same "best-effort" status as every other Sungrow/Sigenergy/SPAN provider in
// this project. Please open an issue if your inverter reports something
// different.
//
// EVCC's own docs note older WiNet-S firmware doesn't expose all needed
// registers - if readings fail or look wrong, dongle firmware is the first
// thing to check (same caveat already noted in battery/sungrow.js).

const ModbusRTU = require('modbus-serial');
const db = require('../../db');

const REG = {
  // Total DC (PV) power. input, uint32, word-swapped, raw W, no scale factor.
  TOTAL_PV_POWER:  5016,
  // Total lifetime PV generation. input, uint32, word-swapped, scale 0.1 kWh.
  // Optional - used only for the lifetime accumulator field, never required.
  TOTAL_PV_ENERGY: 13002,
  // "Export power": positive while exporting in Sungrow's own convention.
  // input, int32, word-swapped, raw W. evcc negates this (scale: -1) to match
  // their own "+ = importing" grid convention, which is also WattSnatch's -
  // same negation applied below.
  EXPORT_POWER:    13009,
  // Battery registers - identical addresses/types to battery/sungrow.js,
  // duplicated here (not imported) so this file has no dependency on whether
  // the battery feature is also configured; read purely to net the battery's
  // own charge/discharge power out of the consumption calculation below.
  BATTERY_RUNNING_STATE: 13000, // input, uint16
  BATTERY_CURRENT:       13020, // input, int16
  BATTERY_POWER:         13021, // input, int16
};

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

function _toInt16(u16) {
  return u16 > 32767 ? u16 - 65536 : u16;
}

// Combines two consecutive 16-bit Modbus registers into an unsigned 32-bit
// value using Sungrow's *word-swapped* order (evcc's "uint32s"/"int32s" decode
// type: the LOW 16 bits arrive first, the HIGH 16 bits second - the opposite
// of standard big-endian 32-bit Modbus, which would be high-word-first).
// Getting this backwards silently produces a wildly wrong reading for any
// value over 65,535 - but for typical residential PV/export power the two
// interpretations happen to coincide whenever the true value fits in 16 bits
// (the high word is 0 either way), which is why a word-order bug here could
// easily go unnoticed on a small residential system and only surface on a
// larger one. Implemented per the documented spec regardless: larger SH-series
// models (25-30kW+) do exceed 16 bits.
function _combineWordSwapped32(data) {
  if (!data || data.length < 2) throw new Error('Expected 2 Modbus registers for a 32-bit value, got fewer');
  return ((data[1] << 16) | (data[0] & 0xFFFF)) >>> 0;
}
function _toInt32(u32) {
  return u32 > 0x7FFFFFFF ? u32 - 0x100000000 : u32;
}

async function fetchReadings() {
  const client = await _connect();
  try {
    const [pv, exportReg] = await Promise.all([
      client.readInputRegisters(REG.TOTAL_PV_POWER, 2),
      client.readInputRegisters(REG.EXPORT_POWER, 2),
    ]);
    if (!pv.data || pv.data.length < 2) throw new Error('Sungrow Total PV Power register returned an unexpected response shape');
    if (!exportReg.data || exportReg.data.length < 2) throw new Error('Sungrow Export Power register returned an unexpected response shape');

    const solarW = Math.max(0, _combineWordSwapped32(pv.data));

    const rawExportW = _toInt32(_combineWordSwapped32(exportReg.data));
    const gridW = -rawExportW; // Sungrow: + while exporting -> WattSnatch: + while importing

    // Sanity bound: reject (rather than silently act on) a reading no real
    // residential/commercial SH-series system could produce. This catches a
    // wrong word-order or a garbled response without needing real hardware to
    // discover the bug - 1MW is far beyond any SH-series model's rated output.
    const PLAUSIBLE_MAX_W = 1_000_000;
    if (solarW > PLAUSIBLE_MAX_W || Math.abs(gridW) > PLAUSIBLE_MAX_W) {
      throw new Error(`Sungrow meter reading out of plausible range (solar=${solarW}W, grid=${gridW}W) - likely a Modbus decode error, not real data`);
    }

    // Net the battery's own charge/discharge power out of consumption, so a
    // hybrid inverter's attached battery isn't miscounted as house load:
    // charging looks like extra consumption, discharging looks like negative
    // consumption, unless subtracted here. Read defensively - an SH unit with
    // no battery physically installed, or firmware that doesn't expose these
    // registers, must not break the whole meter reading over it (mirrors the
    // same graceful fallback battery/sungrow.js already uses for its optional
    // capacity register).
    let batteryPowerW = 0;
    try {
      const [state, current, power] = await Promise.all([
        client.readInputRegisters(REG.BATTERY_RUNNING_STATE, 1),
        client.readInputRegisters(REG.BATTERY_CURRENT, 1),
        client.readInputRegisters(REG.BATTERY_POWER, 1),
      ]);
      const runningState    = state.data[0];
      const batteryCurrent  = _toInt16(current.data[0]);
      let raw               = _toInt16(power.data[0]);
      // Same firmware quirk as battery/sungrow.js: some firmware reports
      // battery power as an unsigned magnitude, direction inferred from the
      // running-state flag or current sign.
      if ((runningState & 0x2) !== 0 || batteryCurrent < 0) {
        if (raw >= 0) raw = -raw;
      }
      batteryPowerW = raw; // + = charging, - = discharging
    } catch (_e) {
      // No battery on this unit, or registers unavailable on this firmware -
      // 0 is the correct value to net out in that case, not an error.
    }

    // consumption = solar generation + grid import - battery charge (+ discharge)
    const consumptionW = Math.max(0, solarW + gridW - batteryPowerW);

    // Lifetime PV generation accumulator, for accurate daily totals the same
    // way Enphase's provider supplies one - optional, never blocks the read.
    let solarActEnergyDlvdWh = null;
    try {
      const energyReg = await client.readInputRegisters(REG.TOTAL_PV_ENERGY, 2);
      if (energyReg.data && energyReg.data.length >= 2) {
        const raw = _combineWordSwapped32(energyReg.data); // unsigned, 0.1 kWh per unit
        solarActEnergyDlvdWh = raw * 100; // 0.1kWh -> Wh
      }
    } catch (_e) {
      // Not all firmware/dongle versions expose this - non-fatal, the
      // controller's own midnight-baseline fallback covers a null here.
    }

    return { solarW, consumptionW, gridW, solarActEnergyDlvdWh, timestamp: Date.now() };
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

function handleFetchError(_err) {
  return false; // local Modbus, no auth/token to refresh
}

module.exports = {
  id: 'sungrow',
  label: 'Sungrow (SH Series Hybrid)',
  authType: 'local-modbus',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
};
