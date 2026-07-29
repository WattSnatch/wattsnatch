/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';
const db     = require('../db');
const logger = require('../utils/logger');

// Pull emails from CF worker, filter for bills, process with Gemini
async function pollOnce() {
  const workerUrl = db.getSetting('cf_worker_url');
  const secret    = db.getSetting('cf_worker_secret');
  const apiKey    = db.getSetting('gemini_api_key');
  const localPart = db.getSetting('bill_email_local') || 'bills';
  const model     = db.getSetting('gemini_model') || 'gemini-2.0-flash';

  if (!workerUrl || !secret || !apiKey) return;

  // 1. Pull emails
  const pullRes = await fetch(`${workerUrl}/pull`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!pullRes.ok) throw new Error(`Worker pull failed: ${pullRes.status}`);
  const { emails } = await pullRes.json();

  const billEmails = emails.filter(e => e.recipientLocalPart === localPart);
  if (!billEmails.length) return;

  const ackedIds = [];

  for (const email of billEmails) {
    try {
      // Find PDF attachment
      const pdf = email.attachments?.find(a =>
        a.mimeType === 'application/pdf' || a.filename?.endsWith('.pdf')
      );
      if (!pdf) {
        logger.logEvent('info', `Bill email ${email.id} had no PDF attachment - skipping`);
        ackedIds.push(email.id);
        continue;
      }

      // 2. Send to Gemini
      const extracted = await analyzeWithGemini(pdf.content, apiKey, model);

      // 3. Store in DB
      db.insertBill({
        created_at:                 Date.now(),
        email_id:                   email.id,
        billing_period_start:       extracted.billing_period_start ? new Date(extracted.billing_period_start).getTime() : null,
        billing_period_end:         extracted.billing_period_end   ? new Date(extracted.billing_period_end).getTime()   : null,
        retailer:                   extracted.retailer,
        account_number:             extracted.account_number,
        total_amount_aud:           extracted.total_amount_aud,
        gst_aud:                    extracted.gst_aud,
        supply_charge_aud:          extracted.supply_charge_aud,
        usage_charge_aud:           extracted.usage_charge_aud,
        solar_export_credit_aud:    extracted.solar_export_credit_aud ?? 0,
        total_kwh:                  extracted.total_kwh,
        peak_kwh:                   extracted.peak_kwh,
        off_peak_kwh:               extracted.off_peak_kwh,
        shoulder_kwh:               extracted.shoulder_kwh,
        solar_export_kwh:           extracted.solar_export_kwh ?? 0,
        supply_charge_cents_per_day: extracted.supply_charge_cents_per_day,
        peak_rate_cents:            extracted.peak_rate_cents,
        off_peak_rate_cents:        extracted.off_peak_rate_cents,
        shoulder_rate_cents:        extracted.shoulder_rate_cents,
        notes:                      extracted.notes,
        raw_json:                   JSON.stringify(extracted),
      });

      ackedIds.push(email.id);
      logger.logEvent('info', `Bill processed: ${extracted.retailer} ${extracted.billing_period_start} – ${extracted.billing_period_end}, $${extracted.total_amount_aud}`);
    } catch (err) {
      logger.logEvent('api_error', `Bill processing failed for ${email.id}: ${err.message}`);
    }
  }

  // 4. Ack processed emails
  if (ackedIds.length) {
    await fetch(`${workerUrl}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ackedIds }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

async function analyzeWithGemini(base64Pdf, apiKey, model) {
  const prompt = `Analyze this Australian electricity bill and return ONLY a JSON object with these fields (use null for missing values):
{
  "billing_period_start": "YYYY-MM-DD",
  "billing_period_end": "YYYY-MM-DD",
  "retailer": "company name",
  "account_number": "account number string",
  "total_amount_aud": 0.00,
  "gst_aud": 0.00,
  "supply_charge_aud": 0.00,
  "usage_charge_aud": 0.00,
  "solar_export_credit_aud": 0.00,
  "total_kwh": 0.00,
  "peak_kwh": null,
  "off_peak_kwh": null,
  "shoulder_kwh": null,
  "solar_export_kwh": null,
  "supply_charge_cents_per_day": null,
  "peak_rate_cents": null,
  "off_peak_rate_cents": null,
  "shoulder_rate_cents": null,
  "notes": "any important notes e.g. late payment fee, special charges"
}
Return ONLY the JSON object, no markdown fences, no explanation.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'application/pdf', data: base64Pdf } },
            { text: prompt },
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data   = await res.json();
  const text   = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  // Strip any accidental markdown fences
  const clean  = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

let _timer = null;

function start() {
  if (_timer) return;
  pollOnce().catch(err => logger.logEvent('api_error', `Bill poller: ${err.message}`));
  _timer = setInterval(() => {
    pollOnce().catch(err => logger.logEvent('api_error', `Bill poller: ${err.message}`));
  }, 60 * 60 * 1000); // hourly
  logger.logEvent('info', 'Bill poller: polling hourly');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, pollOnce, analyzeWithGemini };
