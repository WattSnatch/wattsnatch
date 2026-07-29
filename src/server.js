/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const dbModule = require('./db');
const controller = require('./controller');
const myenergi = require('./services/myenergi');
const melcloud = require('./services/melcloud');
const baseline = require('./services/baseline');
const calendar = require('./services/calendar');
const tripPlanner = require('./services/tripPlanner');
const { startTokenScheduler, stopTokenScheduler } = require('./services/tokens');
const logger = require('./utils/logger');
const mqttPublisher = require('./services/mqttPublisher');
const mqttInput = require('./services/meters/mqttInput');
const ercotPricing = require('./services/ercotPricing');

const apiRouter = require('./routes/api');
const eventsRouter = require('./routes/events');
const embedRouter = require('./routes/embed');
const authRouter = require('./routes/auth');
const loginRouter = require('./routes/login');
const setupRouter = require('./routes/setup');
const drivesRouter = require('./routes/drives');
const { createSessionMiddleware, requireAuth } = require('./middleware/sessionAuth');
const billPoller = require('./services/billPoller');
const enphasePanels = require('./services/enphase-panels');
const dayReplay = require('./services/dayReplay');
const aiInsights    = require('./services/aiInsights');
const weatherGrid   = require('./services/weatherGrid');

const PORT = parseInt(process.env.PORT || '3001', 10);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

async function main() {
  // Init DB
  const db = dbModule.initDb();
  logger.setDb(dbModule);

  // Clean old data on startup
  dbModule.cleanOldData();

  const app = express();

  // Security headers. CSP is deliberately left off: the app relies heavily on
  // inline styles/scripts throughout, so a real CSP needs a broader refactor,
  // not a drive-by config change here. HSTS is off too - the primary use case
  // is plain HTTP on a home LAN (http://<local-ip>:3001), and HSTS would tell
  // browsers to force HTTPS on that origin, breaking LAN-only access for
  // anyone without a TLS-terminating reverse proxy in front. COEP/CORP are
  // off because the Drives page loads Leaflet + map tiles from unpkg/cartocdn
  // (neither sends CORP headers) and the embed feature is designed to be
  // iframed by other origins - both would silently break under the defaults.
  app.use(helmet({
    contentSecurityPolicy: false,
    hsts: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  app.use(express.json({ limit: '25mb' }));          // large enough for PDF base64
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  // Session middleware (must come before requireAuth and routes)
  app.use(createSessionMiddleware());

  // Login / logout routes - before requireAuth so they're always reachable
  app.use(loginRouter);

  // Embed routes - key-authenticated, must be before requireAuth
  app.use(embedRouter);

  // Auth gate - protects everything below except static assets and /login
  app.use(requireAuth);

  // Static files
  app.use(express.static(PUBLIC_DIR));

  // API routes
  app.use(apiRouter);
  app.use(eventsRouter);
  app.use(authRouter);
  app.use(setupRouter);
  app.use(drivesRouter);

  // Page routes
  const setupComplete = () => dbModule.getSetting('setup_complete') === 'true';

  app.get('/', (req, res) => {
    if (!setupComplete()) {
      return res.redirect('/setup');
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.get('/data', (req, res) => {
    if (!setupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(PUBLIC_DIR, 'history.html'));
  });
  app.get('/history', (req, res) => res.redirect('/data')); // legacy redirect

  app.get('/settings', (req, res) => {
    if (!setupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(PUBLIC_DIR, 'settings.html'));
  });

  app.get('/logs', (req, res) => {
    if (!setupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(PUBLIC_DIR, 'logs.html'));
  });

  app.get('/bills', (req, res) => {
    if (!setupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(PUBLIC_DIR, 'bills.html'));
  });

  app.get('/retailer', (req, res) => {
    if (!setupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(PUBLIC_DIR, 'retailer.html'));
  });

  app.get('/drives', (req, res) => {
    if (!setupComplete()) return res.redirect('/setup');
    res.sendFile(path.join(PUBLIC_DIR, 'drives.html'));
  });

  app.get('/setup', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'setup.html'));
  });

  // Start services
  startTokenScheduler();

  if (setupComplete()) {
    mqttPublisher.start();
    mqttInput.start();   // no-op unless MQTT is the active inverter provider and configured
    ercotPricing.start(); // no-op unless ercot_pricing_enabled and fully configured
    controller.start();
    myenergi.start();
    melcloud.start();
    baseline.start();
    billPoller.start();
    calendar.start();
    // Delay trip planner so the initial CalDAV fetch completes before the first assessment.
    // iCloud CalDAV can take 10-20s on a cold start, so 30s gives enough headroom.
    setTimeout(() => tripPlanner.start(), 30000);
    // Per-panel health monitoring is Enphase-specific (microinverter telemetry) -
    // other inverter brands don't expose this, so only start it when Enphase is active.
    if ((dbModule.getSetting('inverter_brand') || 'enphase') === 'enphase') {
      enphasePanels.start();
    }
    dayReplay.startAggregationTask();
    aiInsights.start();
    weatherGrid.start();

    // ── Daily notifications ───────────────────────────────────────────────────
    function scheduleDailyAt(h, m, label, fn) {
      const now    = new Date();
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      const msUntil = target.getTime() - now.getTime();
      setTimeout(async function fire() {
        try { await fn(); logger.logEvent('info', `[notifications] ${label} sent`); }
        catch (err) { logger.logEvent('api_error', `[notifications] ${label} failed: ${err.message}`); }
        setTimeout(fire, 24 * 60 * 60 * 1000);
      }, msUntil);
      logger.logEvent('info', `[notifications] ${label} scheduled for ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} AEST`);
    }

    const notifications = require('./services/notifications');
    scheduleDailyAt(0,  0, 'Midnight trip check', () => tripPlanner.runMidnightTripCheck());
    scheduleDailyAt(6, 30, 'Morning brief',        () => notifications.notifyMorningBrief());
    scheduleDailyAt(21, 0, 'Evening summary',      () => notifications.notifyEveningSummary());

    // ── Solcast auto-fetch (up to 4×/day, every 6 h) ───────────────────────
    async function autoFetchSolcast() {
      try {
        const apiKey    = dbModule.getSetting('solcast_api_key');
        const resourceId = dbModule.getSetting('solcast_resource_id');
        if (!apiKey || !resourceId) return;
        const solcast = require('./services/solcast');
        if (!solcast.canFetch()) return;
        await solcast.fetchForecast();
        console.log('[solcast] Auto-fetch complete');
      } catch (err) {
        console.error('[solcast] Auto-fetch failed:', err.message);
      }
    }
    // Fetch on startup, then every 12 hours (7-day window stays fresh with 2 fetches/day)
    autoFetchSolcast();
    setInterval(autoFetchSolcast, 12 * 60 * 60 * 1000);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WattSnatch] Listening on http://0.0.0.0:${PORT}`);
    logger.logEvent('info', `Server started on port ${PORT}`);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`[WattSnatch] ${signal} received - shutting down`);
    mqttPublisher.stop();
    mqttInput.stop();
    ercotPricing.stop();
    controller.stop();
    myenergi.stop();
    melcloud.stop();
    baseline.stop();
    billPoller.stop();
    calendar.stop();
    tripPlanner.stop();
    enphasePanels.stop();
    dayReplay.stopAggregationTask();
    aiInsights.stop();
    weatherGrid.stop();
    stopTokenScheduler();
    server.close(() => {
      try { db.close(); } catch (_e) {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[WattSnatch] Fatal startup error:', err);
  process.exit(1);
});
