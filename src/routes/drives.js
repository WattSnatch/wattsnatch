/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express   = require('express');
const router    = express.Router();
const teslamate = require('../services/teslamate');

router.get('/api/drives', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const fromMs = req.query.from ? parseInt(req.query.from, 10) : null;
    const toMs   = req.query.to   ? parseInt(req.query.to,   10) : null;
    const result = await teslamate.getDrives({ page, limit, fromMs, toMs });
    if (!result) return res.status(503).json({ ok: false, error: 'TeslaMate unavailable' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/drives/stats', async (req, res) => {
  try {
    const fromMs = req.query.from ? parseInt(req.query.from, 10) : null;
    const toMs   = req.query.to   ? parseInt(req.query.to,   10) : null;
    const stats = await teslamate.getDriveStats({ fromMs, toMs });
    if (!stats) return res.status(503).json({ ok: false, error: 'TeslaMate unavailable' });
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/drives/:id/route', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid drive id' });
    const points = await teslamate.getDriveRoute(id);
    if (!points) return res.status(404).json({ ok: false, error: 'No route data' });
    res.json({ ok: true, points });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
