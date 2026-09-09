/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const db = require('../db');
const { testGatewayConnection, discoverGateway, generateGatewayToken, fetchMeterReadings } = require('../services/enphase');
const { generateKeyPair, listVehicles, getPartnerToken, registerPartnerAccount, getUserRegion, getRegisteredPublicKey } = require('../services/tesla');

// Tesla's partner_accounts/public_key endpoint returns the raw uncompressed EC point as hex
// (e.g. "0474661d..."). Extract the same 65-byte point from our local PEM so the two can be
// compared directly - this is what lets the wizard confirm Tesla holds our actual key.
function _localPublicKeyHex(appDir) {
  try {
    const pem = fs.readFileSync(path.join(appDir, 'keys', 'public.pem'), 'utf8');
    const der = require('crypto').createPublicKey(pem).export({ type: 'spki', format: 'der' });
    // For prime256v1 SPKI the trailing 65 bytes are 0x04 || X || Y.
    return der.subarray(der.length - 65).toString('hex');
  } catch (_e) {
    return null;
  }
}
const { encrypt } = require('../utils/crypto');
const { installPlists, getServiceStatus: getLaunchdStatus } = require('../utils/launchd');
const { installUnits, getServiceStatus: getSystemdStatus } = require('../utils/systemd');
const logger = require('../utils/logger');
const meters = require('../services/meters');
const battery = require('../services/battery');

const APP_DIR = path.resolve(__dirname, '../../');

// GET /api/setup/inverter-brands - list available meter providers for the setup wizard / settings
router.get('/api/setup/inverter-brands', (req, res) => {
  res.json({ ok: true, brands: meters.listProviders() });
});

// POST /api/setup/test-inverter - generic test-connection for the currently-selected brand
// (brand-specific fields, e.g. fronius_ip or solaredge_api_key, must already be saved via
// POST /api/settings before calling this - same pattern as the Enphase test-gateway route).
router.post('/api/setup/test-inverter', async (req, res) => {
  try {
    const { brand } = req.body;
    const provider = meters.getProvider(brand || db.getSetting('inverter_brand') || 'enphase');
    if (!provider) return res.json({ ok: false, error: `Unknown inverter brand: ${brand}` });
    const result = await provider.testConnection();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/battery-brands - list available battery providers for Settings
router.get('/api/setup/battery-brands', (req, res) => {
  res.json({ ok: true, brands: battery.listProviders() });
});

// POST /api/setup/test-battery - generic test-connection for the currently-selected
// battery brand (brand-specific fields must already be saved via POST /api/settings first).
router.post('/api/setup/test-battery', async (req, res) => {
  try {
    const { brand } = req.body;
    const provider = battery.getProvider(brand || db.getSetting('battery_brand') || 'none');
    if (!provider) return res.json({ ok: false, error: `Unknown battery brand: ${brand}` });
    const result = await provider.testConnection();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/test-gateway
router.post('/api/setup/test-gateway', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ ok: false, error: 'ip required' });
    const result = await testGatewayConnection(ip);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/discover-gateway
router.post('/api/setup/discover-gateway', async (req, res) => {
  try {
    const ip = await discoverGateway();
    res.json({ ok: true, ip });
  } catch (err) {
    res.json({ ok: false, ip: null, error: err.message });
  }
});

// POST /api/setup/generate-token
router.post('/api/setup/generate-token', async (req, res) => {
  try {
    const { email, password, serial, ip } = req.body;
    if (!email || !password || !serial) {
      return res.status(400).json({ ok: false, error: 'email, password, serial required' });
    }

    const { jwt, expiresAt } = await generateGatewayToken(email, password, serial);

    // Store encrypted JWT (password NOT stored)
    const tokenData = encrypt(JSON.stringify({ jwt }));
    db.setToken('enphase', tokenData, expiresAt, JSON.stringify({ email, serial }));

    // Save settings
    db.setSetting('enphase_email', email);
    db.setSetting('enphase_serial', serial);
    if (ip) db.setSetting('gateway_ip', ip);

    logger.logEvent('token', `Enphase JWT generated, expires ${new Date(expiresAt).toISOString()}`);

    res.json({ ok: true, expiresAt });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/test-connection
router.post('/api/setup/test-connection', async (req, res) => {
  try {
    const gatewayIp = db.getSetting('gateway_ip');
    const tokenRow = db.getToken('enphase');
    if (!gatewayIp || !tokenRow) {
      return res.json({ ok: false, error: 'Enphase not configured' });
    }

    const { decrypt } = require('../utils/crypto');
    const tokenData = JSON.parse(decrypt(tokenRow.token_data));
    const readings = await fetchMeterReadings(gatewayIp, tokenData.jwt);

    res.json({ ok: true, readings });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/register-partner - one-time Tesla partner account registration
router.post('/api/setup/register-partner', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.json({ ok: false, error: 'domain required' });

    const clientId = db.getSetting('tesla_client_id');
    const clientSecret = db.getSetting('tesla_client_secret');
    if (!clientId || !clientSecret) {
      return res.json({ ok: false, error: 'Tesla client credentials not saved - go back to step 4' });
    }

    // Confirm the account's real Fleet region from Tesla rather than assuming 'na', so the
    // partner token audience and the registration call both target the region the vehicle
    // actually lives in. Best-effort: needs the user OAuth token (present once "Authorise with
    // Tesla" is done). If it is missing or the lookup fails, keep the current region.
    try {
      const tokenRow = db.getToken('tesla');
      if (tokenRow) {
        const { decrypt } = require('../utils/crypto');
        const userToken = JSON.parse(decrypt(tokenRow.token_data)).access_token;
        const { region } = await getUserRegion(userToken);
        if (region && region !== db.getSetting('tesla_region')) {
          logger.logEvent('info', `Tesla region corrected from account lookup: ${db.getSetting('tesla_region') || 'na'} -> ${region}`);
        }
        if (region) db.setSetting('tesla_region', region);
      }
    } catch (e) {
      logger.logEvent('info', `Tesla region auto-detect skipped: ${e.message}`);
    }

    const partnerTokenData = await getPartnerToken(clientId, clientSecret);
    const cleanDomain = domain.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    await registerPartnerAccount(partnerTokenData.access_token, cleanDomain);

    db.setSetting('tesla_partner_registered', 'true');
    db.setSetting('tesla_public_key_url', domain);
    logger.logEvent('info', `Tesla partner account registered for domain: ${cleanDomain}`);

    // Verify against Tesla itself: does Tesla actually hold a key for this domain, and does it
    // match ours? Previously this needed a manual curl (issue #17) - now the wizard can say
    // outright whether registration truly landed, instead of inferring it from a 200.
    let registrationVerified = null;
    let teslaHasKey = null;
    try {
      const teslaKey = await getRegisteredPublicKey(partnerTokenData.access_token, cleanDomain);
      teslaHasKey = teslaKey != null;
      if (teslaKey) {
        const localHex = _localPublicKeyHex(APP_DIR);
        registrationVerified = localHex ? (teslaKey.toLowerCase() === localHex.toLowerCase()) : null;
      } else {
        registrationVerified = false;
      }
      logger.logEvent('info',
        `Tesla registration check: Tesla ${teslaHasKey ? 'has' : 'has NO'} key for ${cleanDomain}`
        + (registrationVerified === null ? '' : `, matches local key: ${registrationVerified}`));
    } catch (_e) { /* verification is a bonus signal, never a gate on success */ }

    res.json({ ok: true, region: db.getSetting('tesla_region') || 'na', teslaHasKey, registrationVerified });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/fetch-vehicles - retry vehicle list using stored token
router.get('/api/setup/fetch-vehicles', async (req, res) => {
  try {
    const tokenRow = db.getToken('tesla');
    if (!tokenRow) return res.json({ ok: false, error: 'Tesla not authenticated - go back to step 4' });

    const { decrypt } = require('../utils/crypto');
    const tokenData = JSON.parse(decrypt(tokenRow.token_data));
    const accessToken = tokenData.access_token;

    const vehicles = await listVehicles(accessToken);

    if (vehicles.length === 0) {
      return res.json({ ok: false, error: 'No vehicles found on this Tesla account' });
    }

    db.setSetting('tesla_vin', vehicles[0].vin);
    db.setSetting('tesla_display_name', vehicles[0].display_name || vehicles[0].vin);
    db.setToken('tesla', tokenRow.token_data, tokenRow.expires_at,
      JSON.stringify({ vehicles, authenticated: true }));

    res.json({ ok: true, vehicles });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/public-key
router.get('/api/setup/public-key', (req, res) => {
  try {
    const keysDir = path.join(APP_DIR, 'keys');
    const publicKeyPath = path.join(keysDir, 'public.pem');

    if (!fs.existsSync(publicKeyPath)) {
      // Generate new key pair
      const result = generateKeyPair(APP_DIR);
      return res.json({ ok: true, publicKey: result.publicKey, generated: true });
    }

    const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    res.json({ ok: true, publicKey, generated: false });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/verify-key-url
router.post('/api/setup/verify-key-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });

    // Tesla always fetches the key from the domain root, not from any path below
    // it, so verify exactly where Tesla will look. Appending to a path-bearing
    // URL would pass here and still 404 for Tesla.
    let origin;
    let hadPath = false;
    try {
      const supplied = new URL(url.includes('://') ? url : `https://${url}`);
      origin = supplied.origin;
      hadPath = supplied.pathname.replace(/\/$/, '') !== '';
    } catch {
      return res.json({ ok: false, error: `Could not parse "${url}" as a URL` });
    }

    const keyUrl = `${origin}/.well-known/appspecific/com.tesla.3p.public-key.pem`;

    // Fetch the key from the URL
    const fetched = await new Promise((resolve, reject) => {
      const parsed = new URL(keyUrl);
      const req = https.request({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname,
        method: 'GET',
        timeout: 10000,
      }, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });

    if (fetched.status !== 200) {
      const pathHint = hadPath
        ? ` Tesla reads the key from the domain root, so a GitHub Pages project`
          + ` site cannot serve it - the repository must be named`
          + ` USERNAME.github.io so the key sits at ${origin}/.well-known/...`
        : '';
      return res.json({
        ok: false,
        error: `${keyUrl} returned status ${fetched.status}.${pathHint}`,
      });
    }

    // Compare with stored key
    const publicKeyPath = path.join(APP_DIR, 'keys', 'public.pem');
    if (!fs.existsSync(publicKeyPath)) {
      return res.json({ ok: false, error: 'No local public key found' });
    }

    const localKey = fs.readFileSync(publicKeyPath, 'utf8')
      .replace(/\r\n/g, '\n').trim();
    const remoteKey = fetched.body.replace(/\r\n/g, '\n').trim();

    const match = localKey === remoteKey;
    res.json({ ok: match, match, error: match ? null : 'Keys do not match' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/install-service
// macOS -> launchd (per-user LaunchAgent). Linux (Raspberry Pi etc.) -> systemd
// (system-level unit, so it starts on power-on with no one logged in).
router.post('/api/setup/install-service', (req, res) => {
  try {
    // Skip installing the Fleet-signing tesla-http-proxy service when the user has chosen
    // Bluetooth LE for both command delivery and vehicle state, or the OCPP charging
    // backend entirely - that binary is never invoked in either case and usually hasn't
    // even been built.
    const fullyBle = db.getSetting('tesla_command_backend') === 'ble'
                   && db.getSetting('tesla_state_source') === 'ble';
    const skipTeslaProxy = fullyBle || db.getSetting('charging_backend') === 'ocpp';
    const username = process.env.USER || require('os').userInfo().username;
    if (process.platform === 'linux') {
      const result = installUnits(APP_DIR, username, !skipTeslaProxy);
      logger.logEvent('info', `systemd units installed: ${result.appUnitPath}`);
      res.json({ ok: true, ...result });
    } else {
      const result = installPlists(APP_DIR, username, !skipTeslaProxy);
      logger.logEvent('info', `LaunchAgents installed: ${result.appPlistPath}`);
      res.json({ ok: true, ...result });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/service-status
router.get('/api/setup/service-status', (req, res) => {
  try {
    const username = process.env.USER || require('os').userInfo().username;
    const status = process.platform === 'linux' ? getSystemdStatus() : getLaunchdStatus(username);
    res.json({ ok: true, status });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/send-telemetry-config
// Sends fleet_telemetry_config to Tesla via the local proxy using stored credentials.
router.post('/api/setup/send-telemetry-config', async (req, res) => {
  try {
    // Shared with the automatic health monitor (services/telemetryHealth) so the wizard and
    // the auto-repair path build and send byte-identical configs.
    const telemetryHealth = require('../services/telemetryHealth');
    const result = await telemetryHealth.sendConfig();
    if (result.error) return res.json({ ok: false, error: result.error });
    res.json({ ok: result.ok, status: result.status, response: result.response });
  } catch (err) {
    logger.logEvent('error', `fleet_telemetry_config failed: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/complete
router.post('/api/setup/complete', (req, res) => {
  try {
    db.setSetting('setup_complete', 'true');
    logger.logEvent('info', 'Setup wizard completed');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/setup/melcloud-credentials - validate then save MELCloud email/password to Keychain.
// Actually logs in synchronously before reporting success - previously this saved
// credentials and restarted the poller unconditionally, so a wrong password (or,
// as happened in practice, an account on Mitsubishi's separate AU/NZ MelView
// platform rather than MELCloud) would report "success" and only fail silently
// on the next 60s poll cycle.
router.post('/api/setup/melcloud-credentials', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password required' });
    }

    const melcloud = require('../services/melcloud');
    await melcloud.setCredentials(email, password);

    const test = await melcloud.testConnection();
    if (!test.ok) {
      return res.json({ ok: false, error: test.error });
    }

    db.setSetting('melcloud_email', email);
    db.setSetting('melcloud_configured', '1');
    db.setSetting('ac_brand', 'melcloud');
    melcloud.restart();

    logger.logEvent('info', `MELCloud credentials configured (${test.devices.length} device(s) found)`);
    res.json({ ok: true, deviceCount: test.devices.length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/melview-credentials - validate then save MelView (AU/NZ "Wi-Fi
// Control") email/password to Keychain. Same validate-before-save pattern as
// the MELCloud route above.
router.post('/api/setup/melview-credentials', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'email and password required' });
    }

    const melview = require('../services/melview');
    await melview.setCredentials(email, password);

    const test = await melview.testConnection();
    if (!test.ok) {
      return res.json({ ok: false, error: test.error });
    }

    db.setSetting('melview_email', email);
    db.setSetting('melview_configured', '1');
    db.setSetting('ac_brand', 'melview');
    melview.restart();

    logger.logEvent('info', `MelView credentials configured (${test.devices.length} device(s) found)`);
    res.json({ ok: true, deviceCount: test.devices.length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/melview-status - check if MelView is configured
router.get('/api/setup/melview-status', (req, res) => {
  try {
    const melview = require('../services/melview');
    const isConfigured = melview.isConfigured();
    const state = isConfigured ? melview.getState() : null;

    res.json({
      ok: true,
      configured: isConfigured,
      deviceCount: state ? state.devices.length : 0,
      devices: state ? state.devices : [],
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/melcloud-status - check if MELCloud is configured
router.get('/api/setup/melcloud-status', (req, res) => {
  try {
    const melcloud = require('../services/melcloud');
    const isConfigured = melcloud.isConfigured();
    const state = isConfigured ? melcloud.getState() : null;

    res.json({
      ok: true,
      configured: isConfigured,
      deviceCount: state ? state.devices.length : 0,
      devices: state ? state.devices : [],
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/ical-credentials - save iCloud app-specific password to Keychain
router.post('/api/setup/ical-credentials', async (req, res) => {
  try {
    const { username, password, calendars } = req.body;
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Apple ID email and app-specific password required' });
    }

    const calendar = require('../services/calendar');
    await calendar.setCredentials(username, password);

    if (calendars !== undefined) {
      db.setSetting('ical_calendars', String(calendars));
    }

    calendar.restart();
    logger.logEvent('info', 'iCloud Calendar credentials configured');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/ical-status - check iCloud calendar configuration
router.get('/api/setup/ical-status', (req, res) => {
  try {
    const calendar = require('../services/calendar');
    const isConfigured = calendar.isConfigured();
    const state = isConfigured ? calendar.getState() : null;

    res.json({
      ok: true,
      configured: isConfigured,
      username: db.getSetting('ical_username') || null,
      calendars: db.getSetting('ical_calendars') || '',
      tripCount: state ? state.trips.length : 0,
      lastFetched: state ? state.lastFetched : null,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/calendar/providers - list all calendar providers and which is active
router.get('/api/setup/calendar/providers', (req, res) => {
  try {
    const calendarProviders = require('../services/calendar/index.js');
    res.json({
      ok: true,
      active: db.getSetting('calendar_provider') || 'icloud',
      providers: calendarProviders.listProviders(),
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/calendar/select - switch the active calendar provider
router.post('/api/setup/calendar/select', (req, res) => {
  try {
    const { provider } = req.body;
    const calendarProviders = require('../services/calendar/index.js');
    if (!calendarProviders.getProvider(provider)) {
      return res.status(400).json({ ok: false, error: `Unknown calendar provider: ${provider}` });
    }
    db.setSetting('calendar_provider', provider);
    require('../services/calendar').restart();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/setup/calendar/status - status for whichever calendar provider is currently active
router.get('/api/setup/calendar/status', (req, res) => {
  try {
    const calendar = require('../services/calendar');
    const calendarProviders = require('../services/calendar/index.js');
    const provider = calendarProviders.getActiveProvider();
    const isConfigured = provider.isConfigured();
    const state = isConfigured ? calendar.getState() : null;

    res.json({
      ok: true,
      provider: provider.id,
      label: provider.label,
      configured: isConfigured,
      tripCount: state ? state.trips.length : 0,
      lastFetched: state ? state.lastFetched : null,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/google-calendar/disconnect
router.post('/api/setup/google-calendar/disconnect', (req, res) => {
  try {
    require('../services/calendar/google').disconnect();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/setup/outlook-calendar/disconnect
router.post('/api/setup/outlook-calendar/disconnect', (req, res) => {
  try {
    require('../services/calendar/outlook').disconnect();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
