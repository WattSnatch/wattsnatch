/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// What the dashboard's house view needs beyond the live telemetry: each panel's latest output and
// health, which roof face it is on, the weather, sunrise and sunset, and what the system has
// produced at this time of day on a clear day recently. Served by GET /api/house-scene.
//
// Panels go on the face their nickname starts with (North 3, "west 1", "S2"); a panel without one
// goes on the main face. Only angles and times leave this module, never the home's coordinates.

const db = require('../db');

const FACE_WORDS = { n: 'N', north: 'N', e: 'E', east: 'E', s: 'S', south: 'S', w: 'W', west: 'W' };
const STALE_PANEL_MS = 15 * 60e3;     // panels poll every 5 minutes, in daylight only
const PEAK_WINDOW_MS = 30 * 86400e3;  // the brightest panel reading of the last 30 days is "full"
const CLEAR_DAYS = 14;                // clear-day reference: best output at this time of day ...
const CLEAR_HALF_WINDOW_MS = 10 * 60e3; // ... within 10 minutes either side, over the last 14 days

const _cache = new Map();
function cached(key, ttlMs, fn, now) {
  const hit = _cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = fn();
  _cache.set(key, { at: now, value });
  return value;
}

// 'North 3' -> { face: 'N', order: 3 }. Unrecognised names give face null and sort by their number.
function parseNickname(name) {
  const s = String(name || '').trim().toLowerCase();
  const m = s.match(/^(north|south|east|west|[nsew])\b[\s\-_#]*(\d+)?/) || s.match(/^([nsew])(\d+)$/);
  const num = s.match(/(\d+)\s*$/);
  return { face: m ? FACE_WORDS[m[1]] : null, order: num ? parseInt(num[1], 10) : null };
}

// Which roof face is drawn where. The house is seen from one corner, so two adjacent faces are
// in full view (front and side), the opposite one shows as a strip behind the ridge (back) and
// the fourth is hidden. Picks the turn of the house that shows the most panels.
const TURNS = [
  { front: 'N', side: 'W', back: 'S', hidden: 'E' },
  { front: 'E', side: 'N', back: 'W', hidden: 'S' },
  { front: 'S', side: 'E', back: 'N', hidden: 'W' },
  { front: 'W', side: 'S', back: 'E', hidden: 'N' },
];
function chooseTurn(counts) {
  const score = (t) => (counts[t.front] || 0) * 3 + (counts[t.side] || 0) * 2 + (counts[t.back] || 0);
  return TURNS.reduce((best, t) => (score(t) > score(best) ? t : best), TURNS[0]);
}

function latestPanels(now) {
  const raw = db.getDb();
  const last = raw.prepare('SELECT MAX(recorded_at) AS at FROM panel_production').get();
  if (!last || !last.at) return { at: null, rows: [] };
  const rows = raw.prepare('SELECT panel_id, wh_produced AS watts FROM panel_production WHERE recorded_at = ?').all(last.at);
  return { at: last.at, rows };
}

function panelPeakW(now) {
  return cached('peak', 3600e3, () => {
    const r = db.getDb().prepare('SELECT MAX(wh_produced) AS w FROM panel_production WHERE recorded_at >= ?').get(now - PEAK_WINDOW_MS);
    return r && r.w > 0 ? r.w : null;
  }, now);
}

function healthById(now) {
  return cached('health', 10 * 60e3, () => {
    try {
      const { panels } = require('./enphase-panels').getHealthStatus();
      return Object.fromEntries(panels.map((p) => [p.panel_id, p.health]));
    } catch (_e) { return {}; }
  }, now);
}

// The best whole-system output at this time of day over the last two weeks: what a clear day
// gives right now, so the dashboard can say how today compares.
function clearDayW(now) {
  return cached('clear', 5 * 60e3, () => {
    const q = db.getDb().prepare('SELECT MAX(solar_w) AS w FROM telemetry_log WHERE recorded_at BETWEEN ? AND ?');
    let best = 0;
    for (let d = 1; d <= CLEAR_DAYS; d++) {
      const t = now - d * 86400e3;
      const r = q.get(t - CLEAR_HALF_WINDOW_MS, t + CLEAR_HALF_WINDOW_MS);
      if (r && r.w > best) best = r.w;
    }
    return best > 0 ? Math.round(best) : null;
  }, now);
}

function buildPanels(now) {
  const { at, rows } = latestPanels(now);
  if (!rows.length) return { panels: [], turn: TURNS[0], peakW: null };
  let nicknames = {};
  try { nicknames = JSON.parse(db.getSetting('panel_nicknames') || '{}'); } catch (_e) {}
  const health = healthById(now);
  const stale = now - at > STALE_PANEL_MS;
  const panels = rows.map((r) => {
    const name = nicknames[r.panel_id] || '';
    const { face, order } = parseNickname(name);
    return { id: r.panel_id, name: name || null, face, order, watts: stale ? 0 : Math.round(r.watts || 0), health: health[r.panel_id] || null };
  });
  const counts = {};
  for (const p of panels) if (p.face) counts[p.face] = (counts[p.face] || 0) + 1;
  const turn = chooseTurn(counts);
  const place = { [turn.front]: 'front', [turn.side]: 'side', [turn.back]: 'back', [turn.hidden]: 'hidden' };
  for (const p of panels) p.place = p.face ? place[p.face] : 'front';
  panels.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.id.localeCompare(b.id));
  return {
    panels: panels.map(({ id: _id, ...p }) => p),   // serials stay on the server
    turn: { front: turn.front, side: turn.side },
    peakW: panelPeakW(now),
    updatedAt: at,
    stale,
  };
}

function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildSky(now) {
  let wc = null;
  try { wc = require('./weatherGrid').getWeather() || db.getWeatherCache(); } catch (_e) {}
  const w = wc && wc.data;
  // Over three hours old is too stale to draw as the sky right now.
  if (!w || !w.current || now - (wc.fetchedAt || 0) > 3 * 3600e3) return null;
  const today = (w.daily || []).find((d) => d.date === localDate(now));
  // Open-Meteo gives local times without an offset ("2026-11-05T04:51"), which Date reads as local.
  const t = (s) => { const ms = s ? new Date(s).getTime() : NaN; return isFinite(ms) ? ms : null; };
  return {
    cloudCover: w.current.cloudCover ?? null,
    weatherCode: w.current.weatherCode ?? null,
    label: w.current.label || null,
    windKmh: w.current.windKmh ?? null,
    sunrise: today ? t(today.sunrise) : null,
    sunset: today ? t(today.sunset) : null,
  };
}

function getScene(now = Date.now()) {
  const p = buildPanels(now);
  return { ...p, sky: buildSky(now), clearDayW: clearDayW(now), now };
}

function _resetCacheForTests() { _cache.clear(); }

module.exports = { getScene, parseNickname, chooseTurn, _resetCacheForTests };
