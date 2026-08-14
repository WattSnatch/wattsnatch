/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The OCPP 1.6J Central System (CSMS) side: WattSnatch listens, the charger
// connects in as a WebSocket client. Standard OCPP topology, not an
// inversion of it. Supports exactly one connected charge point - matches
// OCPP-PLAN.md's scope (multi-vehicle/multi-charger is explicitly separate,
// unbuilt groundwork).

const WebSocket = require('ws');
const db = require('../../../db');
const protocol = require('./protocol');
const handlers = require('./handlers');
const state = require('./state');

let _wss = null;
let _conn = null;
let _pending = null;

function _expectedChargePointId() {
  return db.getSetting('ocpp_charge_point_id') || '';
}

// OCPP-J convention: ws://host:port/<basePath>/<chargePointId>
function _extractChargePointId(url) {
  const parts = (url || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function _handleMessage(ws, chargePointId, raw) {
  let frame;
  try {
    frame = protocol.decodeFrame(raw.toString());
  } catch (err) {
    console.error('[OCPP]', err.message);
    return;
  }

  if (frame.type === 'call') {
    let result;
    let error;
    try {
      result = handlers.handle(frame.action, chargePointId, frame.payload);
    } catch (err) {
      error = err;
    }
    if (error) {
      ws.send(protocol.encodeCallError(frame.id, error.ocppErrorCode || 'InternalError', error.message));
    } else {
      ws.send(protocol.encodeCallResult(frame.id, result || {}));
    }
  } else if (frame.type === 'callresult') {
    _pending.resolve(frame.id, frame.payload);
  } else if (frame.type === 'callerror') {
    _pending.reject(frame.id, new Error(`${frame.errorCode}: ${frame.errorDescription}`));
  }
}

/** Idempotent - safe to call multiple times, only binds the port once. */
function start() {
  if (_wss) return _wss;

  const port = parseInt(db.getSetting('ocpp_ws_port') || '9220', 10);
  _wss = new WebSocket.Server({
    port,
    // `protocols` is a Set in current `ws` versions (was an array in older
    // ones) - support both rather than assuming.
    handleProtocols: (protocols) => {
      const has = typeof protocols.has === 'function' ? protocols.has('ocpp1.6') : protocols.includes('ocpp1.6');
      return has ? 'ocpp1.6' : false;
    },
  });

  _wss.on('connection', (ws, req) => {
    const chargePointId = _extractChargePointId(req.url);
    const expected = _expectedChargePointId();
    if (expected && chargePointId !== expected) {
      console.warn(`[OCPP] rejected connection from unexpected charge point id "${chargePointId}" (expected "${expected}")`);
      ws.close(1008, 'unknown charge point id');
      return;
    }

    // Only one charge point connection is supported at a time - a new
    // connection replaces whatever was there, matching how a charger
    // reconnecting after a network blip should behave.
    if (_conn && _conn.readyState === WebSocket.OPEN) {
      try { _conn.close(1000, 'replaced by a new connection'); } catch (_e) {}
    }

    _conn = ws;
    _pending = new protocol.PendingCallTracker();
    state.setConnected(true);
    console.log(`[OCPP] charge point "${chargePointId}" connected`);

    ws.on('message', (raw) => _handleMessage(ws, chargePointId, raw));

    ws.on('close', () => {
      if (_conn === ws) {
        _conn = null;
        state.setConnected(false);
        if (_pending) _pending.clear(new Error('OCPP: connection closed'));
        console.log(`[OCPP] charge point "${chargePointId}" disconnected`);
      }
    });

    ws.on('error', (err) => console.error('[OCPP] connection error:', err.message));
  });

  _wss.on('error', (err) => console.error('[OCPP] server error:', err.message));

  console.log(`[OCPP] CSMS listening on ws://0.0.0.0:${port}`);
  return _wss;
}

function stop() {
  if (_conn) { try { _conn.close(); } catch (_e) {} _conn = null; }
  if (_pending) { _pending.clear(new Error('OCPP: server stopped')); _pending = null; }
  if (_wss) { _wss.close(); _wss = null; }
}

function isConnected() {
  return !!(_conn && _conn.readyState === WebSocket.OPEN);
}

async function sendCall(action, payload) {
  if (!isConnected()) throw new Error('OCPP: no charge point connected');
  const { id, frame } = protocol.encodeCall(action, payload);
  const result = _pending.register(id);
  _conn.send(frame);
  return result;
}

module.exports = { start, stop, isConnected, sendCall };
