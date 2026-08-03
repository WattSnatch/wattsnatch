/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

/**
 * Fleet Telemetry ZMQ subscriber.
 *
 * The Fleet Telemetry binary runs on the same machine and publishes vehicle
 * data events over a ZMQ socket at tcp://127.0.0.1:5678. This module subscribes
 * to that socket and maintains an in-memory copy of the latest vehicle state.
 *
 * ZMQ messages are two frames:
 *   Frame 0: topic string - "{namespace}_{txtype}", e.g. "wattsnatch_V"
 *   Frame 1: protobuf-encoded Payload (vehicle data) or VehicleConnectivity
 *
 * The controller reads from this cache on every Enphase poll cycle instead of
 * calling the Tesla vehicle_data API. A 5-minute staleness fallback in the
 * controller still calls vehicle_data if telemetry goes quiet (e.g. Fleet
 * Telemetry server restarts or car loses connectivity).
 *
 * Field enum values (from protos/vehicle_data.proto):
 *   Soc=8, Location=21, ACChargingPower=37, ChargeLimitSoc=38,
 *   ChargeAmps=49, DetailedChargeState=179, ChargerVoltage=184
 */

// Gracefully degrade if zeromq hasn't been installed yet
let zmq = null;
try { zmq = require('zeromq'); } catch (_e) {}

const db = require('../db');

const ZMQ_ADDR = process.env.FLEET_TELEMETRY_ADDR || 'tcp://127.0.0.1:5678';
const STALE_MS = 5 * 60 * 1000; // 5 minutes
const PERSIST_KEY = 'telemetry_last_state';

// ── Shared state ──────────────────────────────────────────────────────────────
// Seeded from the DB in startTelemetryListener() (i.e. after the DB is
// actually initialized - this module is required before dbModule.initDb()
// runs in server.js, so loading here at module-eval time would read a null
// connection) so consumers (e.g. the MQTT publisher) have the vehicle's last
// known status immediately, rather than sitting blank until the car wakes up
// and Fleet Telemetry sends a fresh push.

const _state = {
  chargingState:  null,   // 'Charging'|'Stopped'|'Disconnected'|'Complete'|'NoPower'|null
  batteryPct:     0,
  chargeLimit:    80,
  // When chargeLimit was last confirmed straight from the car, and how.
  //
  // This matters because Fleet Telemetry only pushes ChargeLimitSoc when it
  // CHANGES. If a wrong value is ever latched - a bad REST read, a value from
  // another vehicle state - the car will never spontaneously correct it, and
  // because _state is persisted the wrong value survives restarts forever.
  // The controller stops charging at whatever this says, so a stale 50 silently
  // caps a car whose real limit is 80. Tracking age lets the controller insist
  // on a fresh reading from Tesla before it acts on the limit.
  chargeLimitAt:     null, // ms epoch, or null if never confirmed this boot
  chargeLimitSource: 'none', // 'telemetry' | 'api' | 'persisted' | 'none'
  chargeAmps:     0,
  chargerPowerKw: 0,
  chargerVoltage: 240,
  latitude:       null,
  longitude:      null,
  isOnline:       false,
  lastUpdated:    null,
  source:         'none', // 'telemetry' | 'api' | 'none' | 'persisted'
};

function _loadPersisted() {
  try {
    const raw = db.getSetting(PERSIST_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(_state, saved, { source: 'persisted' }); // carried over - not confirmed since this boot
    // A persisted charge limit is a guess until the car confirms it. Clearing
    // the timestamp (rather than the value) keeps the dashboard populated while
    // still forcing the controller to re-confirm before enforcing it.
    _state.chargeLimitAt     = null;
    _state.chargeLimitSource = 'persisted';
  } catch (_e) { /* corrupt/missing - keep defaults */ }
}

function _persist() {
  try { db.setSetting(PERSIST_KEY, JSON.stringify(_state)); } catch (_e) {}
}

const _listeners = [];
let _started = false;

// ── Public API ────────────────────────────────────────────────────────────────

/** Register a callback fired on every state change (called with a snapshot). */
function onVehicleUpdate(cb) { _listeners.push(cb); }

/** Return a snapshot of the current vehicle state. */
function getState() { return { ..._state }; }

/** Milliseconds since the last telemetry or API update (Infinity if never). */
function getAge() { return _state.lastUpdated ? Date.now() - _state.lastUpdated : Infinity; }

/** True if no update received in the last 5 minutes. */
function isStale() { return getAge() > STALE_MS; }

/**
 * Inject data from a vehicle_data API fallback call.
 * Used by the controller's _fallbackPoll() when telemetry is stale.
 */
function updateFromApi({ chargingState, batteryPct, chargeLimit, chargeAmps,
                         chargerPowerKw, chargerVoltage, latitude, longitude, isOnline }) {
  if (chargingState  !== undefined) _state.chargingState  = chargingState;
  if (batteryPct     !== undefined) _state.batteryPct     = batteryPct;
  if (chargeLimit    !== undefined) {
    _state.chargeLimit       = chargeLimit;
    _state.chargeLimitAt     = Date.now();
    _state.chargeLimitSource = 'api';
  }
  if (chargeAmps     !== undefined) _state.chargeAmps     = chargeAmps;
  if (chargerPowerKw !== undefined) _state.chargerPowerKw = chargerPowerKw;
  if (chargerVoltage !== undefined) _state.chargerVoltage = chargerVoltage;
  if (latitude       !== undefined) _state.latitude       = latitude;
  if (longitude      !== undefined) _state.longitude      = longitude;
  if (isOnline       !== undefined) _state.isOnline       = isOnline;
  _state.lastUpdated = Date.now();
  _state.source = 'api';
  _notify();
}

/** Start the ZMQ subscriber. Safe to call multiple times - only starts once. */
async function startTelemetryListener() {
  if (_started) return;
  _started = true;

  _loadPersisted();

  if (!zmq) {
    console.warn('[Telemetry] zeromq not installed - Fleet Telemetry disabled. ' +
                 'Run: npm install zeromq');
    return;
  }

  try {
    const sock = new zmq.Subscriber();
    sock.connect(ZMQ_ADDR);
    sock.subscribe(''); // subscribe to all topics
    console.log(`[Telemetry] Subscribed to ZMQ socket ${ZMQ_ADDR}`);
    _run(sock); // detached - runs as background async loop
  } catch (err) {
    console.error('[Telemetry] ZMQ connect failed:', err.message);
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _notify() {
  _persist();
  const snap = getState();
  for (const cb of _listeners) {
    try { cb(snap); } catch (_e) {}
  }
}

async function _run(sock) {
  try {
    for await (const [topicBuf, payload] of sock) {
      try {
        const topic = topicBuf.toString();
        if (topic.endsWith('_connectivity')) {
          _handleConnectivity(payload);
        } else if (topic.endsWith('_V')) {
          _handleVehicleData(payload);
        }
      } catch (err) {
        console.error('[Telemetry] Parse error:', err.message);
      }
    }
  } catch (err) {
    // ZMQ loop died (e.g. Fleet Telemetry restarted). The 5-min fallback poll
    // in the controller will cover this gap until the process is restarted.
    console.error('[Telemetry] ZMQ loop stopped:', err.message);
  }
}

// ── Minimal proto3 decoder ────────────────────────────────────────────────────

// Returns { v: number, pos: number } - reads a varint starting at pos
function _varint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { v: result >>> 0, pos };
}

// Returns { [fieldNumber]: [values...] } where each value is:
//   wire type 0 (varint) → number
//   wire type 1 (64-bit) → Buffer (8 bytes)
//   wire type 2 (LEN)    → Buffer
//   wire type 5 (32-bit) → Buffer (4 bytes)
function _parseFields(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const t = _varint(buf, pos); pos = t.pos;
    const fn = t.v >>> 3, wt = t.v & 7;
    if (wt === 0) {
      const v = _varint(buf, pos); pos = v.pos;
      (out[fn] = out[fn] || []).push(v.v);
    } else if (wt === 1) {
      (out[fn] = out[fn] || []).push(buf.slice(pos, pos + 8)); pos += 8;
    } else if (wt === 2) {
      const l = _varint(buf, pos); pos = l.pos;
      (out[fn] = out[fn] || []).push(buf.slice(pos, pos + l.v)); pos += l.v;
    } else if (wt === 5) {
      (out[fn] = out[fn] || []).push(buf.slice(pos, pos + 4)); pos += 4;
    } else {
      break; // unknown wire type - bail to avoid infinite loop
    }
  }
  return out;
}

function _dbl(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return b.readDoubleLE(0);
}

// Field enum values from protos/vehicle_data.proto
const FIELD = {
  Soc:                8,
  Location:           21,
  ACChargingPower:    37,
  ChargeLimitSoc:     38,
  ChargeAmps:         49,
  DetailedChargeState: 179,
  ChargerVoltage:     184,
};

// DetailedChargeStateValue enum → internal string (null = unknown/invalid)
const DETAILED_CHARGE_STATE = {
  0: null,          // Unknown
  1: 'Disconnected',
  2: 'NoPower',
  3: 'Charging',    // Starting → treat as Charging
  4: 'Charging',
  5: 'Complete',
  6: 'Stopped',
};

// ── Message handlers ──────────────────────────────────────────────────────────

function _handleVehicleData(payload) {
  // Payload proto: data (repeated Datum) = field 1
  const f = _parseFields(payload);
  const datums = f[1] || [];
  let changed = false;

  for (const datumBytes of datums) {
    // Datum proto: key (Field enum) = field 1, value (Value) = field 2
    const df = _parseFields(datumBytes);
    const key      = (df[1] || [0])[0];
    const valBytes = (df[2] || [null])[0];
    if (!valBytes) continue;

    // Value proto oneof fields:
    //   string_value=1 (LEN), double_value=5 (64-bit),
    //   location_value=7 (LEN), detailed_charge_state_value=32 (varint)
    const vf = _parseFields(valBytes);

    switch (key) {
      case FIELD.ChargeAmps:
        if (vf[5]) { _state.chargeAmps     = _dbl(vf[5][0]); changed = true; } break;
      case FIELD.Soc:
        if (vf[5]) { _state.batteryPct     = _dbl(vf[5][0]); changed = true; } break;
      case FIELD.ChargeLimitSoc:
        if (vf[5]) {
          _state.chargeLimit       = _dbl(vf[5][0]);
          _state.chargeLimitAt     = Date.now();
          _state.chargeLimitSource = 'telemetry';
          changed = true;
        }
        break;
      case FIELD.ChargerVoltage:
        if (vf[5]) { _state.chargerVoltage = _dbl(vf[5][0]); changed = true; } break;
      case FIELD.ACChargingPower:
        if (vf[5]) { _state.chargerPowerKw = _dbl(vf[5][0]); changed = true; } break;
      case FIELD.DetailedChargeState:
        if (vf[32] && vf[32].length > 0) {
          const cs = DETAILED_CHARGE_STATE[vf[32][0]];
          if (cs !== undefined) { _state.chargingState = cs; changed = true; }
        }
        break;
      case FIELD.Location:
        if (vf[7]) {
          // LocationValue proto: latitude=1 (64-bit), longitude=2 (64-bit)
          const lf = _parseFields(vf[7][0]);
          if (lf[1]) _state.latitude  = _dbl(lf[1][0]);
          if (lf[2]) _state.longitude = _dbl(lf[2][0]);
          changed = true;
        }
        break;
    }
  }

  if (changed) {
    _state.isOnline    = true;
    _state.lastUpdated = Date.now();
    _state.source      = 'telemetry';
    _notify();
  }
}

function _handleConnectivity(payload) {
  // VehicleConnectivity proto: status (ConnectivityEvent) = field 3
  //   ConnectivityEvent: CONNECTED=1, DISCONNECTED=2
  const f = _parseFields(payload);
  _state.isOnline    = (f[3] || [0])[0] === 1;
  _state.lastUpdated = Date.now();
  _state.source      = 'telemetry';
  _notify();
}

/**
 * Milliseconds since the charge limit was last confirmed by the car itself
 * (Infinity if it has never been confirmed this boot - e.g. restored from the
 * persisted state, which is a carried-over guess rather than a fresh reading).
 */
function getChargeLimitAge() {
  return _state.chargeLimitAt ? Date.now() - _state.chargeLimitAt : Infinity;
}

module.exports = {
  startTelemetryListener, onVehicleUpdate, getState, getAge, isStale,
  updateFromApi, getChargeLimitAge,
};
