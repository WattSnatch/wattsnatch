/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../../db');
const { encrypt, decrypt } = require('../../utils/crypto');

const TOKEN_PROVIDER = 'outlook_calendar';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access Calendars.Read';

function tenant() {
  return db.getSetting('outlook_calendar_tenant_id') || 'common';
}

function authorizeUrl() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`;
}

function tokenUrl() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;
}

function isConfigured() {
  const token = db.getToken(TOKEN_PROVIDER);
  return !!(token && token.token_data);
}

function getAuthUrl(redirectUri, state) {
  const clientId = db.getSetting('outlook_calendar_client_id');
  if (!clientId) throw new Error('outlook_calendar_client_id not set');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPE,
    state: state || '',
  });
  return `${authorizeUrl()}?${params.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const clientId = db.getSetting('outlook_calendar_client_id');
  const clientSecret = db.getSetting('outlook_calendar_client_secret');
  if (!clientId || !clientSecret) throw new Error('Outlook Calendar client ID/secret not set');

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      scope: SCOPE,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `Outlook token exchange failed (${res.status})`);
  if (!data.refresh_token) {
    throw new Error('Microsoft did not return a refresh token - ensure "offline_access" is granted and try again');
  }

  storeTokens({ access_token: data.access_token, refresh_token: data.refresh_token }, data.expires_in);
}

async function refreshAccessToken(refreshToken) {
  const clientId = db.getSetting('outlook_calendar_client_id');
  const clientSecret = db.getSetting('outlook_calendar_client_secret');

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPE,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `Outlook token refresh failed (${res.status})`);

  // Microsoft rotates refresh tokens - store whichever comes back, falling back to the old one
  storeTokens({ access_token: data.access_token, refresh_token: data.refresh_token || refreshToken }, data.expires_in);
  return data.access_token;
}

function storeTokens(tokenData, expiresInSecs) {
  const expiresAt = Date.now() + (expiresInSecs || 3600) * 1000;
  const encrypted = encrypt(JSON.stringify(tokenData));
  db.setToken(TOKEN_PROVIDER, encrypted, expiresAt, JSON.stringify({ authenticated: true }));
}

async function getValidAccessToken() {
  const token = db.getToken(TOKEN_PROVIDER);
  if (!token) throw new Error('Outlook Calendar not configured');

  const tokenData = JSON.parse(decrypt(token.token_data));
  if (Date.now() > token.expires_at - 60000) {
    return refreshAccessToken(tokenData.refresh_token);
  }
  return tokenData.access_token;
}

// Fetch raw events in the normalized {summary, location, startDate, endDate, isAllDay, attendees}
// shape, for the given time window. Microsoft Graph's calendarview expands recurring events
// server-side, so no manual RRULE handling is needed here.
async function fetchEvents(from, to) {
  const accessToken = await getValidAccessToken();

  const params = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $top: '250',
    $select: 'subject,location,start,end,isAllDay,attendees',
  });

  const res = await fetch(`${GRAPH_BASE}/me/calendarview?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Microsoft Graph API error (${res.status})`);

  return (data.value || []).map((item) => ({
    summary: item.subject || null,
    location: item.location?.displayName || null,
    // Graph returns dateTime strings without a 'Z' but we forced UTC via the Prefer header
    startDate: item.start?.dateTime ? new Date(item.start.dateTime + 'Z') : null,
    endDate: item.end?.dateTime ? new Date(item.end.dateTime + 'Z') : null,
    isAllDay: !!item.isAllDay,
    attendees: (item.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
  }));
}

function disconnect() {
  db.deleteToken(TOKEN_PROVIDER);
}

module.exports = {
  id: 'outlook',
  label: 'Outlook / Microsoft 365',
  authType: 'oauth',
  isConfigured,
  getAuthUrl,
  exchangeCode,
  fetchEvents,
  disconnect,
};
