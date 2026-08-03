/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Surfaces TLS certificate health in the app, so a failing renewal is visible
// instead of silent.
//
// The certificates matter because your car will not talk to a telemetry server
// it cannot verify. When one expires, or renews onto a chain the car has not
// been told to trust, fleet telemetry simply stops - the dashboard shows stale
// data and nothing anywhere reports an error. That is the failure this module
// exists to make impossible.
//
// `scripts/cert-renew.js` runs from a LaunchDaemon twice a day and writes
// cert-status.json. This module reads it and reports three distinct problems:
//
//   1. A certificate is failing to renew, or is close to expiry.
//   2. A renewal changed the issuer, so the CA chain pinned in your car no
//      longer matches and must be resent (see TELEMETRY.md section 10).
//   3. The status file is STALE or missing - meaning the renewal job itself
//      is not running. This is the quietest failure of the three and the one
//      most likely to go unnoticed, because everything looks fine right up
//      until the certificate expires.

const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../db');
const notifications = require('./notifications');

const CERT_STATUS_PATH = process.env.CERT_STATUS_PATH
  || path.join(os.homedir(), '.solarcharge', 'cert-status.json');

// The renewal job runs twice daily. Allowing 36 hours means it has to miss
// three consecutive runs before we complain, which keeps a single transient
// failure (a reboot, a brief network outage) from crying wolf.
const STALE_HOURS = 36;

// Re-send an unresolved alert at most once a day, so a problem that persists
// keeps reminding you without becoming noise you learn to swipe away.
const REALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly; expiry moves slowly
let _lastCheckAt = 0;

// /api/status is polled every few seconds by the dashboard, while this data
// changes twice a day. Cache it so the poll stays a no-op.
const CACHE_TTL_MS = 60 * 1000;
let _cache = null;
let _cachedAt = 0;

function readStatus() {
  try {
    const raw = fs.readFileSync(CERT_STATUS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// Returns a normalised view of certificate health for the API and the
// dashboard. Never throws - a monitoring feature that can take the app down
// is worse than the problem it monitors.
function getStatus() {
  if (_cache && Date.now() - _cachedAt < CACHE_TTL_MS) return _cache;

  const result = computeStatus();
  _cache = result;
  _cachedAt = Date.now();
  return result;
}

function computeStatus() {
  let status;
  try {
    status = readStatus();
  } catch (err) {
    status = null;
  }

  if (!status) {
    return {
      ok: false,
      severity: 'warning',
      stale: true,
      lastRunAt: null,
      problems: [{
        name: 'certificate renewal',
        message: 'No certificate renewal has been recorded. The renewal job may '
          + 'not be installed or running. See TELEMETRY.md section 10.',
      }],
      certs: [],
    };
  }

  const lastRunMs = Date.parse(status.lastRunCompletedAt || status.lastRunAt || '');
  const ageMs = Number.isFinite(lastRunMs) ? Date.now() - lastRunMs : Infinity;
  const stale = ageMs > STALE_HOURS * 3600 * 1000;

  const problems = Array.isArray(status.problems) ? status.problems.slice() : [];
  if (stale) {
    const hours = Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null;
    problems.push({
      name: 'certificate renewal',
      message: hours === null
        ? 'The certificate renewal job has no recorded run time.'
        : `The certificate renewal job has not run for ${hours} hours. `
          + 'Certificates will expire silently if this is not fixed.',
    });
  }

  // Soonest expiry across the certificates production actually depends on -
  // the single number worth putting in front of a human.
  const critical = (status.certs || []).filter(c => c.critical);
  const soonest = critical.reduce((min, c) => (
    typeof c.daysRemaining === 'number' && (min === null || c.daysRemaining < min)
      ? c.daysRemaining : min
  ), null);

  const ok = problems.length === 0;
  return {
    ok,
    severity: ok ? 'ok' : (stale || (soonest !== null && soonest <= 10) ? 'critical' : 'warning'),
    stale,
    lastRunAt: status.lastRunCompletedAt || status.lastRunAt || null,
    daysUntilSoonestExpiry: soonest,
    problems,
    certs: (status.certs || []).map(c => ({
      name: c.name,
      tree: c.tree,
      critical: !!c.critical,
      subject: c.subject,
      daysRemaining: c.daysRemaining,
      healthy: c.healthy !== false,
      message: c.message || null,
    })),
    unchecked: status.unchecked || [],
  };
}

// A stable fingerprint of the current problem set, so a persisting problem
// re-alerts on a daily cadence while a NEW problem alerts immediately.
function signatureOf(status) {
  return status.problems.map(p => `${p.name}:${p.message}`).sort().join('|');
}

async function checkAndNotify() {
  const now = Date.now();
  if (now - _lastCheckAt < CHECK_INTERVAL_MS) return;
  _lastCheckAt = now;

  let status;
  try {
    status = getStatus();
  } catch (err) {
    console.warn('[certMonitor] status check failed:', err.message);
    return;
  }

  if (status.ok) {
    // Clear the alert state so a recurrence notifies immediately rather than
    // being suppressed by the previous alert's 24-hour window.
    try {
      if (db.getSetting('cert_alert_signature')) {
        db.setSetting('cert_alert_signature', '');
        db.setSetting('cert_alert_last_sent_at', '');
      }
    } catch (err) { /* settings are best-effort */ }
    return;
  }

  const signature = signatureOf(status);
  let lastSignature = '';
  let lastSentAt = 0;
  try {
    lastSignature = db.getSetting('cert_alert_signature') || '';
    lastSentAt = Number(db.getSetting('cert_alert_last_sent_at') || 0);
  } catch (err) { /* fall through and notify */ }

  const isNew = signature !== lastSignature;
  const isDue = now - lastSentAt > REALERT_INTERVAL_MS;
  if (!isNew && !isDue) return;

  try {
    await notifications.notifyCertificateProblem(status);
    db.setSetting('cert_alert_signature', signature);
    db.setSetting('cert_alert_last_sent_at', String(now));
  } catch (err) {
    console.warn('[certMonitor] certificate notification failed:', err.message);
  }
}

module.exports = {
  getStatus,
  checkAndNotify,
  CERT_STATUS_PATH,
  STALE_HOURS,
};
