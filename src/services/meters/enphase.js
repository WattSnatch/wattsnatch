/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Thin adapter over the existing, untouched src/services/enphase.js - this file
// changes no Enphase behaviour, it just exposes it under the shared meter-provider shape.

const db = require('../../db');
const { decrypt } = require('../../utils/crypto');
const enphase = require('../enphase');

function _getJwt() {
  const row = db.getToken('enphase');
  if (!row) return null;
  try { return JSON.parse(decrypt(row.token_data)).jwt; } catch (_e) { return null; }
}

function isConfigured() {
  return !!(db.getSetting('gateway_ip') && db.getToken('enphase'));
}

async function fetchReadings() {
  const gatewayIp = db.getSetting('gateway_ip');
  const jwt = _getJwt();
  if (!gatewayIp) throw new Error('Enphase gateway IP not configured');
  if (!jwt) throw new Error('Enphase JWT not configured');
  return enphase.fetchMeterReadings(gatewayIp, jwt);
}

async function testConnection() {
  try {
    const readings = await fetchReadings();
    return { ok: true, readings };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Called by controller.js when fetchReadings() throws, so provider-specific auth-refresh
// logic (e.g. Enphase's JWT expiry) stays isolated in the adapter rather than in the
// shared control loop. Return true if the error was handled (e.g. a refresh was triggered).
function handleFetchError(err) {
  if (err.code === 'ENPHASE_JWT_EXPIRED') {
    const logger = require('../../utils/logger');
    logger.logEvent('api_error', 'Enphase JWT expired - token renewal needed');
    const { checkAndRenewTokens } = require('../tokens');
    checkAndRenewTokens().catch(() => {});
    return true;
  }
  return false;
}

module.exports = {
  id: 'enphase',
  label: 'Enphase IQ Gateway',
  authType: 'cloud-token',
  supportsPanelHealth: true,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
};
