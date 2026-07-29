/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express    = require('express');
const path       = require('path');
const router     = express.Router();
const db         = require('../db');
const controller = require('../controller');

function checkKey(req, res) {
  const key = db.getSetting('ha_link_key');
  if (!key || req.query.key !== key) {
    res.status(403).send('Forbidden');
    return false;
  }
  return true;
}

// Serve the embed flow page (key-authenticated, iframe-safe)
router.get('/embed/flow', (req, res) => {
  if (!checkKey(req, res)) return;
  res.removeHeader('X-Frame-Options');
  res.sendFile(path.join(__dirname, '../../public/embed.html'));
});

// SSE stream for the embed page (key-authenticated, no session required)
router.get('/embed/events', (req, res) => {
  if (!checkKey(req, res)) return;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write('data: {"type":"connected"}\n\n');

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 30000);

  controller.addSSEClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    controller.removeSSEClient(res);
  });
});

// Today's cumulative kWh totals (key-authenticated, same data as /api/today/node-totals)
router.get('/embed/today', (req, res) => {
  if (!checkKey(req, res)) return;
  try {
    const now        = Date.now();
    const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
    const todayStr   = new Date().toLocaleDateString('en-AU');
    const bDate      = db.getSetting('enphase_energy_baseline_date') || '';
    const bWh        = parseFloat(db.getSetting('enphase_energy_baseline_wh') || '0');
    const cWh        = parseFloat(db.getSetting('enphase_energy_current_wh')  || '0');
    const solarKwh   = bDate === todayStr
      ? Math.max(0, cWh - bWh) / 1000
      : (db.getTodayStats()?.solar?.solar_kwh || 0);
    const todayStats    = db.getTodayStats();
    const gridImportKwh = todayStats?.solar?.grid_import_kwh || 0;
    const gridExportKwh = todayStats?.solar?.grid_export_kwh || 0;
    const ev    = db.getPeriodStats(todayStart, now);
    const hw    = db.getEddiPeriodStats(todayStart, now);
    const house = db.getHousePeriodStats(todayStart, now);
    res.json({
      ok: true,
      solar_kwh:       Math.round(solarKwh             * 100) / 100,
      grid_import_kwh: Math.round(gridImportKwh         * 100) / 100,
      grid_export_kwh: Math.round(gridExportKwh         * 100) / 100,
      ev_kwh:          Math.round((ev.total_kwh    || 0) * 100) / 100,
      hw_kwh:          Math.round((hw.total_kwh    || 0) * 100) / 100,
      house_kwh:       Math.round((house.house_kwh || 0) * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
