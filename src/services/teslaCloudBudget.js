/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Daily cap on billed Tesla Fleet API requests.
//
// In September 2026 a path nobody knew was calling the cloud made ~6,500 billed requests a
// day for days, until Tesla disabled the developer account. The paths behind that are fixed,
// but nothing stopped a runaway, so the next unknown path would have done the same. Every
// billed request is counted here, in one place, before it is sent, and once the day's limit
// is reached further requests are refused until local midnight and the owner is notified.
//
// Counted: anything sent to a Fleet API regional host or through the local signing proxy
// (which forwards to the Fleet API). Not counted: Bluetooth proxy traffic, Tesla's sign-in
// servers (token refresh) and Fleet Telemetry, none of which are Fleet API requests.
//
// "Essential" requests are counted but never refused: setup and sign-in steps, so the owner
// can always fix a configuration, and stopping a charge, because refusing that could leave
// the car charging from the grid unsupervised. Costing a few cents is the lesser harm.

const db = require('../db');
const logger = require('../utils/logger');

const USAGE_KEY = 'tesla_cloud_usage';
const LIMIT_KEY = 'tesla_cloud_daily_limit';

// With BLE commands, normal running makes about 4 requests a day (the telemetry config
// check), so 50 leaves plenty of room for setup and manual actions while stopping a runaway
// within the first hour. With Fleet API commands every charge adjustment is a request, and a
// busy solar day legitimately makes a few hundred.
const DEFAULT_LIMIT_BLE_COMMANDS   = 50;
const DEFAULT_LIMIT_FLEET_COMMANDS = 1000;

function _today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The active daily limit. 0 means no limit (only if the owner explicitly sets it). */
function getLimit() {
  const raw = db.getSetting(LIMIT_KEY);
  const n = parseInt(raw, 10);
  if (raw != null && raw !== '' && Number.isFinite(n) && n >= 0) return n;
  return db.getSetting('tesla_command_backend') === 'ble'
    ? DEFAULT_LIMIT_BLE_COMMANDS
    : DEFAULT_LIMIT_FLEET_COMMANDS;
}

/** Today's usage: { date, count, refused, notified }. Rolls over at local midnight. */
function getUsage() {
  const today = _today();
  try {
    const u = JSON.parse(db.getSetting(USAGE_KEY) || 'null');
    if (u && u.date === today && Number.isFinite(u.count)) {
      return { date: today, count: u.count, refused: u.refused || 0, notified: !!u.notified };
    }
  } catch (_e) { /* corrupt - start the day fresh */ }
  return { date: today, count: 0, refused: 0, notified: false };
}

function _save(u) {
  try { db.setSetting(USAGE_KEY, JSON.stringify(u)); } catch (_e) { /* never break a request on bookkeeping */ }
}

/**
 * Call immediately before sending a billed request. Throws if the daily limit is reached
 * and the request is not essential; otherwise counts it.
 */
function beforeRequest(label, { essential = false } = {}) {
  const u = getUsage();
  const limit = getLimit();
  if (limit > 0 && u.count >= limit && !essential) {
    u.refused += 1;
    if (!u.notified) {
      u.notified = true;
      const msg = `Tesla cloud request limit reached: ${u.count} billed requests today (limit ${limit}). `
        + `Further cloud requests are blocked until midnight. Commands over Bluetooth and Fleet `
        + `Telemetry are not affected. Something is calling the Fleet API far more than normal - `
        + `check the event log. First blocked request: ${label}.`;
      logger.logEvent('api_error', msg);
      try {
        require('./notifications')
          .sendNotification('WattSnatch: Tesla API limit reached', msg, 'high')
          .catch(() => {});
      } catch (_e) { /* notifications not configured */ }
    }
    _save(u);
    const err = new Error(`Tesla cloud daily request limit reached (${limit}) - blocked until midnight: ${label}`);
    err.wattsnatchBudgetBlocked = true;
    throw err;
  }
  u.count += 1;
  _save(u);
}

module.exports = {
  beforeRequest, getUsage, getLimit,
  DEFAULT_LIMIT_BLE_COMMANDS, DEFAULT_LIMIT_FLEET_COMMANDS, USAGE_KEY, LIMIT_KEY,
};
