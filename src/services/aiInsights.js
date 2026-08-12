/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db     = require('../db');
const logger = require('../utils/logger');

// ── OpenRouter API call (OpenAI-compatible, free tier) ───────────────────────
// Free models can be flaky - try each in order until one succeeds
// Instruction-following models first; reasoning/thinking models last as they tend to
// leak their chain-of-thought into the output despite instructions.
const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'moonshotai/kimi-k2.6:free',
];

async function callOpenRouterModel(apiKey, model, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer':  'http://wattsnatch.local',
      'X-Title':       'WattSnatch',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0.4,
      messages: [
        { role: 'system', content: 'You are a concise home energy assistant. Output ONLY the briefing text wrapped in <briefing> tags. Do not think aloud, explain your reasoning, or write anything outside the tags.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw  = (data.choices?.[0]?.message?.content ?? '').trim();
  return stripThinking(raw);
}

// Strip chain-of-thought from reasoning models.
// Priority: extract <briefing>…</briefing> tags first (models are instructed to use them),
// then fall back to removing known reasoning patterns.
function stripThinking(text) {
  // Extract <briefing> block if present - most reliable signal
  const briefingMatch = text.match(/<briefing>([\s\S]*?)<\/briefing>/i);
  if (briefingMatch) return briefingMatch[1].trim();

  // Remove <think>…</think> blocks (DeepSeek, QwQ, etc.)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // If the model wrote a labelled section, keep only what follows the last one
  for (const marker of ['Final answer:', 'Briefing:', 'Draft:']) {
    const idx = text.lastIndexOf(marker);
    if (idx !== -1) { text = text.slice(idx + marker.length).trim(); break; }
  }

  // Drop leading lines that look like inline reasoning rather than the briefing itself.
  // A "real" briefing paragraph starts naturally (no reasoning prefixes, not a Paragraph N: header).
  const lines = text.split('\n');
  const startIdx = lines.findIndex(l => {
    const t = l.trim();
    if (!t) return false;
    return !/^(We |I |Let'?s |Note:|Paragraph\s*\d|Word count|Draft|Make sure|Assuming|Here |Summary|So |Now |First |Alright|The data|Looking at)/i.test(t);
  });
  return startIdx > 0 ? lines.slice(startIdx).join('\n').trim() : text;
}

async function callOpenRouter(apiKey, prompt) {
  const configured = db.getSetting('openrouter_model');
  const models = configured ? [configured] : FREE_MODELS;

  let lastErr;
  for (const model of models) {
    try {
      const text = await callOpenRouterModel(apiKey, model, prompt);
      if (text) {
        logger.logEvent('info', `[ai-insights] Used OpenRouter model: ${model}`);
        return text;
      }
    } catch (err) {
      logger.logEvent('info', `[ai-insights] Model ${model} failed: ${err.message.slice(0, 80)} - trying next`);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All OpenRouter models failed');
}

// ── Claude (Anthropic) API call ───────────────────────────────────────────────
async function callClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.content?.[0]?.text ?? '').trim();
}

// ── Gemini API call ───────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const model = db.getSetting('gemini_model') || db.DEFAULT_GEMINI_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        // No temperature/top_p/top_k - current Gemini models reject those
        // parameters rather than ignoring them, which fails the whole request.
        generationConfig: { maxOutputTokens: 512 },
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
}

async function generateInsight() {
  const openRouterKey = db.getSetting('openrouter_api_key');
  const claudeKey     = db.getSetting('anthropic_api_key');
  const geminiKey     = db.getSetting('gemini_api_key');

  if (!openRouterKey && !claudeKey && !geminiKey) {
    logger.logEvent('info', '[ai-insights] No AI API key configured - skipping');
    return null;
  }

  const now  = Date.now();
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);
  const weekMs = weekStart.getTime();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const evToday    = db.getPeriodStats(todayMs,  now);
  const hwToday    = db.getEddiPeriodStats(todayMs,  now);
  const houseToday = db.getHousePeriodStats(todayMs, now);

  const evWeek     = db.getPeriodStats(weekMs,  now);
  const hwWeek     = db.getEddiPeriodStats(weekMs,  now);
  const houseWeek  = db.getHousePeriodStats(weekMs, now);

  // Battery: live telemetry first, fall back to last non-zero DB reading
  const telemetry = require('./telemetry');
  let batteryPct = telemetry.getState()?.batteryPct || null;
  if (!batteryPct) {
    const row = db.getDb().prepare(
      'SELECT battery_pct FROM telemetry_log WHERE battery_pct > 0 ORDER BY recorded_at DESC LIMIT 1'
    ).get();
    batteryPct = row?.battery_pct || null;
  }

  // Upcoming trips (next 48 h)
  const tripPlanner  = require('./tripPlanner');
  const tomorrowEnd  = new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000);
  const { assessments } = tripPlanner.getAssessments();
  const upcomingTrips = assessments
    .filter(({ trip }) => trip.departureTime >= now && trip.departureTime < tomorrowEnd.getTime())
    .slice(0, 3)
    .map(({ trip, assessment }) => {
      const time = new Date(trip.departureTime).toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit',
      });
      const dayLabel = trip.departureTime < todayStart.getTime() + 24 * 60 * 60 * 1000
        ? 'Today' : 'Tomorrow';
      const status = assessment.status === 'SOLAR_WILL_COVER' ? 'solar will cover it'
        : assessment.status === 'NEEDS_ATTENTION'
          ? `needs ~${assessment.solarShortfall?.toFixed(1) ?? '?'} kWh top-up`
          : 'battery is fine';
      return `${dayLabel} ${time} - ${trip.summary} (${status})`;
    });

  const solcast      = require('./solcast');
  const remaining    = solcast.getRemainingTodayForecast();
  const tomorrow     = solcast.getTomorrowForecast();
  const dailyTotals  = db.getSolcastDailyTotals();

  const dateStr = new Date().toLocaleDateString('en-AU', {
    timeZone: 'Australia/Brisbane',
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeStr = new Date().toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Brisbane',
    hour: '2-digit', minute: '2-digit',
  });

  const prompt = buildPrompt({
    dateStr, timeStr, batteryPct, upcomingTrips,
    evToday, evWeek, hwToday, hwWeek, houseToday, houseWeek,
    remaining, tomorrow, dailyTotals,
  });

  // Priority: OpenRouter (free) → Claude → Gemini
  let text;
  if (openRouterKey) {
    text = await callOpenRouter(openRouterKey, prompt);
  } else if (claudeKey) {
    text = await callClaude(claudeKey, prompt);
  } else {
    text = await callGemini(geminiKey, prompt);
  }

  db.setSetting('ai_insight_text',         text);
  db.setSetting('ai_insight_generated_at', String(now));

  logger.logEvent('info', '[ai-insights] Generated successfully');
  return text;
}

function buildPrompt({ dateStr, timeStr, batteryPct, upcomingTrips, evToday, evWeek, hwToday, hwWeek, houseToday, houseWeek, remaining, tomorrow, dailyTotals }) {
  const forecastLines = dailyTotals.slice(0, 5).map((d, i) => {
    const label = i === 0 ? 'Today (remaining)' : i === 1 ? 'Tomorrow' : d.day;
    return `  ${label}: ${d.kwh.toFixed(1)} kWh`;
  }).join('\n');

  const avgEvKwh    = (evWeek.total_kwh    / 7).toFixed(1);
  const avgHwKwh    = (hwWeek.total_kwh    / 7).toFixed(1);
  const avgHouseKwh = (houseWeek.house_kwh / 7).toFixed(1);

  const tripLines = upcomingTrips.length > 0
    ? upcomingTrips.map(t => `  - ${t}`).join('\n')
    : '  None in the next 48 hours';

  return `You are an AI energy assistant for a solar-powered home. The home has rooftop solar panels, a Tesla EV, and an Eddi hot water diverter that automatically uses excess solar to heat water.

## Current Status (${dateStr}, ${timeStr} AEST)
- Tesla battery: ${batteryPct !== null ? batteryPct + '%' : 'not available - assume adequate unless trips say otherwise'} (minimum safe level: 20%)

## Solar Forecast
${forecastLines || '  No forecast data available'}

## Today's Energy So Far
- House: ${houseToday.house_kwh} kWh (${houseToday.solar_kwh} kWh solar, ${houseToday.grid_kwh} kWh grid, ${houseToday.self_pct}% solar-powered)
- EV charging: ${evToday.total_kwh} kWh (${evToday.solar_kwh} kWh solar, ${evToday.grid_kwh} kWh grid)
- Hot water: ${hwToday.total_kwh} kWh total (${hwToday.boost_kwh} kWh grid boost)

## 7-Day Averages
- House: ${avgHouseKwh} kWh/day (${houseWeek.self_pct}% solar)
- EV: ${avgEvKwh} kWh/day (grid boost this week: ${evWeek.grid_kwh.toFixed(1)} kWh total)
- Hot water: ${avgHwKwh} kWh/day (grid boost this week: ${hwWeek.boost_kwh.toFixed(1)} kWh total)

## Upcoming Trips (next 48 h)
${tripLines}

## Your Task
Write a concise energy briefing in 3 short paragraphs - no headers, no bullet points, flowing text only.

Paragraph 1 (Hot Water): Will there be enough solar today/tomorrow to heat the water without a grid boost? The Eddi diverts excess solar automatically. Note if recent boost usage suggests cloudy conditions or high demand.

Paragraph 2 (EV + Trips): Cover two things - first, is today a good opportunity to charge on solar given the battery level and forecast? Second, mention any upcoming trips and whether the car needs a top-up to make them comfortably. If there are no trips, just give the charging recommendation.

Paragraph 3 (Laundry + Overall): Is today a good day to run the washing machine? Base this on the solar forecast - a sunny day (15+ kWh remaining) means free washing. Then one sentence on the overall energy outlook.

Keep it under 200 words, friendly, and practical. Australian English.

Output ONLY the final briefing wrapped in <briefing> tags, like this:
<briefing>
[your three paragraphs here]
</briefing>
Do not write anything outside the tags.`;
}

function getInsight() {
  return {
    text:         db.getSetting('ai_insight_text') || null,
    generated_at: db.getSetting('ai_insight_generated_at')
      ? parseInt(db.getSetting('ai_insight_generated_at'), 10)
      : null,
  };
}

// Schedule generation at 06:30 and 21:00 local time (aligns with notifications)
let _timer = null;

function scheduleNext() {
  const now   = new Date();
  const targets = [{ h: 6, m: 30 }, { h: 21, m: 0 }];

  // Find ms until next target
  let msUntil = Infinity;
  for (const t of targets) {
    const target = new Date(now);
    target.setHours(t.h, t.m, 0, 0);
    let diff = target.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 60 * 60 * 1000; // tomorrow
    if (diff < msUntil) msUntil = diff;
  }

  _timer = setTimeout(async () => {
    try {
      await generateInsight();
    } catch (err) {
      logger.logEvent('api_error', `[ai-insights] Generation failed: ${err.message}`);
    }
    scheduleNext(); // schedule the next one
  }, msUntil);

  const fireAt = new Date(Date.now() + msUntil).toLocaleTimeString('en-AU', {
    timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit',
  });
  logger.logEvent('info', `[ai-insights] Next generation scheduled at ${fireAt} AEST`);
}

function start() {
  // Generate on startup if no insight or last one is older than 14 hours
  const { generated_at } = getInsight();
  const stale = !generated_at || (Date.now() - generated_at) > 14 * 60 * 60 * 1000;
  if (stale) {
    generateInsight().catch(err =>
      logger.logEvent('api_error', `[ai-insights] Startup generation failed: ${err.message}`)
    );
  }
  scheduleNext();
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { start, stop, generateInsight, getInsight };
