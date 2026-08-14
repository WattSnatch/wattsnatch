/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../../db');

// Dispatches to the Tesla or OCPP charging backend based on the
// charging_backend setting (default 'tesla'). Deliberately reads the setting
// on EVERY call rather than once at require time: controller.js is required
// before db.initDb() runs (see src/server.js), so a require-time
// db.getSetting() call here would crash the server on boot.
//
// Each exported function below is a pure forwarding wrapper - no logic beyond
// picking a backend and passing arguments straight through, and returning (or
// throwing) exactly what the backend returns or throws. That is what test/
// chargingBackendPassthrough.test.js verifies: with the default 'tesla'
// backend, every call here is indistinguishable from calling
// services/tesla.js / services/telemetry.js directly.
function _backend() {
  return db.getSetting('charging_backend') === 'ocpp'
    ? require('./ocpp')
    : require('./tesla');
}

module.exports = {
  wakeVehicle:       (...args) => _backend().wakeVehicle(...args),
  setChargingAmps:   (...args) => _backend().setChargingAmps(...args),
  startCharging:     (...args) => _backend().startCharging(...args),
  stopCharging:      (...args) => _backend().stopCharging(...args),
  getVehicleState:   (...args) => _backend().getVehicleState(...args),
  getVehicleData:    (...args) => _backend().getVehicleData(...args),
  useBleCommands:    (...args) => _backend().useBleCommands(...args),
  getVehicleDataBle: (...args) => _backend().getVehicleDataBle(...args),
  getBodyStateBle:   (...args) => _backend().getBodyStateBle(...args),
  telemetry: {
    startTelemetryListener: (...args) => _backend().telemetry.startTelemetryListener(...args),
    onVehicleUpdate:        (...args) => _backend().telemetry.onVehicleUpdate(...args),
    getState:                (...args) => _backend().telemetry.getState(...args),
    getAge:                  (...args) => _backend().telemetry.getAge(...args),
    isStale:                 (...args) => _backend().telemetry.isStale(...args),
    updateFromApi:            (...args) => _backend().telemetry.updateFromApi(...args),
    getChargeLimitAge:        (...args) => _backend().telemetry.getChargeLimitAge(...args),
    setChargeLimitLocal:      (...args) => _backend().telemetry.setChargeLimitLocal(...args),
  },
};
