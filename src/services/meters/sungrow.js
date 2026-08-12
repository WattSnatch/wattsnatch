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

// ── Register maps, per inverter family ───────────────────────────────────────
//
// Sungrow ships two very different product lines and they do NOT share a
// register map:
//
//   SH-series  hybrid (battery-capable). Energy-management data lives in a
//              13xxx block. This is what the adapter originally supported.
//   SG-series  string inverter (no battery). The 13xxx block does not exist at
//              all - reading it returns "Illegal data address" - and the meter
//              data lives in the 5xxx block instead.
//
// Selected by the `sungrow_inverter_family` setting, defaulting to 'sh' so
// existing installs behave exactly as before.
//
// ── Addressing ──────────────────────────────────────────────────────────────
// Sungrow's protocol documents register NUMBERS, which are 1-based. modbus-serial
// takes a 0-based ADDRESS. Every constant below is therefore the documented
// number MINUS ONE. Confirmed empirically: "Total DC power" is documented at
// 5017 and reads correctly here at 5016 on real hardware.

const REG_SG = {
  // Total DC (PV) power - doc 5017. Same address as SH; confirmed working on a
  // real SG-series unit (read 300W, matched iSolarCloud).
  TOTAL_PV_POWER: 5016,
  // Meter power - doc 5083. int32, word-swapped, watts. This is the external
  // meter (DTSU-style) that reports whole-premises grid flow.
  METER_POWER:    5082,
  // Per-phase meter power - doc 5085/5087/5089. Not used for control; read only
  // by the diagnostic to sanity-check that the phases sum to the total.
  METER_PHASE_A:  5084,
  METER_PHASE_B:  5086,
  METER_PHASE_C:  5088,
  // Deliberately no lifetime-energy register. The SG energy registers were not
  // verified against hardware, and guessing one would produce a wrong daily
  // total rather than no total - the controller's own midnight-baseline
  // fallback handles a null here correctly.
};

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

/** 'sg' for string inverters, 'sh' (default) for hybrids. */
function inverterFamily() {
  return db.getSetting('sungrow_inverter_family') === 'sg' ? 'sg' : 'sh';
}

/**
 * Whether the SG meter register reads positive while IMPORTING.
 *
 * Unlike the SH-series register - documented as "Export power", so positive
 * means exporting and the value is negated below - the SG-series register is
 * documented only as "Meter power", and the sign convention for it has not been
 * verified against hardware. DTSU-style meters commonly read positive while
 * importing, which is the default here, but getting this backwards would invert
 * every charging decision (WattSnatch would think it is importing while
 * exporting and refuse to charge, or the reverse).
 *
 * So it is a setting rather than an assumption, and it is trivially verifiable:
 * run `scripts/diag-sungrow.js --watch`, switch a large load on, and see which
 * way the number moves. More positive under load means positive = importing.
 */
function sgMeterPositiveIsImport() {
  return db.getSetting('sungrow_sg_meter_sign') !== 'export';
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

/**
 * SG-series (string inverter) read path.
 *
 * Kept as its own function rather than branching inside the SH path, so the
 * SH-series behaviour that existing installs depend on is not touched at all.
 *
 * No battery handling: an SG unit has none, so consumption is simply
 * generation plus whatever the grid is supplying.
 */
async function _fetchReadingsSg(client) {
  const [pv, meter] = await Promise.all([
    client.readInputRegisters(REG_SG.TOTAL_PV_POWER, 2),
    client.readInputRegisters(REG_SG.METER_POWER, 2),
  ]);
  if (!pv.data || pv.data.length < 2) throw new Error('Sungrow SG: Total PV Power register returned an unexpected response shape');
  if (!meter.data || meter.data.length < 2) throw new Error('Sungrow SG: Meter Power register returned an unexpected response shape');

  const solarW = Math.max(0, _combineWordSwapped32(pv.data));
  const rawMeterW = _toInt32(_combineWordSwapped32(meter.data));

  // WattSnatch's convention throughout is: gridW positive = importing.
  const gridW = sgMeterPositiveIsImport() ? rawMeterW : -rawMeterW;

  // Same plausibility bound as the SH path - catches a wrong word order or a
  // garbled response rather than acting on it as if it were real.
  const PLAUSIBLE_MAX_W = 1_000_000;
  if (solarW > PLAUSIBLE_MAX_W || Math.abs(gridW) > PLAUSIBLE_MAX_W) {
    throw new Error(`Sungrow SG meter reading out of plausible range (solar=${solarW}W, grid=${gridW}W) - likely a Modbus decode error, not real data`);
  }

  // No battery on an SG unit, so nothing to net out.
  const consumptionW = Math.max(0, solarW + gridW);

  return {
    solarW,
    consumptionW,
    gridW,
    // Deliberately null - see REG_SG. The controller's midnight-baseline
    // fallback derives today's total from telemetry instead.
    solarActEnergyDlvdWh: null,
    timestamp: Date.now(),
  };
}

async function fetchReadings() {
  const client = await _connect();
  if (inverterFamily() === 'sg') {
    try {
      return await _fetchReadingsSg(client);
    } finally {
      client.close(() => {});
    }
  }
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
  // No longer names one product line: the adapter now covers both the SH-series
  // hybrids it was written for and SG-series string inverters. The old label
  // actively told SG owners the option was not for them.
  label: 'Sungrow (SH hybrid or SG string)',
  authType: 'local-modbus',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
};
