/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { generateGatewayToken } = require('./enphase');
const { refreshAccessToken } = require('./tesla');
const logger = require('../utils/logger');

let schedulerInterval = null;

/**
 * Check and renew tokens if needed.
 */
async function checkAndRenewTokens() {
  await checkEnphaseToken();
  await checkTeslaToken();
}

async function checkEnphaseToken() {
  try {
    const row = db.getToken('enphase');
    if (!row) return;

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    if (!row.expires_at || row.expires_at - nowMs > sevenDaysMs) {
      // Not expiring soon
      return;
    }

    logger.logEvent('token', 'Enphase JWT expiring within 7 days - attempting renewal', null, null);

    // We need email + password to renew. Password is never stored.
    // Check if we have a stored email
    const email = db.getSetting('enphase_email');
    if (!email) {
      logger.logEvent('token', 'Cannot renew Enphase JWT - no email stored', null, null);
      return;
    }

    logger.logEvent('token', 'Enphase JWT renewal requires re-authentication via setup page', null, null);
  } catch (err) {
    logger.logEvent('api_error', `Enphase token check failed: ${err.message}`, null, null);
  }
}

async function checkTeslaToken() {
  try {
    const row = db.getToken('tesla');
    if (!row) return;

    let tokenData;
    try {
      tokenData = JSON.parse(decrypt(row.token_data));
    } catch (_err) {
      logger.logEvent('api_error', 'Failed to decrypt Tesla token data', null, null);
      return;
    }

    const tenMinutesMs = 10 * 60 * 1000;
    const nowMs = Date.now();

    // expires_at in DB is stored as ms timestamp
    const expiresAt = row.expires_at;
    if (!expiresAt || expiresAt - nowMs > tenMinutesMs) {
      return;
    }

    logger.logEvent('token', 'Tesla access token expiring in <10 min - refreshing', null, null);

    const clientId = db.getSetting('tesla_client_id');
    const clientSecret = db.getSetting('tesla_client_secret');

    if (!clientId || !clientSecret) {
      logger.logEvent('api_error', 'Cannot refresh Tesla token - no client credentials', null, null);
      return;
    }

    const refreshed = await refreshAccessToken(tokenData.refresh_token, clientId, clientSecret);

    const newExpiry = Date.now() + (refreshed.expires_in || 28800) * 1000;
    const newTokenData = {
      ...tokenData,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || tokenData.refresh_token,
    };

    const encryptedData = encrypt(JSON.stringify(newTokenData));
    db.setToken('tesla', encryptedData, newExpiry, row.account_info);

    logger.logEvent('token', 'Tesla access token refreshed successfully', null, null);
  } catch (err) {
    logger.logEvent('api_error', `Tesla token refresh failed: ${err.message}`, null, null);
  }
}

/**
 * Start the token renewal scheduler (checks every hour).
 */
function startTokenScheduler() {
  if (schedulerInterval) return;

  // Run immediately on startup
  checkAndRenewTokens().catch((err) => {
    console.error('[tokens] Startup check failed:', err.message);
  });

  // Then every hour
  schedulerInterval = setInterval(() => {
    checkAndRenewTokens().catch((err) => {
      console.error('[tokens] Scheduled check failed:', err.message);
    });
  }, 60 * 60 * 1000);
}

function stopTokenScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

module.exports = { startTokenScheduler, stopTokenScheduler, checkAndRenewTokens };
