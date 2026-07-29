/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express  = require('express');
const path     = require('path');
const router   = express.Router();
const db       = require('../db');
const {
  hashPassword, verifyPassword,
  checkLoginLockout, recordFailedLogin, recordSuccessfulLogin,
} = require('../middleware/sessionAuth');
const logger   = require('../utils/logger');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

// GET /login
router.get('/login', (req, res) => {
  const passwordHash = db.getSetting('login_password_hash');
  if (!passwordHash) return res.redirect('/');          // auth not yet configured
  if (req.session && req.session.authenticated) return res.redirect(sanitiseNext(req.query.next));
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// POST /login
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const passwordHash = db.getSetting('login_password_hash');

  if (!passwordHash) return res.redirect('/');

  const lockout = checkLoginLockout();
  if (lockout.locked) {
    const mins = Math.ceil(lockout.remainingMs / 60000);
    logger.logEvent('api_error', `Login blocked by lockout (${mins}m remaining) from ${req.ip}`);
    return res.redirect(`/login?error=locked&mins=${mins}`);
  }

  if (!password) return res.redirect('/login?error=1');

  const valid = await verifyPassword(password, passwordHash);
  if (!valid) {
    const { attempts, lockoutMs } = recordFailedLogin();
    logger.logEvent('api_error', `Failed login from ${req.ip} (attempt ${attempts})`);
    // Small delay to slow brute-force
    await new Promise(r => setTimeout(r, 500));
    if (lockoutMs > 0) {
      return res.redirect(`/login?error=locked&mins=${Math.ceil(lockoutMs / 60000)}`);
    }
    return res.redirect('/login?error=1');
  }

  recordSuccessfulLogin();
  req.session.authenticated = true;
  req.session.save(() => res.redirect(sanitiseNext(req.query.next)));
});

// GET /logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// POST /api/auth/change-password
router.post('/api/auth/change-password', async (req, res) => {
  const passwordHash = db.getSetting('login_password_hash');
  if (passwordHash && !(req.session && req.session.authenticated)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // If a password is already set, verify current one first
  if (passwordHash) {
    const valid = await verifyPassword(currentPassword || '', passwordHash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const hash = await hashPassword(newPassword);
  db.setSetting('login_password_hash', hash);
  logger.logEvent('info', 'Dashboard password changed');
  res.json({ ok: true });
});

// GET /api/auth/status - lets the frontend know if auth is active
router.get('/api/auth/status', (req, res) => {
  const authEnabled = !!db.getSetting('login_password_hash');
  res.json({ authEnabled, authenticated: authEnabled ? !!(req.session && req.session.authenticated) : true });
});

function sanitiseNext(next) {
  // Only allow relative paths to prevent open redirect
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

module.exports = router;
