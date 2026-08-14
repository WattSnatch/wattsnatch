/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Handlers for OCPP-J CALLs a charge point sends us (WattSnatch is the CSMS).
// Each handler takes (chargePointId, payload) and returns the payload to send
// back as a CALLRESULT - throwing sends a CALLERROR instead.

const state = require('./state');

const HEARTBEAT_INTERVAL_S = 60;

let _txnCounter = 0;
function _nextTransactionId() { return ++_txnCounter; }

function handleBootNotification(_chargePointId, _payload) {
  state.applyUpdate({});
  return { status: 'Accepted', currentTime: new Date().toISOString(), interval: HEARTBEAT_INTERVAL_S };
}

function handleHeartbeat(_chargePointId, _payload) {
  state.applyUpdate({});
  return { currentTime: new Date().toISOString() };
}

function handleStatusNotification(_chargePointId, payload) {
  state.applyUpdate({ chargingState: state.mapStatus(payload && payload.status) });
  return {};
}

function handleAuthorize(_chargePointId, _payload) {
  // Any presented idTag is accepted - WattSnatch is the only thing that
  // should ever be starting a session on a charger it owns, and OCPP-PLAN.md
  // scoped RFID/user-authorization handling as out of scope for this pass.
  return { idTagInfo: { status: 'Accepted' } };
}

function handleStartTransaction(_chargePointId, payload) {
  const transactionId = _nextTransactionId();
  state.applyUpdate({
    chargingState:     'Charging',
    transactionId,
    meterStartWh:       (payload && payload.meterStart) ?? 0,
    energyDeliveredWh:  0,
  });
  return { transactionId, idTagInfo: { status: 'Accepted' } };
}

function handleMeterValues(_chargePointId, payload) {
  const patch = {};
  const samples = (payload && payload.meterValue) || [];
  for (const sample of samples) {
    for (const sv of (sample.sampledValue || [])) {
      const val = parseFloat(sv.value);
      if (Number.isNaN(val)) continue;
      switch (sv.measurand) {
        case undefined:
        case 'Power.Active.Import': {
          const watts = sv.unit === 'kW' ? val * 1000 : val;
          patch.chargerPowerKw = watts / 1000;
          break;
        }
        case 'Energy.Active.Import.Register': {
          const wh = sv.unit === 'kWh' ? val * 1000 : val;
          patch.energyDeliveredWh = wh - (state.getState().meterStartWh || 0);
          break;
        }
        case 'Current.Import':
          patch.chargeAmps = val;
          break;
        case 'SoC':
          // Rare on AC wallboxes (needs ISO 15118 Plug and Charge) - used if
          // a charger actually sends it, but never assumed present.
          patch.batteryPct = val;
          break;
        default:
          break;
      }
    }
  }
  state.applyUpdate(patch);
  return {};
}

function handleStopTransaction(_chargePointId, _payload) {
  state.applyUpdate({
    chargingState:  'Stopped',
    chargeAmps:     0,
    chargerPowerKw: 0,
    transactionId:  null,
  });
  return { idTagInfo: { status: 'Accepted' } };
}

const HANDLERS = {
  BootNotification:   handleBootNotification,
  Heartbeat:           handleHeartbeat,
  StatusNotification:   handleStatusNotification,
  Authorize:             handleAuthorize,
  StartTransaction:       handleStartTransaction,
  MeterValues:             handleMeterValues,
  StopTransaction:          handleStopTransaction,
};

function handle(action, chargePointId, payload) {
  const fn = HANDLERS[action];
  if (!fn) {
    const err = new Error(`Unsupported OCPP action: ${action}`);
    err.ocppErrorCode = 'NotImplemented';
    throw err;
  }
  return fn(chargePointId, payload);
}

module.exports = { handle, HANDLERS };
