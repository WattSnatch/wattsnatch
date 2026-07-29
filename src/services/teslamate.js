/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const { Pool, types } = require('pg');
const db = require('../db');

// TeslaMate stores timestamps as UTC but in 'timestamp without time zone' columns.
// node-postgres interprets those as local time (AEST = UTC+10), shifting queries 10 hours.
// Force UTC parsing for both timestamp types so WattSnatch ms-based lookups align correctly.
types.setTypeParser(1114, str => new Date(str + 'Z')); // timestamp without time zone
types.setTypeParser(1184, str => new Date(str));        // timestamptz (already has offset, but be explicit)

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const _cache = new Map();

let _pool = null;
let _lastUrl = null;

function parseDbUrl(url) {
  // Use regex instead of new URL() so special chars in passwords (e.g. # @ :) don't break parsing.
  // Matches: protocol://user:password@host:port/database
  const m = url.match(/^[a-z][a-z0-9+\-.]*:\/\/([^:@]+):(.+)@([^:\/]+):(\d+)\/([^?#\s]+)/i);
  if (!m) return null;
  return { user: m[1], password: m[2], host: m[3], port: parseInt(m[4], 10), database: m[5] };
}

function getPool() {
  const url = db.getSetting('teslamate_database_url');
  if (!url) return null;
  if (_pool && url === _lastUrl) return _pool;
  if (_pool) {
    _pool.end().catch(() => {});
    _pool = null;
  }
  const parsed = parseDbUrl(url);
  _pool = new Pool(parsed
    ? { ...parsed, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, ssl: false }
    : { connectionString: url, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, ssl: false }
  );
  _pool.on('error', (err) => {
    console.warn('[teslamate] pool error:', err.message);
  });
  _lastUrl = url;
  return _pool;
}

async function query(sql, params = []) {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

function cached(key, fn) {
  return async () => {
    const entry = _cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.data;
    try {
      const data = await fn();
      _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    } catch (err) {
      console.warn(`[teslamate] ${key} query failed:`, err.message);
      const stale = _cache.get(key);
      return stale ? stale.data : null;
    }
  };
}

// Real-world efficiency (kWh per km) - last 90 days, drives > 5 km
const getEfficiencyKwhPerKm = cached('efficiency', async () => {
  const rows = await query(`
    SELECT
      AVG(
        (d.start_ideal_range_km - d.end_ideal_range_km) * 0.155 /
        NULLIF(d.distance, 0)
      ) AS kwh_per_km,
      COUNT(*) AS drive_count
    FROM drives d
    WHERE d.start_date > NOW() - INTERVAL '90 days'
      AND d.distance > 5
      AND d.start_ideal_range_km > d.end_ideal_range_km
  `);
  if (!rows || !rows[0] || rows[0].kwh_per_km == null) return null;
  const r = rows[0];
  const kwhPerKm = parseFloat(r.kwh_per_km);
  return {
    kwh_per_km:  Math.round(kwhPerKm  * 1000) / 1000,
    km_per_kwh:  Math.round((1 / kwhPerKm) * 10) / 10,
    drive_count: parseInt(r.drive_count, 10) || 0,
  };
});

// Sentry drain rate - estimated from parked periods 4-16 hours
const getSentryDrainRateKwhPerHour = cached('sentry_drain', async () => {
  const rows = await query(`
    WITH parked AS (
      SELECT
        d.end_date AS parked_from,
        d.end_ideal_range_km AS range_start,
        n.start_date AS parked_to,
        n.start_ideal_range_km AS range_end,
        0.155 AS eff
      FROM drives d
      JOIN LATERAL (
        SELECT start_date, start_ideal_range_km
        FROM drives d2
        WHERE d2.car_id = d.car_id AND d2.start_date > d.end_date
        ORDER BY d2.start_date
        LIMIT 1
      ) n ON true
      WHERE d.start_date > NOW() - INTERVAL '90 days'
    )
    SELECT
      AVG(
        (range_start - range_end) * eff /
        NULLIF(EXTRACT(EPOCH FROM (parked_to - parked_from)) / 3600.0, 0)
      ) AS kwh_per_hour
    FROM parked
    WHERE EXTRACT(EPOCH FROM (parked_to - parked_from)) BETWEEN 14400 AND 57600
      AND range_start > range_end
  `);
  if (!rows || !rows[0] || rows[0].kwh_per_hour == null) return null;
  return { kwh_per_hour: Math.round(parseFloat(rows[0].kwh_per_hour) * 100) / 100 };
});

// Efficiency by drive type (highway vs suburban)
const getEfficiencyByDriveType = cached('efficiency_by_type', async () => {
  const rows = await query(`
    SELECT
      CASE
        WHEN d.distance / NULLIF(d.duration_min / 60.0, 0) > 80 THEN 'highway'
        ELSE 'suburban'
      END AS drive_type,
      AVG(
        (d.start_ideal_range_km - d.end_ideal_range_km) * 0.155 /
        NULLIF(d.distance, 0)
      ) AS kwh_per_km,
      COUNT(*) AS drive_count
    FROM drives d
    WHERE d.start_date > NOW() - INTERVAL '90 days'
      AND d.distance > 5
      AND d.start_ideal_range_km > d.end_ideal_range_km
      AND d.duration_min > 0
    GROUP BY drive_type
  `);
  if (!rows || rows.length === 0) return null;
  const result = {};
  for (const r of rows) {
    const kwhPerKm = parseFloat(r.kwh_per_km);
    result[r.drive_type] = {
      kwh_per_km:  Math.round(kwhPerKm * 1000) / 1000,
      km_per_kwh:  Math.round((1 / kwhPerKm) * 10) / 10,
      drive_count: parseInt(r.drive_count, 10),
    };
  }
  return result;
});

// Battery health - recent usable capacity vs all-time best
const getBatteryHealthPercent = cached('battery_health', async () => {
  const rows = await query(`
    SELECT
      MAX(cp.start_ideal_range_km) FILTER (WHERE cp.start_date > NOW() - INTERVAL '90 days') AS recent_max_km,
      MAX(cp.start_ideal_range_km) AS all_time_max_km,
      0.155 AS efficiency_factor
    FROM charging_processes cp
    WHERE cp.start_battery_level >= 97
  `);
  if (!rows || !rows[0] || !rows[0].all_time_max_km) return null;
  const r = rows[0];
  const recentMax  = parseFloat(r.recent_max_km   || r.all_time_max_km);
  const allTimeMax = parseFloat(r.all_time_max_km);
  const effFactor  = parseFloat(r.efficiency_factor);
  const healthPct  = Math.round((recentMax / allTimeMax) * 1000) / 10;
  const usableKwh  = Math.round(recentMax * effFactor * 10) / 10;
  return {
    health_pct:            healthPct,
    usable_kwh:            usableKwh,
    recent_max_range_km:   Math.round(recentMax),
    all_time_max_range_km: Math.round(allTimeMax),
  };
});

// Frequent destinations - top 10 by visit count in last 12 months
const getFrequentDestinations = cached('frequent_destinations', async () => {
  const rows = await query(`
    SELECT
      COALESCE(a.display_name, a.name, 'Unknown') AS destination,
      COUNT(*) AS visit_count,
      AVG(d.distance * 0.155) AS avg_kwh_required
    FROM drives d
    LEFT JOIN addresses a ON d.end_address_id = a.id
    WHERE d.start_date > NOW() - INTERVAL '365 days'
      AND a.id IS NOT NULL
      AND d.distance > 2
    GROUP BY a.id, COALESCE(a.display_name, a.name, 'Unknown')
    ORDER BY visit_count DESC
    LIMIT 10
  `);
  if (!rows) return [];
  return rows.map(r => ({
    destination:      r.destination,
    visit_count:      parseInt(r.visit_count, 10),
    avg_kwh_required: r.avg_kwh_required != null ? Math.round(parseFloat(r.avg_kwh_required) * 10) / 10 : null,
  }));
});

// Charge session history - link to WattSnatch session log
async function getChargeSessions(days = 30) {
  const key = `charge_sessions_${days}`;
  const entry = _cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  try {
    const safeDays = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const rows = await query(
      `SELECT
         id, start_date, end_date, charge_energy_added,
         start_battery_level, end_battery_level, duration_min, outside_temp_avg
       FROM charging_processes
       WHERE start_date > NOW() - (INTERVAL '1 day' * $1)
       ORDER BY start_date DESC`,
      [safeDays]
    );
    const data = (rows || []).map(r => ({
      id:                  r.id,
      start_date:          r.start_date,
      end_date:            r.end_date,
      charge_energy_added: r.charge_energy_added != null ? parseFloat(r.charge_energy_added) : null,
      start_battery_level: r.start_battery_level,
      end_battery_level:   r.end_battery_level,
      duration_min:        r.duration_min,
      outside_temp_avg:    r.outside_temp_avg != null ? parseFloat(r.outside_temp_avg) : null,
    }));
    _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (err) {
    console.warn('[teslamate] getChargeSessions failed:', err.message);
    return null;
  }
}

// Typical arrival SoC - what % does the car usually arrive at
const getTypicalArrivalSoc = cached('typical_arrival_soc', async () => {
  const rows = await query(`
    SELECT
      AVG(start_battery_level) AS avg_soc,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY start_battery_level) AS median_soc,
      MIN(start_battery_level) AS min_soc,
      COUNT(*) AS session_count
    FROM charging_processes
    WHERE start_date > NOW() - INTERVAL '90 days'
      AND charge_energy_added > 1
  `);
  if (!rows || !rows[0] || rows[0].session_count == null) return null;
  const r = rows[0];
  return {
    avg_soc:       r.avg_soc    != null ? Math.round(parseFloat(r.avg_soc))    : null,
    median_soc:    r.median_soc != null ? Math.round(parseFloat(r.median_soc)) : null,
    min_soc:       r.min_soc    != null ? Math.round(parseFloat(r.min_soc))    : null,
    session_count: parseInt(r.session_count, 10) || 0,
  };
});

// Recent drives that ended near a given lat/lng (for trip completion detection)
async function getRecentDrivesNearHome(homeLat, homeLng, radiusKm = 0.5) {
  try {
    const rows = await query(`
      SELECT
        d.id, d.start_date, d.end_date, d.distance,
        a.latitude AS end_lat, a.longitude AS end_lng,
        cp.charge_energy_added
      FROM drives d
      LEFT JOIN addresses a ON d.end_address_id = a.id
      LEFT JOIN LATERAL (
        SELECT charge_energy_added FROM charging_processes cp2
        WHERE cp2.car_id = d.car_id
          AND cp2.start_date >= d.end_date
          AND cp2.start_date < d.end_date + INTERVAL '2 hours'
        ORDER BY cp2.start_date
        LIMIT 1
      ) cp ON true
      WHERE d.end_date > NOW() - INTERVAL '8 hours'
        AND d.end_date IS NOT NULL
        AND a.latitude IS NOT NULL
        AND a.longitude IS NOT NULL
      ORDER BY d.end_date DESC
    `);
    if (!rows) return [];
    // Filter by proximity
    return rows.filter((r) => {
      if (r.end_lat == null || r.end_lng == null) return false;
      const lat = parseFloat(r.end_lat);
      const lng = parseFloat(r.end_lng);
      const dLat = (lat - homeLat) * Math.PI / 180;
      const dLng = (lng - homeLng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(homeLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return dist <= radiusKm;
    });
  } catch (err) {
    console.warn('[teslamate] getRecentDrivesNearHome failed:', err.message);
    return [];
  }
}

// Test the connection
async function testConnection() {
  try {
    const pool = getPool();
    if (!pool) return { ok: false, error: 'No TeslaMate database URL configured' };
    const client = await pool.connect();
    const result = await client.query('SELECT COUNT(*) FROM drives');
    client.release();
    return { ok: true, drive_count: parseInt(result.rows[0].count, 10) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Actual km driven in a time window - used for km-by-source attribution
async function getDrivenKmInPeriod(startMs, endMs) {
  try {
    const rows = await query(`
      SELECT COALESCE(SUM(d.distance), 0) AS total_km
      FROM drives d
      WHERE d.start_date >= TO_TIMESTAMP($1 / 1000.0)
        AND d.start_date <  TO_TIMESTAMP($2 / 1000.0)
        AND d.distance > 0
    `, [startMs, endMs]);
    return Math.round(parseFloat(rows?.[0]?.total_km || 0));
  } catch (_err) {
    return 0;
  }
}

// Public charging kWh - all sessions NOT at the most-common charging address (home)
async function getPublicChargeKwh(startMs, endMs) {
  try {
    const rows = await query(`
      WITH home_addr AS (
        SELECT address_id
        FROM charging_processes
        WHERE address_id IS NOT NULL AND charge_energy_added > 0.5
        GROUP BY address_id
        ORDER BY COUNT(*) DESC
        LIMIT 1
      )
      SELECT COALESCE(SUM(cp.charge_energy_added), 0) AS public_kwh
      FROM charging_processes cp
      WHERE cp.start_date >= $1 AND cp.start_date < $2
        AND cp.charge_energy_added IS NOT NULL
        AND cp.end_date IS NOT NULL
        AND (cp.address_id IS NULL OR cp.address_id NOT IN (SELECT address_id FROM home_addr))
    `, [new Date(startMs), new Date(endMs || Date.now())]);
    return Math.round((parseFloat(rows?.[0]?.public_kwh) || 0) * 100) / 100;
  } catch (_err) {
    return null;
  }
}

function _shortLocation(road, suburb, city) {
  return suburb || road || city || '-';
}

// Paginated drive list with solar attribution from WattSnatch charge_sessions
async function getDrives({ page = 1, limit = 20, fromMs = null, toMs = null } = {}) {
  const offset = (page - 1) * limit;

  const dateFilter = fromMs && toMs
    ? `AND d.start_date >= '${new Date(fromMs).toISOString()}'::timestamptz AND d.start_date <= '${new Date(toMs).toISOString()}'::timestamptz`
    : fromMs
    ? `AND d.start_date >= '${new Date(fromMs).toISOString()}'::timestamptz`
    : '';

  const countResult = await query(`SELECT COUNT(*) AS n FROM drives d WHERE d.end_date IS NOT NULL ${dateFilter}`);
  if (!countResult) return null;
  const total = parseInt(countResult[0].n, 10);

  // LATERAL join finds the most recent real TeslaMate charge (>0.1 kWh) before each drive.
  // This is used to match against WattSnatch sessions by time overlap, handling the case
  // where multiple consecutive drives all ran off the same charging session.
  const rows = await query(`
    WITH paged AS (
      SELECT
        d.id,
        d.start_date,
        d.end_date,
        d.distance,
        d.duration_min,
        d.start_ideal_range_km,
        d.end_ideal_range_km,
        d.outside_temp_avg,
        sp.battery_level AS start_battery_level,
        ep.battery_level AS end_battery_level,
        sa.road          AS start_road,
        sa.neighbourhood AS start_suburb,
        sa.city          AS start_city,
        ea.road          AS end_road,
        ea.neighbourhood AS end_suburb,
        ea.city          AS end_city,
        ROW_NUMBER() OVER (ORDER BY d.start_date DESC) AS rn
      FROM drives d
      LEFT JOIN addresses sa ON sa.id = d.start_address_id
      LEFT JOIN addresses ea ON ea.id = d.end_address_id
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
      WHERE d.end_date IS NOT NULL ${dateFilter}
    )
    SELECT p.*,
           cp.start_date        AS last_charge_start,
           cp.end_date          AS last_charge_end,
           cp.end_battery_level AS charge_end_batt
    FROM paged p
    LEFT JOIN LATERAL (
      SELECT start_date, end_date, end_battery_level
      FROM charging_processes
      WHERE end_date < p.start_date AND charge_energy_added > 0.1
      ORDER BY end_date DESC LIMIT 1
    ) cp ON true
    WHERE p.rn BETWEEN $1 AND $2
    ORDER BY p.rn ASC
  `, [offset + 1, offset + limit]);

  if (!rows) return null;

  const drives = rows.map(row => {
    const startMs = new Date(row.start_date).getTime();

    // solar_pct reflects the solar/grid mix of the charge session that fed this drive.
    // sessionKwhSolar/sessionKwhGrid are session-level totals, used only to derive that ratio -
    // they are NOT this drive's own energy use (one charge can feed several drives).
    let solar_pct = null;
    let sessionKwhSolar = 0;
    let sessionKwhGrid  = 0;

    if (row.last_charge_start && row.last_charge_end) {
      // Match the TeslaMate charge session to WattSnatch by time overlap (±60 min tolerance)
      const tmStartMs = new Date(row.last_charge_start).getTime();
      const tmEndMs   = new Date(row.last_charge_end).getTime();
      const margin    = 60 * 60 * 1000;
      try {
        const sessions = db.getChargeSessionsInWindow(tmStartMs - margin, tmEndMs + margin);
        for (const s of sessions) {
          sessionKwhSolar += s.kwh_solar     || 0;
          sessionKwhGrid  += s.kwh_from_grid || 0;
        }
        if (sessionKwhSolar > 0 || sessionKwhGrid > 0) {
          const totalAttrib = sessionKwhSolar + sessionKwhGrid;
          solar_pct = Math.round((sessionKwhSolar / totalAttrib) * 100);
        }
        // If sessions.length === 0: TeslaMate charge has no WattSnatch match
        // → likely public/grid charge → leave solar_pct as null
      } catch (_) {}
    }

    const distance      = parseFloat(row.distance) || 0;
    const rangeConsumed = Math.max(0, parseFloat(row.start_ideal_range_km) - parseFloat(row.end_ideal_range_km));
    const est_kwh       = parseFloat((rangeConsumed * 0.165).toFixed(2));
    const wh_per_km     = distance > 0.1 ? Math.round((rangeConsumed * 165) / distance) : null;

    // Apply the charge session's solar/grid ratio to this drive's own estimated energy use,
    // rather than showing the session's absolute kWh (which double-counts across every drive
    // that shared the same preceding charge).
    const kwh_solar = solar_pct != null ? parseFloat((est_kwh * solar_pct / 100).toFixed(3)) : 0;
    const kwh_grid  = solar_pct != null ? parseFloat((est_kwh * (100 - solar_pct) / 100).toFixed(3)) : 0;

    return {
      id:                row.id,
      start_date:        row.start_date,
      end_date:          row.end_date,
      distance_km:       parseFloat(distance.toFixed(2)),
      duration_min:      row.duration_min,
      range_consumed_km: parseFloat(rangeConsumed.toFixed(2)),
      est_kwh,
      wh_per_km,
      start_location:    _shortLocation(row.start_road, row.start_suburb, row.start_city),
      end_location:      _shortLocation(row.end_road, row.end_suburb, row.end_city),
      start_battery_pct: row.start_battery_level != null ? Math.round(parseFloat(row.start_battery_level)) : null,
      end_battery_pct:   row.end_battery_level   != null ? Math.round(parseFloat(row.end_battery_level))   : null,
      outside_temp_c:    row.outside_temp_avg    != null ? Math.round(parseFloat(row.outside_temp_avg))    : null,
      kwh_solar,
      kwh_grid,
      solar_pct,
    };
  });

  return { total, page, limit, drives };
}

// Summary stats - optionally scoped to a date range
async function getDriveStats({ fromMs = null, toMs = null } = {}) {
  const dateFilter = fromMs && toMs
    ? `AND start_date >= '${new Date(fromMs).toISOString()}'::timestamptz AND start_date <= '${new Date(toMs).toISOString()}'::timestamptz`
    : fromMs
    ? `AND start_date >= '${new Date(fromMs).toISOString()}'::timestamptz`
    : '';

  const rows = await query(`
    SELECT
      COUNT(*)::int                                                                    AS total_drives,
      ROUND(SUM(distance)::numeric, 1)                                               AS total_distance_km,
      ROUND(SUM(GREATEST(0, start_ideal_range_km - end_ideal_range_km))::numeric, 1) AS total_range_consumed_km,
      ROUND(
        SUM(GREATEST(0, start_ideal_range_km - end_ideal_range_km)) * 165.0
        / NULLIF(SUM(distance), 0)
      )::int                                                                          AS avg_wh_per_km
    FROM drives
    WHERE end_date IS NOT NULL AND distance > 0.5 ${dateFilter}
  `);
  if (!rows) return null;
  const r = rows[0];
  const totalRangeKm = parseFloat(r.total_range_consumed_km) || 0;

  // Solar kWh charged in the same period from WattSnatch sessions
  const solarRow = fromMs
    ? db.getDb().prepare(
        'SELECT COALESCE(SUM(kwh_from_solar), 0) AS total FROM ev_home_charging_log WHERE session_start >= ? AND (? IS NULL OR session_start <= ?)'
      ).get(fromMs, toMs, toMs)
    : db.getDb().prepare(
        'SELECT COALESCE(SUM(kwh_from_solar), 0) AS total FROM ev_home_charging_log'
      ).get();
  const total_solar_kwh = parseFloat((solarRow?.total || 0).toFixed(1));

  return {
    total_drives:      r.total_drives,
    total_distance_km: parseFloat(r.total_distance_km) || 0,
    total_est_kwh:     parseFloat((totalRangeKm * 0.165).toFixed(1)),
    total_solar_kwh,
    avg_wh_per_km:     r.avg_wh_per_km || null,
  };
}

// GPS route for a single drive - downsampled to ≤120 points
async function getDriveRoute(driveId) {
  const rows = await query(
    'SELECT latitude, longitude FROM positions WHERE drive_id = $1 AND latitude IS NOT NULL ORDER BY date ASC',
    [driveId]
  );
  if (!rows || rows.length === 0) return null;
  const stride = Math.max(1, Math.floor(rows.length / 120));
  const points = [];
  for (let i = 0; i < rows.length; i += stride) {
    points.push([parseFloat(rows[i].latitude), parseFloat(rows[i].longitude)]);
  }
  // Always include the last point
  const last = rows[rows.length - 1];
  if (points[points.length - 1][0] !== parseFloat(last.latitude)) {
    points.push([parseFloat(last.latitude), parseFloat(last.longitude)]);
  }
  return points;
}

// Invalidate cache - call when connection URL changes
function invalidateCache() {
  _cache.clear();
  if (_pool) {
    _pool.end().catch(() => {});
    _pool = null;
    _lastUrl = null;
  }
}

module.exports = {
  getDrives,
  getDriveStats,
  getDriveRoute,
  getEfficiencyKwhPerKm,
  getSentryDrainRateKwhPerHour,
  getEfficiencyByDriveType,
  getBatteryHealthPercent,
  getFrequentDestinations,
  getChargeSessions,
  getTypicalArrivalSoc,
  getRecentDrivesNearHome,
  getDrivenKmInPeriod,
  getPublicChargeKwh,
  testConnection,
  invalidateCache,
};
