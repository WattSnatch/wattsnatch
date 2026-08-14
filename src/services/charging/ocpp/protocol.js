/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// OCPP-J 1.6 message framing: https://www.openchargealliance.org/
// Every message is a JSON array. CALL = [2, id, action, payload],
// CALLRESULT = [3, id, payload], CALLERROR = [4, id, code, description, details].

const crypto = require('crypto');

const CALL = 2;
const CALLRESULT = 3;
const CALLERROR = 4;

function nextMessageId() {
  return crypto.randomUUID();
}

function encodeCall(action, payload, id = nextMessageId()) {
  return { id, frame: JSON.stringify([CALL, id, action, payload]) };
}

function encodeCallResult(id, payload) {
  return JSON.stringify([CALLRESULT, id, payload]);
}

function encodeCallError(id, errorCode, errorDescription, errorDetails = {}) {
  return JSON.stringify([CALLERROR, id, errorCode, errorDescription || '', errorDetails]);
}

/**
 * Parse a raw OCPP-J frame into { type, id, ... }. Throws on anything that
 * isn't a well-formed CALL/CALLRESULT/CALLERROR - a malformed frame from a
 * charge point should be logged and dropped, never guessed at.
 */
function decodeFrame(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (err) {
    throw new Error(`OCPP: invalid JSON frame: ${err.message}`);
  }
  if (!Array.isArray(msg) || msg.length < 3) {
    throw new Error('OCPP: malformed frame (expected a JSON array of length >= 3)');
  }
  const [type, id] = msg;
  if (type === CALL) {
    if (msg.length !== 4 || typeof msg[2] !== 'string') throw new Error('OCPP: malformed CALL frame');
    return { type: 'call', id, action: msg[2], payload: msg[3] };
  }
  if (type === CALLRESULT) {
    if (msg.length !== 3) throw new Error('OCPP: malformed CALLRESULT frame');
    return { type: 'callresult', id, payload: msg[2] };
  }
  if (type === CALLERROR) {
    if (msg.length < 4) throw new Error('OCPP: malformed CALLERROR frame');
    return { type: 'callerror', id, errorCode: msg[2], errorDescription: msg[3], errorDetails: msg[4] || {} };
  }
  throw new Error(`OCPP: unknown message type ${type}`);
}

/**
 * Tracks CALLs WE sent (CSMS -> charge point, e.g. RemoteStartTransaction)
 * that are waiting for a matching CALLRESULT/CALLERROR by message id, with a
 * timeout so a charge point that never replies can't hang a command forever.
 */
class PendingCallTracker {
  constructor(timeoutMs = 30000) {
    this._timeoutMs = timeoutMs;
    this._pending = new Map(); // id -> { resolve, reject, timer }
  }

  register(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`OCPP: no response to message ${id} within ${this._timeoutMs}ms`));
      }, this._timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  resolve(id, payload) {
    const p = this._pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this._pending.delete(id);
    p.resolve(payload);
    return true;
  }

  reject(id, err) {
    const p = this._pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this._pending.delete(id);
    p.reject(err);
    return true;
  }

  /** Reject every still-pending call, e.g. when the connection drops. */
  clear(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
    this._pending.clear();
  }
}

module.exports = {
  CALL, CALLRESULT, CALLERROR,
  nextMessageId, encodeCall, encodeCallResult, encodeCallError, decodeFrame,
  PendingCallTracker,
};
