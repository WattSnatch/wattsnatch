/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('../../db');

// Every provider exposes: id, label, authType ('app-password' | 'oauth'), isConfigured(),
// fetchEvents(from, to) -> normalized {summary, location, startDate, endDate, isAllDay, attendees}[].
// OAuth providers additionally expose getAuthUrl(redirectUri, state), exchangeCode(code, redirectUri),
// disconnect(). The app-password provider (iCloud) additionally exposes setCredentials/getCredentials.
const providers = {
  icloud: require('./icloud'),
  google: require('./google'),
  outlook: require('./outlook'),
};

function getProvider(id) {
  return providers[id] || null;
}

function getActiveProvider() {
  const id = db.getSetting('calendar_provider') || 'icloud';
  return getProvider(id) || providers.icloud;
}

function listProviders() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    authType: p.authType,
    configured: p.isConfigured(),
  }));
}

module.exports = { getProvider, getActiveProvider, listProviders };
