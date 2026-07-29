/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const db       = require('../db');

// Static asset extensions that are always public (login page needs CSS/JS)
const PUBLIC_EXTS = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.webp', '.gif',
]);

function isStaticAsset(pathname) {
  const dot = pathname.lastIndexOf('.');
  return dot !== -1 && PUBLIC_EXTS.has(pathname.slice(dot).toLowerCase());
}

// Paths always allowed through regardless of auth state
// '/api/car/location' is public-path but self-guards with a shared secret key (ha_link_key)
const PUBLIC_PATHS = new Set(['/login', '/logout', '/setup', '/health', '/api/auth/status', '/api/car/location', '/embed/flow', '/embed/events', '/embed/today']);

function createSessionMiddleware() {
  let secret = db.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    db.setSetting('session_secret', secret);
  }
  return session({
    secret,
    resave: false,
    saveUninitialized: false,
    name: 'ws.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      // secure:false - Cloudflare terminates TLS; app runs on plain localhost
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}

function requireAuth(req, res, next) {
  const passwordHash = db.getSetting('login_password_hash');
  // Auth not configured - allow through so the app still works on LAN
  if (!passwordHash) return next();

  // Always allow static assets and public paths
  if (isStaticAsset(req.path) || PUBLIC_PATHS.has(req.path)) return next();

  // Authenticated session
  if (req.session && req.session.authenticated) return next();

  // API / SSE → return 401 JSON so the frontend can handle it
  if (req.path.startsWith('/api/') || req.path.startsWith('/events')) {
    return res.status(401).json({ error: 'Unauthorized', redirect: '/login' });
  }

  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, 12);
}

async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

// ─── Login lockout ────────────────────────────────────────────────────────
// A global (not per-IP) counter is deliberate: this app has exactly one
// password, so an attacker spreading attempts across IPs to dodge a
// per-IP limit shouldn't get more tries than someone hammering from one.
// Persisted in the settings table (not in-memory) so a restart mid-attack
// doesn't reset the counter.

function getLockoutMs(failedAttempts) {
  if (failedAttempts < 5)  return 0;
  if (failedAttempts < 8)  return 30 * 1000;        // 30s after attempts 5-7
  if (failedAttempts < 12) return 5 * 60 * 1000;    // 5 min after attempts 8-11
  return 30 * 60 * 1000;                            // 30 min after attempt 12+
}

function checkLoginLockout() {
  const lockedUntil = parseInt(db.getSetting('login_locked_until') || '0', 10);
  const remainingMs = lockedUntil - Date.now();
  return remainingMs > 0 ? { locked: true, remainingMs } : { locked: false, remainingMs: 0 };
}

function recordFailedLogin() {
  const attempts = parseInt(db.getSetting('login_failed_attempts') || '0', 10) + 1;
  db.setSetting('login_failed_attempts', String(attempts));
  const lockoutMs = getLockoutMs(attempts);
  if (lockoutMs > 0) db.setSetting('login_locked_until', String(Date.now() + lockoutMs));
  return { attempts, lockoutMs };
}

function recordSuccessfulLogin() {
  db.setSetting('login_failed_attempts', '0');
  db.setSetting('login_locked_until', '0');
}

module.exports = {
  createSessionMiddleware, requireAuth, hashPassword, verifyPassword,
  checkLoginLockout, recordFailedLogin, recordSuccessfulLogin,
};
