/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Bills page ───

function formatPeriod(startMs, endMs) {
  if (!startMs) return '-';
  const opts = { month: 'short', year: 'numeric' };
  const start = new Date(startMs).toLocaleDateString('en-AU', opts);
  if (!endMs) return start;
  const end = new Date(endMs).toLocaleDateString('en-AU', opts);
  if (start === end) return start;
  // If same year, omit year from start
  const startY = new Date(startMs).getFullYear();
  const endY   = new Date(endMs).getFullYear();
  if (startY === endY) {
    const startShort = new Date(startMs).toLocaleDateString('en-AU', { month: 'short' });
    return `${startShort} – ${end}`;
  }
  return `${start} – ${end}`;
}

function fmtAud(val) {
  if (val == null) return '-';
  return '$' + parseFloat(val).toFixed(2);
}

function fmtKwh(val) {
  if (val == null) return '-';
  return parseFloat(val).toFixed(1) + ' kWh';
}

// One metric inside the accuracy panel: billed value vs WattSnatch's recorded
// value as paired bars (billed = amber reference, WattSnatch = green), with a
// "captured %" badge. Bars are scaled against whichever value is larger so an
// overcount reads just as clearly as an undercount.
function accuracyMetric(label, billVal, wsVal, fmtFn) {
  if (billVal == null || billVal <= 0 || wsVal == null) return { html: '', pct: null };
  const pct = Math.round((wsVal / billVal) * 100);
  const pctClass = (pct >= 90 && pct <= 110) ? 'good' : (pct >= 70 && pct <= 130) ? 'ok' : 'low';
  const maxVal = Math.max(billVal, wsVal);
  const billW = Math.round((billVal / maxVal) * 100);
  const wsW   = Math.round((wsVal   / maxVal) * 100);
  const html = `
    <div>
      <div class="accuracy-metric-label">${label}<span class="accuracy-pct ${pctClass}">${pct}%</span></div>
      <div class="accuracy-bar-row">
        <span class="accuracy-bar-who">Bill</span>
        <div class="accuracy-bar-track"><div class="accuracy-bar-fill bill" style="width:${billW}%"></div></div>
        <span class="accuracy-bar-val">${fmtFn(billVal)}</span>
      </div>
      <div class="accuracy-bar-row">
        <span class="accuracy-bar-who">WattSnatch</span>
        <div class="accuracy-bar-track"><div class="accuracy-bar-fill ws" style="width:${wsW}%"></div></div>
        <span class="accuracy-bar-val">${fmtFn(wsVal)}</span>
      </div>
    </div>`;
  return { html, pct };
}

// Full-width sub-row comparing the bill's figures to what WattSnatch recorded
// over the exact same billing period.
function accuracyPanelRow(bill, colSpan) {
  const a = bill.accuracy;
  if (!a) return null;

  const computed = [
    accuracyMetric('Grid Usage',   bill.total_kwh,        a.kwh_imported,     fmtKwh),
    accuracyMetric('Solar Export', bill.solar_export_kwh, a.kwh_exported,     fmtKwh),
    accuracyMetric('Total Cost',   bill.total_amount_aud, a.estimated_total,  fmtAud),
  ].filter(m => m.html);
  if (computed.length === 0) return null;
  const metrics = computed.map(m => m.html).join('');

  // Coverage measured in hours of telemetry, not in calendar days that happen to
  // contain at least one reading. The old day-count treated a day with a single
  // row as complete, so July 2026 reported "32 of 31 days recorded" while 50.7
  // hours were actually missing - a full-coverage chip sitting next to a 94% cost
  // match, with nothing on screen to explain the gap. Falls back to the day count
  // when talking to a server that doesn't send coverage_pct yet.
  const hasCoverage  = a.coverage_pct != null;
  const fullCoverage = hasCoverage ? a.coverage_pct >= 98 : a.days_recorded >= a.period_days;
  const chipClass    = fullCoverage ? 'full' : 'partial';
  const chipText     = hasCoverage
    ? `${a.coverage_pct}% of the period recorded`
    : `${a.days_recorded} of ${a.period_days} days recorded`;

  // A metric can still read well off target even with full coverage - solar
  // export especially, since it's often brief midday spikes that a smart meter
  // captures continuously but WattSnatch only samples every few seconds. Say so
  // rather than blaming "rate rounding" for what's really a resolution gap.
  const worstOff = computed.reduce((min, m) => Math.abs(m.pct - 100) > Math.abs(min - 100) ? m.pct : min, 100);
  let note;
  if (!fullCoverage && hasCoverage) {
    note = `WattSnatch has telemetry for ${a.coverage_pct}% of this billing period`
      + (a.unrecorded_hours ? ` (${a.unrecorded_hours.toFixed(1)} hours had no readings)` : '')
      + `. Energy is only counted from readings that exist, so import, export and cost all read low here by roughly that much. This is a data gap, not a tariff problem.`;
  } else if (!fullCoverage) {
    note = `WattSnatch only has data for ${a.days_recorded} of the ${a.period_days} billed days, so its figures are expected to read low for this period.`;
  } else if (worstOff < 85 || worstOff > 115) {
    note = 'WattSnatch recorded data for essentially all of this billing period. The remaining gap is likely brief grid activity between polls (e.g. short export spikes) that a continuously-sampling smart meter catches and WattSnatch\'s periodic polling can miss, rather than a data recording problem.';
  } else {
    note = 'WattSnatch recorded data for essentially all of this billing period. Remaining differences come from meter accuracy and rate rounding.';
  }

  return `
    <tr class="accuracy-row">
      <td colspan="${colSpan}">
        <div class="accuracy-panel">
          <div class="accuracy-header">
            <span class="accuracy-title">Bill vs WattSnatch - how close were we?</span>
            <span class="coverage-chip ${chipClass}">${chipText}</span>
          </div>
          <div class="accuracy-grid">${metrics}</div>
          <div class="accuracy-note">${note}</div>
        </div>
      </td>
    </tr>`;
}

async function loadBills() {
  const tbody = document.getElementById('bills-tbody');
  try {
    const data = await api('/api/stats/bills/comparison');
    if (!data.ok) {
      tbody.innerHTML = `<tr class="no-bills-row"><td colspan="8">Error loading bills</td></tr>`;
      return;
    }

    // Check if Gemini is configured
    const settingsData = await api('/api/settings');
    const geminiKey = settingsData?.settings?.gemini_api_key || '';
    const banner = document.getElementById('gemini-banner');
    if (banner) {
      if (!geminiKey) {
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    }

    const bills = data.bills || [];
    if (bills.length === 0) {
      tbody.innerHTML = `<tr class="no-bills-row"><td colspan="8">No bills yet. Upload a PDF above, or forward one to the address shown under Settings &rarr; Bill Analysis.</td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    for (const bill of bills) {
      const tr = document.createElement('tr');

      const exportCredit = (bill.solar_export_credit_aud || 0) > 0
        ? `<span class="num text-green">${fmtAud(bill.solar_export_credit_aud)}</span>`
        : `<span class="text-muted">-</span>`;

      const savings = bill.wattsnatch_savings_aud > 0
        ? `<span class="num text-green">${fmtAud(bill.wattsnatch_savings_aud)}</span>`
        : `<span class="text-muted">-</span>`;

      const withoutWS = bill.without_wattsnatch_aud > 0
        ? `<span class="num text-red">${fmtAud(bill.without_wattsnatch_aud)}</span>`
        : `<span class="text-muted">-</span>`;

      tr.style.borderBottom = 'none';
      tr.innerHTML = `
        <td style="padding-bottom:0.3rem">${formatPeriod(bill.billing_period_start, bill.billing_period_end)}</td>
        <td style="padding-bottom:0.3rem">${bill.retailer || '-'}</td>
        <td style="padding-bottom:0.3rem"><span class="num">${fmtKwh(bill.total_kwh)}</span></td>
        <td style="padding-bottom:0.3rem"><span class="num">${fmtAud(bill.total_amount_aud)}</span></td>
        <td style="padding-bottom:0.3rem">${exportCredit}</td>
        <td style="padding-bottom:0.3rem">${savings}</td>
        <td style="padding-bottom:0.3rem">${withoutWS}</td>
        <td style="padding-bottom:0.3rem">
          <button class="del-btn" title="Delete bill" onclick="deleteBill(${bill.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
      // Breakdown sub-row (EV vs HW split)
      const breakdown = billBreakdownRow(bill, 8);
      if (breakdown) {
        const tmp = document.createElement('tbody');
        tmp.innerHTML = breakdown;
        tbody.appendChild(tmp.firstElementChild);
      }
      // Bill-vs-WattSnatch accuracy panel for the same billing period
      const accPanel = accuracyPanelRow(bill, 8);
      if (accPanel) {
        const tmp = document.createElement('tbody');
        tmp.innerHTML = accPanel;
        tbody.appendChild(tmp.firstElementChild);
      }
    }
  } catch (err) {
    tbody.innerHTML = `<tr class="no-bills-row"><td colspan="8">Error: ${err.message}</td></tr>`;
  }
}

async function deleteBill(id) {
  if (!confirm('Delete this bill?')) return;
  try {
    const data = await api(`/api/bills/${id}`, { method: 'DELETE' });
    if (data.ok) {
      loadBills();
    } else {
      alert('Delete failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function pollNow() {
  const btn = document.getElementById('poll-btn');
  const status = document.getElementById('poll-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (status) { status.textContent = 'Polling for new bills…'; status.style.display = 'block'; }

  try {
    const data = await api('/api/bills/poll', { method: 'POST', body: {} });
    if (data.ok) {
      if (status) status.textContent = 'Done. Reloading…';
      setTimeout(() => {
        loadBills();
        if (status) status.style.display = 'none';
      }, 3000);
    } else {
      if (status) { status.textContent = 'Error: ' + (data.error || 'Unknown'); }
    }
  } catch (err) {
    if (status) { status.textContent = 'Error: ' + err.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for new bills'; }
  }
}

// ─── PDF upload ──────────────────────────────────────────────────────────────

function setUploadStatus(type, msg) {
  const el = document.getElementById('upload-status');
  if (!el) return;
  el.className = type;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

async function uploadBill(file) {
  if (!file) return;
  // Accept application/pdf OR empty type (some browsers/OS report '' for dropped PDFs)
  const looksLikePdf = file.type === 'application/pdf' || file.type === '' || file.name?.toLowerCase().endsWith('.pdf');
  if (!looksLikePdf) {
    setUploadStatus('error', 'Please choose a PDF file.');
    return;
  }

  const zone = document.getElementById('upload-zone');
  if (zone) zone.classList.add('processing');
  setUploadStatus('info', `Analysing ${file.name} with Gemini…`);

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = (e) => resolve(e.target.result.split(',')[1]); // strip data:...;base64,
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const data = await api('/api/bills/upload', {
      method: 'POST',
      body: { pdf: base64, filename: file.name },
    });

    if (data.ok) {
      const x = data.extracted;
      const period = x.billing_period_start
        ? `${x.billing_period_start} – ${x.billing_period_end || '?'}`
        : 'unknown period';
      setUploadStatus('ok', `✓ Bill imported - ${x.retailer || 'unknown retailer'}, ${period}, $${(x.total_amount_aud || 0).toFixed(2)}`);
      loadBills();
    } else {
      setUploadStatus('error', 'Import failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    setUploadStatus('error', 'Error: ' + err.message);
  } finally {
    const zone = document.getElementById('upload-zone');
    if (zone) zone.classList.remove('processing');
    // Reset file input - wrapped in try/catch as Safari throws on value assignment
    try {
      const input = document.getElementById('bill-file-input');
      if (input) input.value = '';
    } catch (_) {}
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadBills();

  // File input change
  const input = document.getElementById('bill-file-input');
  if (input) {
    input.addEventListener('change', () => {
      if (input.files[0]) uploadBill(input.files[0]);
    });
  }

  // Drag and drop
  const zone = document.getElementById('upload-zone');
  if (zone) {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) uploadBill(file);
    });
  }
});
