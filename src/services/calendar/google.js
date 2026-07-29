/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../../db');
const logger = require('../../utils/logger');
const { encrypt, decrypt } = require('../../utils/crypto');

const TOKEN_PROVIDER = 'google_calendar';
const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

function isConfigured() {
  const token = db.getToken(TOKEN_PROVIDER);
  return !!(token && token.token_data);
}

function getAuthUrl(redirectUri, state) {
  const clientId = db.getSetting('google_calendar_client_id');
  if (!clientId) throw new Error('google_calendar_client_id not set');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: state || '',
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const clientId = db.getSetting('google_calendar_client_id');
  const clientSecret = db.getSetting('google_calendar_client_secret');
  if (!clientId || !clientSecret) throw new Error('Google Calendar client ID/secret not set');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token exchange failed (${res.status})`);
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token - remove any prior authorization for this app at myaccount.google.com/permissions and try again');
  }

  storeTokens({ access_token: data.access_token, refresh_token: data.refresh_token }, data.expires_in);
}

async function refreshAccessToken(refreshToken) {
  const clientId = db.getSetting('google_calendar_client_id');
  const clientSecret = db.getSetting('google_calendar_client_secret');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token refresh failed (${res.status})`);

  storeTokens({ access_token: data.access_token, refresh_token: refreshToken }, data.expires_in);
  return data.access_token;
}

function storeTokens(tokenData, expiresInSecs) {
  const expiresAt = Date.now() + (expiresInSecs || 3600) * 1000;
  const encrypted = encrypt(JSON.stringify(tokenData));
  db.setToken(TOKEN_PROVIDER, encrypted, expiresAt, JSON.stringify({ authenticated: true }));
}

async function getValidAccessToken() {
  const token = db.getToken(TOKEN_PROVIDER);
  if (!token) throw new Error('Google Calendar not configured');

  const tokenData = JSON.parse(decrypt(token.token_data));
  // Refresh a little early to avoid racing expiry
  if (Date.now() > token.expires_at - 60000) {
    return refreshAccessToken(tokenData.refresh_token);
  }
  return tokenData.access_token;
}

// Fetch raw events in the normalized {summary, location, startDate, endDate, isAllDay, attendees}
// shape, for the given time window. Google expands recurring events server-side (singleEvents=true)
// so no manual RRULE handling is needed here.
async function fetchEvents(from, to) {
  const accessToken = await getValidAccessToken();
  const calendarId = db.getSetting('google_calendar_calendar_id') || 'primary';

  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });

  const res = await fetch(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Google Calendar API error (${res.status})`);

  return (data.items || []).map((item) => {
    const isAllDay = !item.start?.dateTime;
    return {
      summary: item.summary || null,
      location: item.location || null,
      startDate: item.start?.dateTime ? new Date(item.start.dateTime) : (item.start?.date ? new Date(item.start.date) : null),
      endDate: item.end?.dateTime ? new Date(item.end.dateTime) : (item.end?.date ? new Date(item.end.date) : null),
      isAllDay,
      attendees: (item.attendees || []).map((a) => a.email).filter(Boolean),
    };
  });
}

function disconnect() {
  db.deleteToken(TOKEN_PROVIDER);
}

module.exports = {
  id: 'google',
  label: 'Google Calendar',
  authType: 'oauth',
  isConfigured,
  getAuthUrl,
  exchangeCode,
  fetchEvents,
  disconnect,
};
