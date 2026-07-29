/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Shared utilities ───

/**
 * Fetch wrapper with JSON defaults.
 */
async function api(path, options = {}) {
  const defaults = {
    headers: { 'Content-Type': 'application/json' },
  };
  if (options.body && typeof options.body === 'object') {
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, { ...defaults, ...options, headers: { ...defaults.headers, ...(options.headers || {}) } });
  const data = await res.json();
  return data;
}

/**
 * Format watts: <1000 = "421 W", >=1000 = "1.2 kW"
 */
function formatWatts(w) {
  if (w === null || w === undefined || isNaN(w)) return '- W';
  const abs = Math.abs(w);
  if (abs >= 1000) {
    return (w / 1000).toFixed(1) + ' kW';
  }
  return Math.round(w).toLocaleString() + ' W';
}

/**
 * Format amps.
 */
function formatAmps(a) {
  if (a === null || a === undefined || isNaN(a)) return '- A';
  return Math.round(a) + ' A';
}

/**
 * Format percent.
 */
function formatPercent(p) {
  if (p === null || p === undefined || isNaN(p)) return '-%';
  return Math.round(p) + '%';
}

/**
 * Format duration in seconds: "1h 32m" or "45s"
 */
function formatDuration(secs) {
  if (!secs || isNaN(secs)) return '0s';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format Unix ms timestamp as "14:23:07"
 */
function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * Format Unix ms timestamp as "15 May 2026"
 */
function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * "X ago" from a Unix ms timestamp.
 */
function timeAgo(ts) {
  if (!ts) return '-';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return formatDate(ts);
}

/**
 * Smoothly animate a number element from current displayed value to a new value.
 */
function animateNumber(el, toValue, formatter) {
  if (!el) return;
  const fromText = el.textContent.replace(/[^0-9.-]/g, '');
  const from = parseFloat(fromText) || 0;
  const to = toValue;
  if (Math.abs(from - to) < 0.5) {
    el.textContent = formatter(to);
    return;
  }
  const start = performance.now();
  const duration = 400;
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const current = from + (to - from) * eased;
    el.textContent = formatter(current);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = formatter(to);
  }
  requestAnimationFrame(step);
}

/**
 * Set text content and apply brief highlight transition.
 */
function updateEl(el, text) {
  if (!el) return;
  if (el.textContent !== text) {
    el.textContent = text;
    el.classList.add('updating');
    setTimeout(() => el.classList.remove('updating'), 300);
  }
}

/**
 * Build the savings-breakdown sub-row HTML for a bill.
 * Returns an HTML string for a <tr> that spans all columns.
 *   colSpan  - number of columns in the parent table
 *   bill     - bill object with car_savings_aud, hw_savings_aud, savings_pct
 */
function billBreakdownRow(bill, colSpan) {
  const car  = bill.car_savings_aud  || 0;
  const hw   = bill.hw_savings_aud   || 0;
  const total = car + hw;
  if (total <= 0) return '';

  const carPct = Math.round((car  / total) * 100);
  const hwPct  = 100 - carPct;
  const pct    = bill.savings_pct || 0;

  return `<tr class="bill-breakdown-row">
    <td colspan="${colSpan}" style="padding:0.85rem 0.75rem 1.25rem;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:1.75rem;flex-wrap:wrap;row-gap:0.75rem">
        <!-- EV bar -->
        <div style="display:flex;align-items:center;gap:0.65rem;min-width:170px">
          <span style="font-size:0.72rem;color:var(--accent-charge);font-weight:600;width:60px">🚗 EV</span>
          <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;min-width:70px">
            <div style="height:100%;width:${carPct}%;background:var(--accent-charge);border-radius:3px;transition:width 0.4s"></div>
          </div>
          <span style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--accent-charge);font-weight:600;white-space:nowrap">$${car.toFixed(2)}</span>
          <span style="font-size:0.68rem;color:var(--text-tertiary)">${carPct}%</span>
        </div>
        <!-- HW bar -->
        <div style="display:flex;align-items:center;gap:0.65rem;min-width:170px">
          <span style="font-size:0.72rem;color:#fb923c;font-weight:600;width:60px">💧 HW</span>
          <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;min-width:70px">
            <div style="height:100%;width:${hwPct}%;background:#fb923c;border-radius:3px;transition:width 0.4s"></div>
          </div>
          <span style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:#fb923c;font-weight:600;white-space:nowrap">$${hw.toFixed(2)}</span>
          <span style="font-size:0.68rem;color:var(--text-tertiary)">${hwPct}%</span>
        </div>
        <!-- Reduction badge -->
        <span style="margin-left:auto;font-size:0.72rem;font-weight:700;background:rgba(74,222,128,0.12);color:#4ade80;padding:0.3rem 0.65rem;border-radius:4px;white-space:nowrap">
          bill reduced by ${pct}%
        </span>
      </div>
    </td>
  </tr>`;
}

/**
 * Get state badge HTML.
 */
function stateBadge(state) {
  const s = (state || 'IDLE').toUpperCase();
  return `<span class="badge badge-state-${s.toLowerCase()}">${s}</span>`;
}

/**
 * Mark a nav link as active based on current page.
 */
function markActiveNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.topbar-nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === path || (path === '/' && a.getAttribute('href') === '/'));
  });
}

// Run nav marking on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', markActiveNav);
} else {
  markActiveNav();
}

/**
 * Show an "Update available" pill in the top bar if a newer release exists.
 * Server-side cached (~12h) so this is cheap to call on every page load.
 * Silently does nothing on pages with no topbar (login/setup) or if the
 * check fails/is disabled - never shows an error to the user.
 */
async function checkForUpdateBadge() {
  const topbarRight = document.querySelector('.topbar-right');
  if (!topbarRight) return;
  try {
    const data = await api('/api/version/check');
    if (!data.ok || !data.updateAvailable || data.disabled) return;

    const badge = document.createElement('a');
    badge.id = 'update-badge';
    badge.className = 'pill pill-warn';
    badge.href = data.releaseUrl || 'https://github.com/WattSnatch/wattsnatch/releases';
    badge.target = '_blank';
    badge.rel = 'noopener';
    badge.style.textDecoration = 'none';
    badge.style.cursor = 'pointer';
    badge.title = `${data.releaseName || 'New version'} available (you're on v${data.current})`;
    badge.textContent = `Update available: v${data.latest}`;
    topbarRight.insertBefore(badge, topbarRight.firstChild);
  } catch (_err) {
    // Offline, blocked, whatever - just don't show the badge.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkForUpdateBadge);
} else {
  checkForUpdateBadge();
}

// ─── WattSnatch mark generator ───
// Inlines full SVG content with unique IDs per instance so url() gradient/filter
// references always resolve within the same SVG element (no shadow-tree issues).
(function () {
  let __n = 0;

  function markFull(n) {
    return `<defs>
      <linearGradient id="wbg${n}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
        <stop offset="0%"   stop-color="#1e2438"/>
        <stop offset="100%" stop-color="#0f1117"/>
      </linearGradient>
      <radialGradient id="wbh${n}" gradientUnits="userSpaceOnUse" cx="50" cy="30" r="55">
        <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="wbo${n}" gradientUnits="userSpaceOnUse" x1="65" y1="8" x2="32" y2="92">
        <stop offset="0%"   stop-color="#ffe066"/>
        <stop offset="45%"  stop-color="#f5a623"/>
        <stop offset="100%" stop-color="#d9730d"/>
      </linearGradient>
      <linearGradient id="war${n}" gradientUnits="userSpaceOnUse" x1="50" y1="78" x2="50" y2="17">
        <stop offset="0%"   stop-color="#f5a623" stop-opacity="0.06"/>
        <stop offset="60%"  stop-color="#f5a623" stop-opacity="0.52"/>
        <stop offset="100%" stop-color="#f5a623" stop-opacity="0.85"/>
      </linearGradient>
      <filter id="wgl${n}" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="wam${n}" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="8"/>
      </filter>
    </defs>
    <rect x="0" y="0" width="100" height="100" rx="22" ry="22" fill="url(#wbg${n})"/>
    <rect x="0" y="0" width="100" height="100" rx="22" ry="22" fill="url(#wbh${n})"/>
    <rect x="0.75" y="0.75" width="98.5" height="98.5" rx="21.4" ry="21.4"
          fill="none" stroke="#ffffff" stroke-width="0.75" stroke-opacity="0.07"/>
    <ellipse cx="49" cy="52" rx="20" ry="24" fill="#f5a623" opacity="0.12" filter="url(#wam${n})"/>
    <path d="M 19 78 C 5 54 10 26 30 17"
          stroke="url(#war${n})" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <path d="M 81 78 C 95 54 90 26 70 17"
          stroke="url(#war${n})" stroke-width="3.8" stroke-linecap="round" fill="none"/>
    <circle cx="30" cy="17" r="2.2" fill="#f5a623" opacity="0.8"/>
    <circle cx="70" cy="17" r="2.2" fill="#f5a623" opacity="0.8"/>
    <polygon points="66,8 36,54 52,54 30,92 64,46 48,46"
             fill="url(#wbo${n})" filter="url(#wgl${n})"/>`;
  }

  function renderMarks() {
    document.querySelectorAll('svg[data-ws-mark]').forEach(function (svg) {
      const v = svg.getAttribute('data-ws-mark');
      const n = ++__n;
      if (v === 'full') svg.innerHTML = markFull(n);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderMarks);
  } else {
    renderMarks();
  }
})();

// ─── Mobile hamburger menu ───
document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.getElementById('topbar-hamburger');
  const nav       = document.querySelector('.topbar-nav');
  if (!hamburger || !nav) return;

  hamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    nav.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', nav.classList.contains('open'));
  });

  // Close when a nav link is tapped
  nav.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') nav.classList.remove('open');
  });

  // Close when tapping outside
  document.addEventListener('click', () => nav.classList.remove('open'));
});

// ─── Auth: inject logout link when password auth is enabled ─────────────────
(async () => {
  try {
    const r = await fetch('/api/auth/status');
    if (!r.ok) return;
    const { authEnabled } = await r.json();
    if (!authEnabled) return;

    // Show existing #logout-link (index.html) or inject into .topbar-right
    const existing = document.getElementById('logout-link');
    if (existing) {
      existing.style.display = '';
      return;
    }

    const right = document.querySelector('.topbar-right');
    if (!right) return;
    const a = document.createElement('a');
    a.href = '/logout';
    a.textContent = 'Sign out';
    a.title = 'Sign out';
    a.style.cssText = 'font-size:0.78rem;color:var(--text-secondary);text-decoration:none;padding:0.25rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius-md);transition:color 0.15s;white-space:nowrap';
    right.appendChild(a);
  } catch (_) {}
})();
