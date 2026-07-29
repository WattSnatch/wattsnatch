/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Logs page ───

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

async function loadApiCostCard() {
  try {
    const data = await api('/api/stats/api-cost');
    if (!data.ok) return;

    const card = document.getElementById('api-cost-card');
    if (!card) return;
    card.style.display = '';

    // Month label
    document.getElementById('api-cost-month').textContent =
      `${MONTH_NAMES[data.month - 1]} ${data.year}`;

    // Breakdown chips
    const breakdown = document.getElementById('api-cost-breakdown');
    breakdown.innerHTML = '';
    const items = [
      { label: 'Commands', count: data.counts.command, cost: data.costs.command },
      { label: 'Data polls', count: data.counts.data,    cost: data.costs.data    },
      { label: 'Wakes',     count: data.counts.wake,     cost: data.costs.wake    },
    ];
    for (const item of items) {
      const chip = document.createElement('div');
      chip.style.cssText = 'background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-md);padding:0.5rem 0.75rem;min-width:130px';
      chip.innerHTML = `
        <div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.2rem">${item.label}</div>
        <div style="font-size:1rem;font-weight:700">${item.count.toLocaleString()}</div>
        <div style="font-size:0.78rem;color:var(--accent-solar)">$${item.cost.toFixed(4)}</div>
      `;
      breakdown.appendChild(chip);
    }

    // Total + progress bar
    const pct = Math.min(100, (data.total / data.budget) * 100);
    const projPct = Math.min(100, (data.projected / data.budget) * 100);
    document.getElementById('api-cost-total').textContent = `$${data.total.toFixed(4)}`;
    document.getElementById('api-cost-projected').textContent = `$${data.projected.toFixed(2)}`;
    const bar = document.getElementById('api-cost-bar');
    bar.style.width = `${pct}%`;
    bar.style.background = projPct > 90 ? '#fc814a' : projPct > 70 ? '#f5c542' : 'var(--accent-solar)';

    // Status badge
    const statusEl = document.getElementById('api-cost-status');
    if (data.onTrack) {
      statusEl.textContent = '✓ On track to stay within budget';
      statusEl.style.cssText = 'font-size:0.82rem;font-weight:600;padding:0.3rem 0.75rem;border-radius:var(--radius-md);background:rgba(74,222,128,0.12);color:#4ade80';
    } else {
      statusEl.textContent = '⚠ Likely to exhaust free budget';
      statusEl.style.cssText = 'font-size:0.82rem;font-weight:600;padding:0.3rem 0.75rem;border-radius:var(--radius-md);background:rgba(252,129,74,0.12);color:#fc814a';
    }
  } catch (err) {
    console.error('API cost load error:', err);
  }
}


let activeFilter = 'all';
let displayedIds = new Set();
let allEntries = [];
const MAX_VISIBLE = 500;

function renderEntries(entries) {
  const container = document.getElementById('log-container');
  if (!container) return;
  container.innerHTML = '';
  const filtered = activeFilter === 'all' ? entries : entries.filter((e) => e.event_type === activeFilter);
  const visible = filtered.slice(0, MAX_VISIBLE);
  if (!visible.length) {
    container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-secondary)">No log entries</div>';
    return;
  }
  for (const e of visible) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `
      <span class="log-time">${formatTime(e.occurred_at)}</span>
      <span class="badge badge-${e.event_type}">${e.event_type}</span>
      <div class="log-details">
        ${e.details || ''}
        ${e.old_state ? `<div class="log-states">${e.old_state} → ${e.new_state}</div>` : ''}
      </div>
    `;
    container.appendChild(div);
  }
}

async function loadLogs() {
  try {
    const data = await api(`/api/logs?page=1&limit=200&type=${activeFilter}`);
    if (!data.ok) return;
    allEntries = data.events || [];
    renderEntries(allEntries);
  } catch (err) {
    console.error('Load logs error:', err);
  }
}

function connectSSEForLogs() {
  const source = new EventSource('/api/events');
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'state_change' || data.type === 'command' || data.type === 'api_error' || data.type === 'info') {
        loadLogs();
      }
      if (data.type === 'command' || data.type === 'api_cost') {
        loadApiCostCard();
      }
    } catch (_err) {}
  };
  source.onerror = () => {
    setTimeout(connectSSEForLogs, 5000);
    source.close();
  };
}

async function clearDisplay() {
  try {
    await api('/api/logs', { method: 'DELETE' });
    allEntries = [];
    renderEntries([]);
  } catch (_err) {}
}

document.addEventListener('DOMContentLoaded', () => {
  loadLogs();
  loadApiCostCard();
  connectSSEForLogs();

  // Filter buttons
  document.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('btn-primary'));
      btn.classList.add('btn-primary');
      loadLogs();
    });
  });

  const clearBtn = document.getElementById('clear-logs-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearDisplay);

  // Auto-refresh every 10s; cost card every 60s
  setInterval(loadLogs, 10000);
  setInterval(loadApiCostCard, 60000);
});
