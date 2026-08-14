/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The Tesla charging backend. This is a re-export, not a wrapper - every
// property here is the literal function from services/tesla.js and
// services/telemetry.js, with nothing added or changed. That is deliberate:
// it is what makes services/charging/index.js's per-call dispatch to this
// module behaviourally identical to calling services/tesla.js directly.
const tesla = require('../tesla');
const telemetry = require('../telemetry');

module.exports = {
  wakeVehicle:       tesla.wakeVehicle,
  setChargingAmps:   tesla.setChargingAmps,
  startCharging:     tesla.startCharging,
  stopCharging:      tesla.stopCharging,
  getVehicleState:   tesla.getVehicleState,
  getVehicleData:    tesla.getVehicleData,
  useBleCommands:    tesla.useBleCommands,
  getVehicleDataBle: tesla.getVehicleDataBle,
  getBodyStateBle:   tesla.getBodyStateBle,
  telemetry: {
    startTelemetryListener: telemetry.startTelemetryListener,
    onVehicleUpdate:        telemetry.onVehicleUpdate,
    getState:                telemetry.getState,
    getAge:                  telemetry.getAge,
    isStale:                 telemetry.isStale,
    updateFromApi:            telemetry.updateFromApi,
    getChargeLimitAge:        telemetry.getChargeLimitAge,
    setChargeLimitLocal:      telemetry.setChargeLimitLocal,
  },
};
