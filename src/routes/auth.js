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

// ── SolarEdge API V2 (OAuth 2.0) ──────────────────────────────────────────────
//
// The homeowner self-access flow: the site owner authorises their OWN site, so
// no installer-granted admin rights and no V1 API key are involved. Note the
// consent screen asks for mySolarEdge homeowner credentials, not the developer
// account's - they are frequently different people's logins on the same site.

function solaredgeRedirectUri(req) {
  return db.getSetting('solaredge_redirect_uri')
      || `${req.protocol}://${req.get('host')}/auth/solaredge/callback`;
}

// GET /auth/solaredge/start - redirect to the SolarEdge consent screen
router.get('/auth/solaredge/start', (req, res) => {
  try {
    if (!db.getSetting('solaredge_client_id') || !db.getSetting('solaredge_client_secret')) {
      return res.status(400).send('SolarEdge Client ID and Client Secret must be saved in Settings first.');
    }
    const state = require('crypto').randomBytes(16).toString('hex');
    db.setSetting('solaredge_oauth_state', state);
    // Also stamp the time: SolarEdge drops `state` on the way back (see the
    // callback), so this is what bounds how long a callback is accepted for.
    db.setSetting('solaredge_oauth_started_at', String(Date.now()));

    const url = require('../services/meters/solaredgeV2')
      .buildAuthorizeUrl(solaredgeRedirectUri(req), state);
    res.redirect(url);
  } catch (err) {
    logger.logEvent('api_error', `SolarEdge auth start failed: ${err.message}`);
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// GET /auth/solaredge/callback - exchange the code for the first token pair
router.get('/auth/solaredge/callback', async (req, res) => {
  try {
    const { code, state, site_id: siteId, error } = req.query;
    if (error) throw new Error(String(error));
    if (!code) throw new Error('No authorization code returned');

    // Reject a mismatched state: without this the callback would accept a code
    // obtained by anyone who can get the browser to hit this URL.
    // CSRF guard, as strong as SolarEdge allows.
    //
    // We send `state` on the authorize URL and their documentation shows it coming
    // back (`?code=...&site_id=12345&state=randomstring`), but it does not: the
    // callback carries only `code` and `site_id`. Verified against the live
    // service - the logged parameter list read exactly [code, site_id].
    //
    // So: verify `state` whenever it IS present, which keeps full protection and
    // starts working by itself if SolarEdge ever fixes this. When it is absent,
    // fall back to requiring that this server issued an authorize redirect in the
    // last few minutes, and consume that window here. Weaker, but it still means a
    // forged callback only lands if it arrives inside a window the user themselves
    // just opened - on a service that already listens on localhost behind a login.
    const expected  = db.getSetting('solaredge_oauth_state');
    const startedAt = parseInt(db.getSetting('solaredge_oauth_started_at') || '0', 10);
    const WINDOW_MS = 10 * 60 * 1000;

    if (state) {
      if (state !== expected) throw new Error('OAuth state mismatch - start the connection again');
    } else if (!startedAt || Date.now() - startedAt > WINDOW_MS) {
      throw new Error('No authorization was started from this server in the last 10 minutes - open /auth/solaredge/start and try again');
    }
    db.setSetting('solaredge_oauth_state', '');
    db.setSetting('solaredge_oauth_started_at', '0');

    const solaredgeV2 = require('../services/meters/solaredgeV2');
    await solaredgeV2.exchangeCode(String(code), solaredgeRedirectUri(req));

    // SolarEdge returns the authorised site on the callback, so the owner never
    // has to look their own site ID up by hand.
    if (siteId) db.setSetting('solaredge_site_id', String(siteId));
    db.setSetting('inverter_brand', 'solaredge_v2');

    logger.logEvent('token', `SolarEdge V2 authorised for site ${siteId || db.getSetting('solaredge_site_id')}`);
    res.redirect('/settings.html?solaredge_connected=1');
  } catch (err) {
    logger.logEvent('api_error', `SolarEdge OAuth callback failed: ${err.message}`);
    res.redirect('/settings.html?solaredge_error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
