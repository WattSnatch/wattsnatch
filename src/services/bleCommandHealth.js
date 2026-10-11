/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Tells a faulting Bluetooth proxy apart from a car that simply cannot be reached, backs off
// while it is faulting, and tells the owner when it has gone on for a while.
//
// Found live 2026-10-12. The proxy's Bluetooth adapter got stuck and rejected every request
// with "Command Disallowed". The controller wanted to stop a grid charge, so it sent a stop
// command every 10 seconds, got the same refusal 133 times, and said nothing to anyone. The
// grid charge ran for about 20 minutes and the owner found out by looking at the dashboard.
//
// Only definite proxy faults count, and the list is deliberately short:
//   - a response body naming the adapter or socket as broken (the same signatures the
//     watchdog on the proxy machine treats as faults)
//   - failing to connect to the proxy at all
// Everything else the proxy can say is NOT a fault and clears the count, because it proves the
// proxy and its adapter are working: "vehicle is not in range" (the car is away), "maximum
// number of BLE devices" (transient contention), a command the car refused. A timeout after
// connecting is ambiguous (a slow scan looks the same as a stuck proxy), so it neither counts
// nor clears. Treating those as faults would block legitimate commands to a car that is merely
// away, which is the more expensive mistake.

const logger = require('../utils/logger');

const FAULT_BODY = /Command Disallowed|hci socket|broken pipe|socket hang up/i;

const BACKOFF_BASE_MS = 15 * 1000;   // after the 2nd consecutive fault
const BACKOFF_MAX_MS  = 60 * 1000;   // never longer: a recovered proxy is used within a minute
const NOTIFY_AFTER_FAULTS = 3;
const NOTIFY_AFTER_MS = 2 * 60 * 1000; // earlier episodes cleared by themselves within ~2 minutes

function _fresh() {
  return { streak: 0, firstAt: 0, until: 0, notified: false, kind: '' };
}
let state = _fresh();

function _notify(title, message, priority) {
  try {
    require('./notifications').sendNotification(title, message, priority).catch(() => {});
  } catch (_e) { /* notifications not configured */ }
}

/** 'fault' | 'ok' for a response the proxy actually returned. */
function classifyResponse(status, body) {
  if (status === 200) return 'ok';
  return FAULT_BODY.test(String(body || '')) ? 'fault' : 'ok';
}

/** 'fault' | 'ignore' for a request that never produced a response. */
function classifyError(err) {
  return err && err.wattsnatchConnected === false ? 'fault' : 'ignore';
}

/** Throws while backing off, without touching the network. */
function assertNotBackingOff() {
  const now = Date.now();
  if (now < state.until) {
    const secs = Math.ceil((state.until - now) / 1000);
    const err = new Error(`Bluetooth proxy is faulting - backing off, retrying in ${secs}s`);
    err.wattsnatchBleBackoff = true;
    throw err;
  }
}

function _fault(kind) {
  const now = Date.now();
  state.streak += 1;
  if (state.streak === 1) state.firstAt = now;
  state.kind = kind;
  if (state.streak >= 2) {
    state.until = now + Math.min(BACKOFF_BASE_MS * 2 ** (state.streak - 2), BACKOFF_MAX_MS);
  }
  if (!state.notified && state.streak >= NOTIFY_AFTER_FAULTS && now - state.firstAt >= NOTIFY_AFTER_MS) {
    state.notified = true;
    const mins = Math.max(1, Math.round((now - state.firstAt) / 60000));
    const why = kind === 'unreachable'
      ? 'the proxy could not be reached'
      : "the proxy's Bluetooth adapter is rejecting commands";
    const msg = `Commands to the car over Bluetooth have been failing for about ${mins} min: ${why}. `
      + `WattSnatch cannot start, stop or adjust charging until this clears. Check the machine `
      + `running the Bluetooth proxy, and its watchdog log.`;
    logger.logEvent('api_error', msg);
    _notify('WattSnatch: Bluetooth link to the car is down', msg, 'high');
  }
}

function _ok() {
  if (state.notified) {
    const mins = Math.max(1, Math.round((Date.now() - state.firstAt) / 60000));
    const msg = `Bluetooth commands to the car are working again after about ${mins} min.`;
    logger.logEvent('info', msg);
    _notify('WattSnatch: Bluetooth link to the car is back', msg, 'default');
  }
  state = _fresh();
}

function noteResponse(status, body) {
  if (classifyResponse(status, body) === 'fault') _fault('adapter');
  else _ok();
}

function noteError(err) {
  if (classifyError(err) === 'fault') _fault('unreachable');
}

module.exports = {
  assertNotBackingOff, noteResponse, noteError, classifyResponse, classifyError,
  getState: () => ({ ...state }),
  _reset: () => { state = _fresh(); },
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, NOTIFY_AFTER_FAULTS, NOTIFY_AFTER_MS,
};
