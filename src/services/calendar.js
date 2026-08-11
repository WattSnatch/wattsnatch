/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const https = require('https');
const db = require('../db');
const logger = require('../utils/logger');
// NOTE: must reference the index.js file explicitly - a bare './calendar' from within this
// same file resolves to this very file (calendar.js) before Node tries the calendar/ directory.
const calendarProviders = require('./calendar/index.js');

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const FILTER_KEYWORDS = ['zoom', 'teams', 'online', 'call', 'phone', 'meet', 'webex', 'virtual', 'hangout', 'facetime', 'skype'];

// Free power windows are read from the same calendar as trips. Several
// Australian retailers give away electricity for set periods (Solar Sharer and
// similar), and some let the customer pick the slots a fortnight at a time,
// which means there is no tariff schedule to configure against - the times are
// whatever you opted into. Putting them in a calendar is the natural way to
// express that, and the calendar is already connected for trip planning.
const DEFAULT_FREE_POWER_KEYWORDS = 'free power';

let _trips = [];
let _freePowerWindows = [];
let _lastFetched = null;
let _pollTimer = null;
let _started = false;

// ── Provider-agnostic status / credentials ────────────────────────────────────

function isConfigured() {
  return calendarProviders.getActiveProvider().isConfigured();
}

// iCloud-specific - kept for backward compatibility with the existing setup wizard
// (POST /api/setup/ical-credentials). Configuring iCloud this way also makes it the
// active provider, matching pre-multi-provider behaviour.
async function setCredentials(username, password) {
  await calendarProviders.getProvider('icloud').setCredentials(username, password);
  db.setSetting('calendar_provider', 'icloud');
}

async function getCredentials() {
  return calendarProviders.getProvider('icloud').getCredentials();
}

function getState() {
  return { trips: [..._trips], lastFetched: _lastFetched };
}

// ── Free power windows ────────────────────────────────────────────────────────

/** Configured match keywords, lowercased. Blank entries are dropped. */
function _freePowerKeywords() {
  const raw = db.getSetting('free_power_keywords');
  const value = (raw === null || raw === undefined || raw === '') ? DEFAULT_FREE_POWER_KEYWORDS : raw;
  return String(value)
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function isFreePowerEnabled() {
  return db.getSetting('free_power_enabled') === 'true';
}

/**
 * Whether a calendar event names a free power window.
 *
 * Matches on the event title only, never the location. Somebody driving to a
 * place called "Free Power Cafe" should not have their car start charging, and
 * more practically the title is the field a person actually controls when they
 * create the event.
 */
function isFreePowerEvent(event) {
  if (!event || !event.startDate) return false;
  const summary = (event.summary || '').toLowerCase();
  if (!summary) return false;
  return _freePowerKeywords().some((kw) => summary.includes(kw));
}

/**
 * Upcoming and currently-active free power windows, soonest first.
 *
 * All-day events are deliberately excluded. An all-day "Free Power" entry would
 * charge at full rate from the grid for twenty-four hours, which is exactly the
 * bill shock this feature is supposed to avoid if the retailer's window was
 * really only a few hours. A window has to state its hours to be acted on.
 */
function getFreePowerWindows() {
  return _freePowerWindows.map((w) => ({ ...w }));
}

/** True if a free power window covers `atMs` (defaults to now). */
function isFreePowerActive(atMs) {
  if (!isFreePowerEnabled()) return false;
  const t = atMs || Date.now();
  return _freePowerWindows.some((w) => t >= w.startMs && t < w.endMs);
}

/** The window covering `atMs`, or null. Used for logging and the UI banner. */
function getActiveFreePowerWindow(atMs) {
  if (!isFreePowerEnabled()) return null;
  const t = atMs || Date.now();
  return _freePowerWindows.find((w) => t >= w.startMs && t < w.endMs) || null;
}

// ── Geocoding + distance ──────────────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Free geocoder, no API key required - but a bare text search with no location
// context can match anywhere on Earth for short/ambiguous addresses (seen in
// practice: a local "Sandgate" resolved to Newcastle NSW, a local restaurant
// resolved to Ontario, Canada). Used as the default, and as a fallback if a
// Google Maps key is configured but the Google call fails.
async function geocodeAddress(address) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(address);
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?q=${encoded}&format=json&limit=1`,
      headers: {
        'User-Agent': 'WattSnatch/1.0 (solar EV management; https://github.com/WattSnatch/wattsnatch)',
        'Accept': 'application/json',
      },
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (!results || results.length === 0) return resolve(null);
          resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

function httpsGetJson(hostname, path) {
  return new Promise((resolve) => {
    const req = https.get({ hostname, path, headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// Google's Geocoding API, biased (not hard-restricted) toward a ~2-degree box
// around home - this is what actually fixes the wrong-country/wrong-state
// mismatches, since Nominatim's bare text search has no location context at all.
async function googleGeocodeAddress(address, apiKey, homeLat, homeLng) {
  const box = 2; // ~200km bias box - nudges results local without excluding genuine overseas trips
  const bounds = `${homeLat - box},${homeLng - box}|${homeLat + box},${homeLng + box}`;
  const path = `/maps/api/geocode/json?address=${encodeURIComponent(address)}&bounds=${encodeURIComponent(bounds)}&key=${apiKey}`;
  const json = await httpsGetJson('maps.googleapis.com', path);
  if (!json || json.status !== 'OK' || !json.results || json.results.length === 0) return null;
  const loc = json.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

// Google's Routes API - actual driving distance/route, not straight-line.
// NOTE: this is the current "Routes API", not the older "Distance Matrix
// API" - Google now rejects the legacy Distance Matrix API for newer API
// keys/projects (REQUEST_DENIED, "switch to the Routes API"), so this is
// the one that actually works for a freshly-created key. POST + JSON body +
// header-based auth, unlike every other Google Maps endpoint here.
// Returns km, or null on any failure (caller falls back to haversine).
function googleDrivingDistanceKm(homeLat, homeLng, lat, lng, apiKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      origin: { location: { latLng: { latitude: homeLat, longitude: homeLng } } },
      destination: { location: { latLng: { latitude: lat, longitude: lng } } },
      travelMode: 'DRIVE',
      // Without this the API defaults to TRAFFIC_UNAWARE, which picked a
      // genuinely longer, non-preferred route in testing (20km vs the 13km
      // Google Maps itself shows for the same two points) - this is the
      // setting that actually matches what a normal Maps search returns.
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    });
    const req = https.request({
      hostname: 'routes.googleapis.com',
      path: '/directions/v2:computeRoutes',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const meters = json?.routes?.[0]?.distanceMeters;
          resolve(typeof meters === 'number' ? meters / 1000 : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Strip leading venue name(s) to get a geocodable street address.
// Returns an array of candidates to try (most-stripped first).
// "Plot 4504 Market Garden 132 Pioneer Dr" → ["132 Pioneer Dr", "4504 Market Garden 132 Pioneer Dr"]
// "Decker Park 18 25th Ave, Brighton"      → ["18 25th Ave, Brighton"]
function stripVenueNameCandidates(address) {
  const matches = [...address.matchAll(/\d+\s+[A-Za-z]/g)];
  if (!matches.length) return [];
  const candidates = [];
  // Try from last digit group backwards (most likely the real street number first)
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = address.slice(matches[i].index).trim();
    if (candidate !== address) candidates.push(candidate);
  }
  return candidates;
}

// Resolve a location string to a known_destination row (geocoding + proximity matching)
async function resolveDestination(location) {
  if (!location) return null;

  const homeLat = parseFloat(db.getSetting('home_latitude') || '0');
  const homeLng = parseFloat(db.getSetting('home_longitude') || '0');
  if (!homeLat || !homeLng) return null;

  // Exact address match
  const existing = db.getKnownDestinationByAddress(location);
  if (existing && existing.lat != null) {
    return existing;
  }

  const mapsKey = db.getSetting('google_maps_api_key');

  // Geocode - prefer Google (location-biased, far less prone to matching the
  // wrong city/state/country) when a key is configured; fall back to the
  // free OSM geocoder (bare text search, no location context) otherwise or
  // if the Google call fails for any reason.
  let coords = mapsKey ? await googleGeocodeAddress(location, mapsKey, homeLat, homeLng) : null;
  if (!coords) coords = await geocodeAddress(location);
  if (!coords) {
    for (const candidate of stripVenueNameCandidates(location)) {
      coords = mapsKey ? await googleGeocodeAddress(candidate, mapsKey, homeLat, homeLng) : null;
      if (!coords) coords = await geocodeAddress(candidate);
      if (coords) break;
    }
  }
  if (!coords) return null;

  // Proximity match: within 200m of an existing destination
  const all = db.getKnownDestinationsWithCoords();
  for (const dest of all) {
    if (haversineKm(dest.lat, dest.lng, coords.lat, coords.lng) < 0.2) {
      return dest;
    }
  }

  // New destination - real driving distance via Google if configured,
  // straight-line haversine otherwise (or if the Google call fails).
  const drivingKm = mapsKey ? await googleDrivingDistanceKm(homeLat, homeLng, coords.lat, coords.lng, mapsKey) : null;
  const rawKm = drivingKm != null ? drivingKm : haversineKm(homeLat, homeLng, coords.lat, coords.lng);
  // Round up to the next whole km - a deliberate small safety buffer, since
  // this distance feeds directly into the trip energy calculation and
  // under-estimating it is the failure mode that actually matters (arriving
  // short), not over-estimating.
  const distanceKm = Math.ceil(rawKm);
  const id = db.upsertKnownDestination({
    name: location,
    address: location,
    lat: coords.lat,
    lng: coords.lng,
    distance_km: distanceKm,
  });

  return db.getKnownDestinationByAddress(location) || { id, lat: coords.lat, lng: coords.lng, distance_km: distanceKm, avg_kwh_required: null };
}

function isDrivingEvent(event) {
  if (!event.location || event.location.trim() === '') return false;
  if (event.isAllDay || !event.startDate) return false;
  const loc = event.location.toLowerCase();
  const sum = (event.summary || '').toLowerCase();
  for (const kw of FILTER_KEYWORDS) {
    if (loc.includes(kw) || sum.includes(kw)) return false;
  }
  // Location looks like a real address if it has a digit, comma, or is > 5 chars
  if (event.location.length < 3) return false;
  return true;
}

// ── Pre-populate known_destinations from TeslaMate ───────────────────────────

async function syncFrequentDestinations() {
  try {
    const teslamate = require('./teslamate');
    const destinations = await teslamate.getFrequentDestinations();
    if (!destinations || destinations.length === 0) return;

    for (const dest of destinations) {
      if (!dest.destination || dest.destination === 'Unknown') continue;
      const existing = db.getKnownDestinationByAddress(dest.destination);
      if (existing) {
        // Update avg_kwh if TeslaMate has better data
        if (dest.avg_kwh_required != null && !existing.avg_kwh_required) {
          db.upsertKnownDestination({
            address: dest.destination,
            avg_kwh_required: dest.avg_kwh_required,
            visit_count: dest.visit_count,
          });
        }
        continue;
      }
      db.upsertKnownDestination({
        name: dest.destination,
        address: dest.destination,
        avg_kwh_required: dest.avg_kwh_required,
        visit_count: dest.visit_count,
      });
    }
    console.log(`[calendar] Synced ${destinations.length} frequent destinations from TeslaMate`);
  } catch (err) {
    console.warn('[calendar] syncFrequentDestinations failed:', err.message);
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────

async function poll() {
  const provider = calendarProviders.getActiveProvider();
  if (!provider.isConfigured()) return;

  const homeLat = parseFloat(db.getSetting('home_latitude') || '0');
  const homeLng = parseFloat(db.getSetting('home_longitude') || '0');
  if (!homeLat || !homeLng) {
    console.warn('[calendar] Home location not set - cannot calculate trip distances');
    return;
  }

  const now = new Date();
  const cutoffDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  let rawEvents;
  try {
    rawEvents = await provider.fetchEvents(now, cutoffDate);
  } catch (err) {
    logger.logEvent('warn', `[calendar] ${provider.label} fetch failed: ${err.message}`);
    console.warn(`[calendar] ${provider.label} fetch failed:`, err.message);
    return;
  }

  const nowMs = now.getTime();
  const cutoff = cutoffDate.getTime();
  const trips = [];
  const freePowerWindows = [];

  for (const event of rawEvents) {
    // Checked before the trip filter so a free power event can never also be
    // treated as a trip - someone may well put a location on the event, and
    // "charge the car now" and "plan a drive to here" are different intents.
    if (isFreePowerEvent(event)) {
      // An all-day entry has no meaningful hours; see getFreePowerWindows().
      if (event.isAllDay || !event.endDate || event.endDate <= event.startDate) continue;
      const endMs = event.endDate.getTime();
      if (endMs <= nowMs) continue; // already finished
      freePowerWindows.push({
        summary: event.summary || 'Free power',
        startMs: event.startDate.getTime(),
        endMs,
      });
      continue;
    }

    if (!isDrivingEvent(event)) continue;
    const ts = event.startDate.getTime();
    if (ts < nowMs || ts > cutoff) continue;

    const dest = await resolveDestination(event.location);
    if (!dest || !dest.distance_km) continue;

    // Skip if destination is very close to home (<0.5km) - not really a trip
    if (dest.distance_km < 0.5) continue;

    const hoursAway = (ts - nowMs) / (60 * 60 * 1000);
    // Duration at destination = event length; default 2h if no end time
    const eventDurationHours = (event.endDate && event.endDate > event.startDate)
      ? (event.endDate.getTime() - event.startDate.getTime()) / (60 * 60 * 1000)
      : 2;

    trips.push({
      summary:             event.summary || 'Event',
      location:            event.location,
      departureTime:       ts,
      hoursAway,
      eventDurationHours,
      distanceKm:          dest.distance_km,
      destId:              dest.id,
      avgKwhRequired:      dest.avg_kwh_required,
      attendees:           event.attendees,
    });
  }

  trips.sort((a, b) => a.departureTime - b.departureTime);
  freePowerWindows.sort((a, b) => a.startMs - b.startMs);
  _trips = trips;
  _freePowerWindows = freePowerWindows;
  _lastFetched = nowMs;
  console.log(`[calendar] ${trips.length} upcoming driving trip(s) in next 7 days`);
  if (freePowerWindows.length > 0) {
    console.log(`[calendar] ${freePowerWindows.length} free power window(s) in next 7 days`);
  }
}

function start() {
  if (_started) return;
  _started = true;
  if (!isConfigured()) return;
  poll().catch((err) => console.warn('[calendar] Initial poll error:', err.message));
  syncFrequentDestinations().catch(() => {});
  _pollTimer = setInterval(() => poll().catch((err) => console.warn('[calendar] Poll error:', err.message)), POLL_INTERVAL_MS);
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _started = false;
}

function restart() {
  stop();
  _started = false;
  start();
}

module.exports = {
  start, stop, restart,
  isConfigured, setCredentials, getCredentials, getState,
  poll, resolveDestination, haversineKm,
  isFreePowerEnabled, isFreePowerEvent, getFreePowerWindows,
  isFreePowerActive, getActiveFreePowerWindow,
};
