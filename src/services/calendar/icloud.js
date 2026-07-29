/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../../db');
const logger = require('../../utils/logger');

let keytar = null;
try { keytar = require('keytar'); } catch (_) {}

const KEYTAR_SERVICE = 'WattSnatch';
const KEYTAR_ACCOUNT_USER = 'ical_username';
const KEYTAR_ACCOUNT_PASS = 'ical_password';

// ── Credential management ─────────────────────────────────────────────────────

function isConfigured() {
  return db.getSetting('ical_configured') === '1';
}

async function setCredentials(username, password) {
  if (!keytar) throw new Error('keytar not available - cannot store iCloud credentials securely');
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_USER, username);
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_PASS, password);
  db.setSetting('ical_username', username);
  db.setSetting('ical_configured', '1');
}

async function getCredentials() {
  if (!keytar) return null;
  try {
    const username = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_USER);
    const password = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT_PASS);
    if (!username || !password) return null;
    return { username, password };
  } catch (err) {
    logger.logEvent('warn', `[calendar/icloud] keytar read failed: ${err.message}`);
    return null;
  }
}

// ── iCal parsing ──────────────────────────────────────────────────────────────

// Unfold iCal line continuations (CRLF followed by whitespace)
function unfoldIcal(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseVevent(veventStr) {
  const unfolded = unfoldIcal(veventStr);

  const get = (key) => {
    // Match "KEY" or "KEY;PARAMS" at start of line
    const m = unfolded.match(new RegExp(`^${key}(?:;[^:\\n]*)? *:([^\\n]*)`, 'mi'));
    return m ? m[1].trim() : null;
  };

  const summary = get('SUMMARY');
  // Unescape iCal text sequences (\n → space, \, → ,) and collapse whitespace
  const rawLocation = get('LOCATION');
  const location = rawLocation
    ? rawLocation.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\s{2,}/g, ' ').trim()
    : null;

  const dtstartRaw = get('DTSTART');
  const isAllDay = dtstartRaw ? (!dtstartRaw.includes('T')) : true;

  // Parse datetime value from DTSTART
  let startDate = null;
  if (dtstartRaw && !isAllDay) {
    try {
      // Strip non-digit/T/Z chars, handle formats: 20260608T090000 / 20260608T090000Z
      const digits = dtstartRaw.replace(/[^0-9TZ]/g, '');
      const m = digits.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
      if (m) {
        const [, y, mo, d, h, mi, s, z] = m;
        // Treat as local time (z flag ignored - we just need approximate ordering)
        startDate = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
        if (isNaN(startDate.getTime())) startDate = null;
      }
    } catch (_) {}
  }

  // Parse DTEND first so duration is known before RRULE advances dates
  const dtendRaw = get('DTEND');
  let endDate = null;
  if (dtendRaw && dtendRaw.includes('T')) {
    try {
      const digits = dtendRaw.replace(/[^0-9TZ]/g, '');
      const m = digits.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
      if (m) {
        const [, y, mo, d, h, mi, s] = m;
        endDate = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
        if (isNaN(endDate.getTime())) endDate = null;
      }
    } catch (_) {}
  }

  // Parse EXDATE values - deleted occurrences of recurring events.
  // iCloud records single-occurrence deletions as EXDATE on the master VEVENT.
  // Values may be comma-separated; strip timezone/params to get bare datetime strings.
  const exdateTimes = new Set();
  for (const match of unfolded.matchAll(/^EXDATE(?:;[^:\n]*)?:([^\n]+)/gim)) {
    for (const val of match[1].split(',')) {
      exdateTimes.add(val.trim().replace(/[^0-9T]/g, ''));
    }
  }

  // Advance a recurring event's startDate to the next upcoming occurrence using RRULE.
  // iCloud often returns the master VEVENT with the original DTSTART rather than expanding
  // occurrences for the requested time range, so we need to do it ourselves.
  // Skip occurrences that appear in EXDATE (user deleted that specific instance).
  const rruleRaw = get('RRULE');
  if (startDate && rruleRaw) {
    try {
      const freq     = (rruleRaw.match(/FREQ=(\w+)/i)     || [])[1]?.toUpperCase();
      const interval = parseInt((rruleRaw.match(/INTERVAL=(\d+)/i) || [])[1] || '1', 10);
      const until    = (rruleRaw.match(/UNTIL=([^;]+)/i)  || [])[1];
      const untilDate = until ? new Date(until.replace(/(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')) : null;
      const now = new Date();
      let candidate = new Date(startDate);
      const durationMs = endDate ? (endDate.getTime() - startDate.getTime()) : 0;

      // Format candidate as local-time key to match EXDATE values (which are also local time)
      const localKey = (d) => {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      };

      const advance = () => {
        if (freq === 'DAILY' || freq === 'WEEKLY') {
          const stepMs = (freq === 'WEEKLY' ? 7 : 1) * interval * 86400000;
          candidate = new Date(candidate.getTime() + stepMs);
        } else if (freq === 'MONTHLY') {
          candidate.setMonth(candidate.getMonth() + interval);
        }
      };

      // Advance past occurrences that are in the past or excluded via EXDATE
      while (candidate < now || exdateTimes.has(localKey(candidate))) {
        advance();
        if (untilDate && candidate > untilDate) { candidate = null; break; }
        // Safety: don't loop more than 2 years out
        if (candidate && candidate > new Date(now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000)) { candidate = null; break; }
      }

      if (candidate && (!untilDate || candidate <= untilDate)) {
        startDate = candidate;
        if (durationMs > 0) endDate = new Date(candidate.getTime() + durationMs);
      } else {
        startDate = null; // no valid future occurrence
      }
    } catch (_) {}
  }

  const attendeeMatches = [...unfolded.matchAll(/^ATTENDEE[^:\n]*:([^\n]+)/gim)];
  const attendees = attendeeMatches.map((m) => m[1].trim());

  return { summary, location, startDate, endDate, isAllDay, attendees };
}

// ── CalDAV fetch ──────────────────────────────────────────────────────────────

async function fetchCalDAVEvents(username, password, from, to) {
  const dtStart = from.toISOString().split('.')[0] + 'Z';
  const dtEnd   = to.toISOString().split('.')[0] + 'Z';

  const { DAVClient } = require('tsdav');

  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  await client.login();

  const calendars = await client.fetchCalendars();
  const calendarFilter = (db.getSetting('ical_calendars') || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const events = [];

  for (const cal of calendars) {
    const calName = (cal.displayName || '').toLowerCase();
    if (calendarFilter.length > 0 && !calendarFilter.some((f) => calName.includes(f))) {
      continue;
    }

    let calObjects;
    try {
      calObjects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange: { start: dtStart, end: dtEnd },
      });
    } catch (err) {
      logger.logEvent('warn', `[calendar/icloud] fetchCalendarObjects failed for "${cal.displayName}": ${err.message}`);
      continue;
    }

    for (const obj of calObjects) {
      if (!obj.data) continue;
      const vevents = obj.data.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
      for (const vevent of vevents) {
        events.push(parseVevent(vevent));
      }
    }
  }

  return events;
}

// Fetch raw events in the normalized {summary, location, startDate, endDate, isAllDay, attendees}
// shape, for the given time window. Throws if not configured or on CalDAV failure.
async function fetchEvents(from, to) {
  const creds = await getCredentials();
  if (!creds) throw new Error('iCloud calendar not configured');
  return fetchCalDAVEvents(creds.username, creds.password, from, to);
}

module.exports = {
  id: 'icloud',
  label: 'iCloud Calendar',
  authType: 'app-password',
  isConfigured,
  setCredentials,
  getCredentials,
  fetchEvents,
};
