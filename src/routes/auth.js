/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { exchangeCode, getAuthUrl } = require('../services/tesla');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

// GET /auth/tesla/start - redirect to Tesla OAuth
router.get('/auth/tesla/start', (req, res) => {
  try {
    const clientId = db.getSetting('tesla_client_id');
    const redirectUri = db.getSetting('tesla_redirect_uri');

    if (!clientId || !redirectUri) {
      return res.status(400).send('Tesla client ID and redirect URI must be configured in settings first.');
    }

    const state = require('crypto').randomBytes(16).toString('hex');
    db.setSetting('tesla_oauth_state', state);

    const authUrl = getAuthUrl(clientId, redirectUri, state);
    res.redirect(authUrl);
  } catch (err) {
    logger.logEvent('api_error', `Tesla auth start failed: ${err.message}`);
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// GET /auth/tesla/callback - OAuth callback
router.get('/auth/tesla/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      logger.logEvent('api_error', `Tesla OAuth error: ${error}`);
      return res.redirect('/setup?step=5&error=' + encodeURIComponent(error));
    }

    if (!code) {
      return res.redirect('/setup?step=5&error=no_code');
    }

    // Validate state
    const storedState = db.getSetting('tesla_oauth_state');
    if (storedState && state !== storedState) {
      logger.logEvent('api_error', 'Tesla OAuth state mismatch');
      return res.redirect('/setup?step=5&error=state_mismatch');
    }

    const clientId = db.getSetting('tesla_client_id');
    const clientSecret = db.getSetting('tesla_client_secret');
    const redirectUri = db.getSetting('tesla_redirect_uri');

    const tokens = await exchangeCode(code, clientId, clientSecret, redirectUri);

    const expiresAt = Date.now() + (tokens.expires_in || 28800) * 1000;
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    };

    const encryptedData = encrypt(JSON.stringify(tokenData));
    db.setToken('tesla', encryptedData, expiresAt, JSON.stringify({ authenticated: true }));

    logger.logEvent('token', 'Tesla OAuth tokens obtained and stored');

    // Fetch and store VIN list
    try {
      const { listVehicles } = require('../services/tesla');
      const vehicles = await listVehicles(tokens.access_token);
      if (vehicles.length > 0) {
        db.setSetting('tesla_vin', vehicles[0].vin);
        db.setSetting('tesla_display_name', vehicles[0].display_name);
        db.setToken('tesla', encryptedData, expiresAt,
          JSON.stringify({ vehicles, authenticated: true }));
      }
    } catch (vehicleErr) {
      logger.logEvent('api_error', `Failed to fetch vehicle list: ${vehicleErr.message}`);
    }

    res.redirect('/setup?step=6');
  } catch (err) {
    logger.logEvent('api_error', `Tesla OAuth callback failed: ${err.message}`);
    res.redirect('/setup?step=5&error=' + encodeURIComponent(err.message));
  }
});

// GET /auth/google-calendar/start - redirect to Google OAuth
router.get('/auth/google-calendar/start', (req, res) => {
  try {
    const redirectUri = db.getSetting('google_calendar_redirect_uri');
    if (!redirectUri) {
      return res.status(400).send('Google Calendar redirect URI must be configured in settings first.');
    }

    const state = require('crypto').randomBytes(16).toString('hex');
    db.setSetting('google_calendar_oauth_state', state);

    const { getAuthUrl } = require('../services/calendar/google');
    res.redirect(getAuthUrl(redirectUri, state));
  } catch (err) {
    logger.logEvent('api_error', `Google Calendar auth start failed: ${err.message}`);
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// GET /auth/google-calendar/callback - OAuth callback
router.get('/auth/google-calendar/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      logger.logEvent('api_error', `Google Calendar OAuth error: ${error}`);
      return res.redirect('/settings.html?calendar_error=' + encodeURIComponent(error));
    }
    if (!code) {
      return res.redirect('/settings.html?calendar_error=no_code');
    }

    const storedState = db.getSetting('google_calendar_oauth_state');
    if (storedState && state !== storedState) {
      logger.logEvent('api_error', 'Google Calendar OAuth state mismatch');
      return res.redirect('/settings.html?calendar_error=state_mismatch');
    }

    const redirectUri = db.getSetting('google_calendar_redirect_uri');
    const google = require('../services/calendar/google');
    await google.exchangeCode(code, redirectUri);

    db.setSetting('calendar_provider', 'google');
    require('../services/calendar').restart();

    logger.logEvent('token', 'Google Calendar OAuth tokens obtained and stored');
    res.redirect('/settings.html?calendar_connected=google');
  } catch (err) {
    logger.logEvent('api_error', `Google Calendar OAuth callback failed: ${err.message}`);
    res.redirect('/settings.html?calendar_error=' + encodeURIComponent(err.message));
  }
});

// GET /auth/outlook-calendar/start - redirect to Microsoft OAuth
router.get('/auth/outlook-calendar/start', (req, res) => {
  try {
    const redirectUri = db.getSetting('outlook_calendar_redirect_uri');
    if (!redirectUri) {
      return res.status(400).send('Outlook Calendar redirect URI must be configured in settings first.');
    }

    const state = require('crypto').randomBytes(16).toString('hex');
    db.setSetting('outlook_calendar_oauth_state', state);

    const { getAuthUrl } = require('../services/calendar/outlook');
    res.redirect(getAuthUrl(redirectUri, state));
  } catch (err) {
    logger.logEvent('api_error', `Outlook Calendar auth start failed: ${err.message}`);
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// GET /auth/outlook-calendar/callback - OAuth callback
router.get('/auth/outlook-calendar/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      logger.logEvent('api_error', `Outlook Calendar OAuth error: ${error} ${error_description || ''}`);
      return res.redirect('/settings.html?calendar_error=' + encodeURIComponent(error_description || error));
    }
    if (!code) {
      return res.redirect('/settings.html?calendar_error=no_code');
    }

    const storedState = db.getSetting('outlook_calendar_oauth_state');
    if (storedState && state !== storedState) {
      logger.logEvent('api_error', 'Outlook Calendar OAuth state mismatch');
      return res.redirect('/settings.html?calendar_error=state_mismatch');
    }

    const redirectUri = db.getSetting('outlook_calendar_redirect_uri');
    const outlook = require('../services/calendar/outlook');
    await outlook.exchangeCode(code, redirectUri);

    db.setSetting('calendar_provider', 'outlook');
    require('../services/calendar').restart();

    logger.logEvent('token', 'Outlook Calendar OAuth tokens obtained and stored');
    res.redirect('/settings.html?calendar_connected=outlook');
  } catch (err) {
    logger.logEvent('api_error', `Outlook Calendar OAuth callback failed: ${err.message}`);
    res.redirect('/settings.html?calendar_error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
