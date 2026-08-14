/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

/**
 * The OCPP equivalent of services/telemetry.js's in-memory vehicle-state
 * cache. controller.js reads this through services/charging's `telemetry`
 * object, so the shape and field names here match services/telemetry.js's
 * getState() exactly - same charging_state vocabulary
 * ('Charging'/'Stopped'/'NoPower'/'Disconnected'/'Complete'/null), same
 * property names, so controller.js's string comparisons and
 * chargeState ? chargeState.battery_level : 0 -style fallbacks work
 * unmodified.
 *
 * No SoC: typical home AC wallboxes have no ISO 15118 ("Plug and Charge")
 * link to the vehicle, so OCPP 1.6 has no real battery percentage to report.
 * batteryPct stays 0 forever (matching services/telemetry.js's own default
 * for "no data yet"), and chargeLimitAt stays null forever so
 * getChargeLimitAge() always returns Infinity - which makes
 * controller.js's `limitConfirmed` flag permanently false, so the
 * battery>=limit stop condition can never fire for this backend. That is
 * the correct, honest behaviour: charging runs at the solar-matched rate
 * until the vehicle or charger ends the session itself.
 */

const db = require('../../../db');

const STALE_MS = 5 * 60 * 1000;
const PERSIST_KEY = 'ocpp_last_state';

const _state = {
  chargingState:  null,
  batteryPct:     0,
  chargeLimit:    80,      // cosmetic only - see module doc above
  chargeLimitAt:     null, // never set - see module doc above
  chargeLimitSource: 'none',
  chargeAmps:     0,
  chargerPowerKw: 0,
  chargerVoltage: 240,
  latitude:       null,
  longitude:      null,
  isOnline:       false,
  lastUpdated:    null,
  source:         'none',
  // OCPP-specific bookkeeping, not part of the Tesla-shaped snapshot other
  // code reads, but useful internally for handlers.js.
  transactionId:     null,
  meterStartWh:      null,
  energyDeliveredWh: 0,
};

function _loadPersisted() {
  try {
    const raw = db.getSetting(PERSIST_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(_state, saved, { source: 'persisted', isOnline: false });
  } catch (_e) { /* corrupt/missing - keep defaults */ }
}

function _persist() {
  try { db.setSetting(PERSIST_KEY, JSON.stringify(_state)); } catch (_e) {}
}

const _listeners = [];

function onVehicleUpdate(cb) { _listeners.push(cb); }
function getState() { return { ..._state }; }
function getAge() { return _state.lastUpdated ? Date.now() - _state.lastUpdated : Infinity; }
function isStale() { return getAge() > STALE_MS; }

/** Always Infinity - see the no-SoC note in the module doc above. */
function getChargeLimitAge() { return Infinity; }

/** No-op - OCPP has no charge-limit concept for this backend to cache. */
function setChargeLimitLocal() {}

function _notify() {
  _persist();
  const snap = getState();
  for (const cb of _listeners) {
    try { cb(snap); } catch (_e) {}
  }
}

/** Applied by handlers.js on every inbound OCPP message that changes state. */
function applyUpdate(patch) {
  Object.assign(_state, patch);
  _state.lastUpdated = Date.now();
  _state.source = 'ocpp';
  _notify();
}

function setConnected(connected) {
  _state.isOnline = connected;
  _state.lastUpdated = Date.now();
  _notify();
}

/**
 * REST-fallback equivalent. OCPP has no polling API - state only ever
 * arrives pushed from the charge point - so this just re-stamps whatever is
 * already cached as fresh. controller.js only reaches this when telemetry
 * has gone stale AND a Tesla token is configured (its own guard), which is
 * effectively unreachable for a pure-OCPP install; implemented properly
 * rather than left to throw, since "effectively unreachable" isn't the same
 * as "provably unreachable".
 */
function updateFromApi(patch) {
  applyUpdate(patch || {});
}

// OCPP 1.6 ChargePointStatus -> Tesla-shaped charging_state. Deliberately
// conservative where a status doesn't map cleanly (Reserved/Unavailable/
// Faulted): null (unknown) rather than asserting a plugged-in state we can't
// verify from the status alone.
const STATUS_MAP = {
  Available:      'Disconnected',
  Preparing:       'Stopped',
  Charging:        'Charging',
  SuspendedEVSE:    'Stopped',
  SuspendedEV:       'Stopped',
  Finishing:          'Stopped',
  Reserved:            null,
  Unavailable:          null,
  Faulted:               null,
};

function mapStatus(ocppStatus) {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, ocppStatus) ? STATUS_MAP[ocppStatus] : null;
}

module.exports = {
  onVehicleUpdate, getState, getAge, isStale, updateFromApi,
  getChargeLimitAge, setChargeLimitLocal,
  applyUpdate, setConnected, mapStatus, _loadPersisted,
};
