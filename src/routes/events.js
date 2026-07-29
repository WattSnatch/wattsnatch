/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const controller = require('../controller');

// GET /api/events - SSE endpoint
router.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial connected message
  res.write('data: {"type":"connected"}\n\n');

  // Keep-alive ping every 30 seconds
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_err) {
      clearInterval(keepAlive);
    }
  }, 30000);

  controller.addSSEClient(res);

  req.on('close', () => {
    clearInterval(keepAlive);
    controller.removeSSEClient(res);
  });
});

module.exports = router;
