/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

let _db = null;

function setDb(db) {
  _db = db;
}

/**
 * Log an event to the events_log table.
 * @param {'state_change'|'command'|'api_error'|'token'|'info'} type
 * @param {string} details
 * @param {string|null} oldState
 * @param {string|null} newState
 */
function logEvent(type, details, oldState = null, newState = null) {
  const now = Date.now();
  const line = `[${new Date(now).toISOString()}] [${type}]${oldState ? ` ${oldState} → ${newState}` : ''} ${details}`;
  console.log(line);

  if (_db) {
    try {
      _db.logEvent(type, oldState, newState, details);
    } catch (err) {
      console.error('[logger] DB write failed:', err.message);
    }
  }
}

module.exports = { setDb, logEvent };
