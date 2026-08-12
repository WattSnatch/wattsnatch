#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Sungrow Modbus TCP diagnostic.
//
// WattSnatch's Sungrow meter adapter was written against the SH-series HYBRID
// register map (taken from evcc's sungrow-hybrid template) and has never been
// verified against real hardware of any kind. SG-series STRING inverters are a
// different product line, and whether they expose the same registers - in
// particular the export/grid-power register that WattSnatch needs - is an open
// question that guesswork cannot settle.
//
// This script answers it empirically. It is READ-ONLY: it issues Modbus read
// requests and never writes a register, so it cannot change how an inverter
// behaves.
//
// Usage:
//   node scripts/diag-sungrow.js --host 192.168.1.100 [--port 502] [--unit 1]
//   node scripts/diag-sungrow.js --host 192.168.1.100 --scan
//   node scripts/diag-sungrow.js --host 192.168.1.100 --watch
//   node scripts/diag-sungrow.js --host 192.168.1.100 --watch --regs 5082,5030,5094
//
// Without a mode flag it reads exactly the registers WattSnatch uses and shows
// what each decodes to. --scan sweeps nearby register blocks and reports
// anything non-zero, which is how you find the right address when the
// documented one comes back empty. --watch polls a small set of registers
// repeatedly so you can switch a big load (kettle, oven) on and off and SEE
// which value moves and by how much - the fastest way to positively identify a
// grid/meter register rather than inferring it.
//
// Run it while the sun is up and the system is generating, otherwise every
// power register legitimately reads zero and the output tells you nothing.
//
// ── IMPORTANT: register numbering ───────────────────────────────────────────
// Sungrow's protocol documents register NUMBERS which are 1-based, while
// modbus-serial (and most libraries) take a 0-based ADDRESS. So the address to
// read is always the documented number MINUS ONE.
//
// Confirmed empirically: "Total DC power" is documented at 5017 and is read
// here at 5016. Anything below labelled "doc N" therefore reads at N-1.

const ModbusRTU = require('modbus-serial');

// ── Args ─────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST  = arg('host');
const PORT  = parseInt(arg('port', '502'), 10);
const UNIT  = parseInt(arg('unit', '1'), 10);
const SCAN  = process.argv.includes('--scan');
const WATCH = process.argv.includes('--watch');
const EVERY = parseFloat(arg('every', '2'));

// Watch candidates for an SG-series string inverter with an external meter.
// Addresses are 0-based (documented number minus one) - see the note at the top.
// Defaults chosen from Sungrow's string-inverter protocol: 5031 total active
// power, 5083 meter power, 5085/5087/5089 per-phase meter power.
const DEFAULT_WATCH = [
  { addr: 5016, words: 2, label: 'doc 5017  PV power (known good)' },
  { addr: 5030, words: 2, label: 'doc 5031  Total active power (AC out)' },
  { addr: 5082, words: 2, label: 'doc 5083  METER POWER  <- prime suspect' },
  { addr: 5084, words: 2, label: 'doc 5085  Meter A phase' },
  { addr: 5086, words: 2, label: 'doc 5087  Meter B phase' },
  { addr: 5088, words: 2, label: 'doc 5089  Meter C phase' },
  { addr: 5090, words: 2, label: 'doc 5091  (unknown - candidate load power)' },
  { addr: 5094, words: 2, label: 'doc 5095  (reads large/negative - units?)' },
];

const WATCH_LIST = (() => {
  const custom = arg('regs');
  if (!custom) return DEFAULT_WATCH;
  return custom.split(',').map((s) => {
    const addr = parseInt(s.trim(), 10);
    return { addr, words: 2, label: `addr ${addr} (doc ${addr + 1})` };
  }).filter((r) => Number.isFinite(r.addr));
})();

if (!HOST) {
  console.error('Usage: node scripts/diag-sungrow.js --host <ip> [--port 502] [--unit 1]');
  console.error('       [--scan]                sweep register blocks for non-zero values');
  console.error('       [--watch]               poll live, to identify registers by switching a load');
  console.error('       [--watch --regs 5082,5030]   watch specific 0-based addresses');
  console.error('       [--every 2]             seconds between polls in --watch mode');
  process.exit(1);
}

// ── Decoders - identical to src/services/meters/sungrow.js ───────────────────
// Deliberately duplicated rather than imported: this script must run standalone
// on a machine where WattSnatch is not configured, and it has to decode exactly
// the way the real adapter does or it proves nothing about the real adapter.

const toInt16 = (u) => (u > 32767 ? u - 65536 : u);
const toInt32 = (u) => (u > 0x7FFFFFFF ? u - 0x100000000 : u);

/** Sungrow's word-swapped order: LOW word first, HIGH word second. */
const combineSwapped = (d) => (((d[1] << 16) | (d[0] & 0xFFFF)) >>> 0);
/** Standard big-endian order, for comparison when a value looks wrong. */
const combineStandard = (d) => (((d[0] << 16) | (d[1] & 0xFFFF)) >>> 0);

// The registers WattSnatch actually reads, and what it expects of each.
const REGISTERS = [
  { addr: 5016,  words: 2, name: 'TOTAL_PV_POWER',        expect: 'PV generation, watts',            critical: true },
  { addr: 13009, words: 2, name: 'EXPORT_POWER',          expect: 'grid flow, watts (+ = exporting)', critical: true },
  { addr: 13002, words: 2, name: 'TOTAL_PV_ENERGY',       expect: 'lifetime generation, 0.1kWh units', critical: false },
  { addr: 13000, words: 1, name: 'BATTERY_RUNNING_STATE', expect: 'bitfield (no battery = ignore)',  critical: false },
  { addr: 13020, words: 1, name: 'BATTERY_CURRENT',       expect: 'amps (no battery = ignore)',      critical: false },
  { addr: 13021, words: 1, name: 'BATTERY_POWER',         expect: 'watts (no battery = ignore)',     critical: false },
];

// Blocks worth sweeping when a documented register comes back empty. Bounded on
// purpose - a blind sweep of the whole address space is slow and rude to the
// device.
const SCAN_BLOCKS = [
  { from: 5000,  to: 5120,  label: 'inverter/device block' },
  { from: 13000, to: 13100, label: 'energy-management block' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBoth(client, addr, words) {
  // Sungrow documents these as input registers (function 4), but some firmware
  // exposes the same data as holding registers (function 3). Try both rather
  // than concluding "not supported" from one failure.
  const out = { input: null, holding: null };
  try {
    const r = await client.readInputRegisters(addr, words);
    if (r && r.data) out.input = r.data;
  } catch (e) { out.inputErr = e.message; }
  try {
    const r = await client.readHoldingRegisters(addr, words);
    if (r && r.data) out.holding = r.data;
  } catch (e) { out.holdingErr = e.message; }
  return out;
}

function describe(data, words) {
  if (!data) return null;
  if (words === 1) {
    return `raw=${data[0]}  int16=${toInt16(data[0])}`;
  }
  const sw = combineSwapped(data);
  const st = combineStandard(data);
  return `raw=[${data.join(', ')}]  word-swapped=${sw} (int32 ${toInt32(sw)})  standard=${st} (int32 ${toInt32(st)})`;
}

async function main() {
  console.log('');
  console.log('  Sungrow Modbus diagnostic (read-only)');
  console.log(`  target ${HOST}:${PORT}  unit id ${UNIT}`);
  console.log('');

  const client = new ModbusRTU();
  client.setTimeout(5000);

  try {
    await client.connectTCP(HOST, { port: PORT });
    client.setID(UNIT);
    console.log('  Connected.\n');
  } catch (err) {
    console.log(`  COULD NOT CONNECT: ${err.message}`);
    console.log('');
    console.log('  Nothing is accepting Modbus TCP at that address and port. Common causes:');
    console.log('    - the dongle does not speak Modbus TCP (older V-series dongles often do not)');
    console.log('    - Modbus is disabled in the dongle\'s own web interface');
    console.log('    - wrong IP, or the dongle is on a different subnet/VLAN');
    console.log('');
    process.exit(2);
  }

  // ── Watch mode ─────────────────────────────────────────────────────────────
  if (WATCH) {
    console.log('  ── Live watch ───────────────────────────────────────────────');
    console.log('  Switch a big load (kettle, oven) ON and OFF and watch which value');
    console.log('  moves, and by roughly that load\'s wattage. That identifies the grid');
    console.log('  register positively rather than by inference.');
    console.log('');
    console.log('  A grid/meter register should: move by ~the load\'s wattage, change sign');
    console.log('  between import and export, and be larger than PV when the load exceeds');
    console.log('  generation. Ctrl-C to stop.');
    console.log('');

    const label = WATCH_LIST.map((r) => r.label);
    const width = Math.max(...label.map((l) => l.length));
    let tick = 0;

    // Sequential rather than parallel: these dongles are single-connection and
    // can drop concurrent requests, which would look like a dead register.
    for (;;) {
      const time = new Date().toLocaleTimeString();
      const parts = [];
      for (const reg of WATCH_LIST) {
        let out = '     n/a';
        try {
          const r = await client.readInputRegisters(reg.addr, reg.words);
          if (r && r.data) {
            const sw = combineSwapped(r.data);
            out = String(toInt32(sw)).padStart(8);
          }
        } catch (_e) {
          out = '   ERR  ';
        }
        parts.push(out);
        await sleep(60);
      }

      if (tick % 15 === 0) {
        console.log('');
        console.log('  time      ' + WATCH_LIST.map((r, i) => `[${i}]`.padStart(8)).join(''));
        WATCH_LIST.forEach((r, i) => console.log(`    [${i}] ${r.label}`));
        console.log('');
      }
      console.log('  ' + time + '  ' + parts.join(''));
      tick++;
      await sleep(Math.max(250, EVERY * 1000));
    }
  }

  console.log('  ── Registers WattSnatch reads ───────────────────────────────');
  const results = {};
  for (const reg of REGISTERS) {
    const both = await readBoth(client, reg.addr, reg.words);
    const chosen = both.input || both.holding;
    const via = both.input ? 'input (fn4)' : both.holding ? 'holding (fn3)' : null;
    results[reg.name] = chosen;

    console.log('');
    console.log(`  ${reg.addr}  ${reg.name}${reg.critical ? '   [REQUIRED]' : '   (optional)'}`);
    console.log(`      expected: ${reg.expect}`);
    if (!chosen) {
      console.log(`      NOT READABLE  (input: ${both.inputErr || 'no data'}; holding: ${both.holdingErr || 'no data'})`);
    } else {
      console.log(`      read via ${via}`);
      console.log(`      ${describe(chosen, reg.words)}`);
    }
    await sleep(120); // be gentle with the dongle
  }

  // ── What this means for WattSnatch ─────────────────────────────────────────
  console.log('');
  console.log('  ── Verdict ──────────────────────────────────────────────────');
  const pv = results.TOTAL_PV_POWER;
  const ex = results.EXPORT_POWER;

  if (pv) {
    const solarW = Math.max(0, combineSwapped(pv));
    console.log(`  Solar generation: ${solarW} W`);
    if (solarW === 0) {
      console.log('    (zero - if the sun is up and the system is generating, this register is wrong for this model)');
    } else if (solarW > 1000000) {
      console.log('    IMPLAUSIBLE - likely the wrong word order or the wrong register for this model');
    }
  } else {
    console.log('  Solar generation: REGISTER NOT READABLE - WattSnatch cannot use Modbus on this unit as-is');
  }

  if (ex) {
    const rawExport = toInt32(combineSwapped(ex));
    const gridW = -rawExport; // Sungrow "+ = exporting" -> WattSnatch "+ = importing"
    console.log(`  Grid flow: ${gridW} W  (${gridW > 0 ? 'importing' : gridW < 0 ? 'exporting' : 'balanced'})`);
    console.log('');
    if (pv) {
      const solarW = Math.max(0, combineSwapped(pv));
      console.log(`  Derived house consumption: ${Math.max(0, solarW + gridW)} W`);
      console.log('  => Both required registers read. WattSnatch\'s existing Sungrow adapter');
      console.log('     should work on this inverter as-is. Sanity-check the numbers above');
      console.log('     against the iSolarCloud app before trusting them.');
    }
  } else {
    console.log('  Grid flow: REGISTER NOT READABLE');
    console.log('');
    console.log('  => This is the blocker. Without grid flow there is no way to know house');
    console.log('     consumption, and solar-excess diversion needs it. Re-run with --scan to');
    console.log('     look for the right address on this model.');
  }

  // ── Optional sweep ─────────────────────────────────────────────────────────
  if (SCAN) {
    console.log('');
    console.log('  ── Sweep (non-zero registers only) ──────────────────────────');
    console.log('  Anything resembling live power in watts is a candidate. Compare against');
    console.log('  what the iSolarCloud app shows right now to identify them.');
    for (const block of SCAN_BLOCKS) {
      console.log('');
      console.log(`  ${block.from}-${block.to}  ${block.label}`);
      let found = 0;
      for (let addr = block.from; addr <= block.to; addr += 25) {
        const count = Math.min(25, block.to - addr + 1);
        let data = null;
        try {
          const r = await client.readInputRegisters(addr, count);
          data = r && r.data;
        } catch (_e) {
          try {
            const r = await client.readHoldingRegisters(addr, count);
            data = r && r.data;
          } catch (_e2) { /* block unreadable - skip quietly */ }
        }
        if (data) {
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== 0) {
              console.log(`    ${addr + i}: ${data[i]}  (int16 ${toInt16(data[i])})`);
              found++;
            }
          }
        }
        await sleep(120);
      }
      if (found === 0) console.log('    (nothing non-zero, or block not readable)');
    }
  }

  console.log('');
  client.close(() => process.exit(0));
}

main().catch((err) => {
  console.error('\n  Failed:', err.message, '\n');
  process.exit(1);
});
