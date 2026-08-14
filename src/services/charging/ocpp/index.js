/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The OCPP charging backend's public interface - matches the 9 Tesla-shaped
// functions services/tesla.js exports (see OCPP-PLAN.md), plus the
// telemetry-shaped object services/telemetry.js exports. This is what
// services/charging/index.js dispatches to when charging_backend === 'ocpp'.
//
// `vin`/`chargePointId` and `token` are accepted in every function below to
// match the Tesla-shaped call signatures controller.js already uses, but are
// not used for dispatch: server.js supports exactly one connected charge
// point at a time (see OCPP-PLAN.md's multi-vehicle groundwork notes for why
// that's a separate, unbuilt piece of work), so there is nothing to route on
// yet.

const db = require('../../../db');
const server = require('./server');
const state = require('./state');

async function wakeVehicle(_vin, _token) {
  // No such concept in OCPP - a charge point is either connected or it isn't.
  return { ok: true };
}

async function setChargingAmps(_vin, amps, _token) {
  return server.sendCall('SetChargingProfile', {
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: {
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: amps }],
      },
    },
  });
}

async function startCharging(_vin, _token) {
  const idTag = db.getSetting('ocpp_id_tag') || 'WATTSNATCH';
  return server.sendCall('RemoteStartTransaction', { connectorId: 1, idTag });
}

async function stopCharging(_vin, _token) {
  const { transactionId } = state.getState();
  if (transactionId == null) {
    // Nothing to stop - matches services/tesla.js tolerating Tesla's
    // 'not_charging' reason rather than treating "already stopped" as a
    // command failure.
    return { status: 'Accepted' };
  }
  return server.sendCall('RemoteStopTransaction', { transactionId });
}

async function getVehicleState(_vin, _token) {
  return server.isConnected() ? 'online' : 'offline';
}

async function getVehicleData(_vin, _token) {
  const s = state.getState();
  return {
    chargeState: {
      charging_state:   s.chargingState,
      battery_level:    s.batteryPct,
      charge_limit_soc: s.chargeLimit,
      charge_amps:      s.chargeAmps,
      charger_power:    s.chargerPowerKw,
    },
    driveState: null, // OCPP has no drive-state / location concept
  };
}

function useBleCommands() {
  return false;
}

async function getVehicleDataBle(_vin) {
  throw new Error(
    'getVehicleDataBle is not supported by the OCPP backend - '
    + 'tesla_state_source must stay "telemetry" (the default) for an OCPP install'
  );
}

async function getBodyStateBle(_vin) {
  throw new Error(
    'getBodyStateBle is not supported by the OCPP backend - '
    + 'tesla_state_source must stay "telemetry" (the default) for an OCPP install'
  );
}

module.exports = {
  wakeVehicle, setChargingAmps, startCharging, stopCharging,
  getVehicleState, getVehicleData, useBleCommands, getVehicleDataBle, getBodyStateBle,
  telemetry: {
    startTelemetryListener: async () => { state._loadPersisted(); server.start(); },
    onVehicleUpdate:         state.onVehicleUpdate,
    getState:                 state.getState,
    getAge:                    state.getAge,
    isStale:                    state.isStale,
    updateFromApi:                state.updateFromApi,
    getChargeLimitAge:              state.getChargeLimitAge,
    setChargeLimitLocal:              state.setChargeLimitLocal,
  },
};
