/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Which AI provider writes the dashboard briefing is now a setting rather than a
// side effect of which keys happen to exist.
//
// The old behaviour: generateInsight() took the first key present in the order
// OpenRouter, Claude, Gemini. An install with an OpenRouter key could therefore
// never use Gemini, even with a Gemini key already saved for bill parsing, and
// the only way to switch was to delete the OpenRouter key. The free OpenRouter
// tier is the weakest of the three, so that was the default nobody chose.
//
// Two things must stay true while making it selectable, and both are pinned here.
//
// 1. An install that never touches the new setting keeps the exact behaviour it
//    had. That is the whole "do not break anything" requirement: the default
//    resolves to OpenRouter.
// 2. Choosing a provider whose key is blank must not mean no briefing at all.
//    Silently writing nothing every morning is the worst outcome of the three,
//    so it falls back to any provider that is actually configured and says so.
//
// The same resolution now gates POST /api/ai-insights/refresh. That endpoint
// used to require gemini_api_key unconditionally while generation preferred
// OpenRouter, so an OpenRouter-only install got a 400 from the dashboard refresh
// button while the scheduled 6:30 am and 9 pm runs worked. The openRouterOnly
// case below is that bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-aiprovider-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const aiInsights = require('../src/services/aiInsights');

// Every key is set on every call so no test inherits another's state.
function configure({ openrouter = '', claude = '', gemini = '', provider = '' }) {
  db.setSetting('openrouter_api_key',  openrouter);
  db.setSetting('anthropic_api_key',   claude);
  db.setSetting('gemini_api_key',      gemini);
  db.setSetting('ai_insight_provider', provider);
}

test.after(() => {
  try { fs.unlinkSync(tmpDbPath); } catch { /* already gone */ }
});

test('unset provider keeps the previous behaviour and resolves to OpenRouter', () => {
  configure({ openrouter: 'or-key', claude: 'cl-key', gemini: 'gm-key' });
  const { provider, key, fellBack } = aiInsights.resolveProvider();
  assert.equal(provider, 'openrouter');
  assert.equal(key, 'or-key');
  assert.equal(fellBack, false);
});

test('an OpenRouter-only install resolves, so the refresh endpoint no longer 400s', () => {
  configure({ openrouter: 'or-key' });
  const { provider, key } = aiInsights.resolveProvider();
  assert.equal(provider, 'openrouter');
  assert.equal(key, 'or-key');
});

test('choosing Gemini reuses the bill parsing key rather than needing its own', () => {
  configure({ openrouter: 'or-key', gemini: 'bill-parsing-key', provider: 'gemini' });
  const { provider, key, fellBack } = aiInsights.resolveProvider();
  assert.equal(provider, 'gemini');
  assert.equal(key, 'bill-parsing-key');
  assert.equal(fellBack, false);
});

test('choosing Gemini wins even with an OpenRouter key present', () => {
  // The precise case the old key-order chain could not express.
  configure({ openrouter: 'or-key', claude: 'cl-key', gemini: 'gm-key', provider: 'gemini' });
  assert.equal(aiInsights.resolveProvider().provider, 'gemini');
});

test('choosing Claude selects the Anthropic key', () => {
  configure({ openrouter: 'or-key', claude: 'cl-key', gemini: 'gm-key', provider: 'claude' });
  const { provider, key } = aiInsights.resolveProvider();
  assert.equal(provider, 'claude');
  assert.equal(key, 'cl-key');
});

test('a chosen provider with no key falls back to one that has a key', () => {
  configure({ openrouter: 'or-key', provider: 'gemini' });
  const { provider, key, fellBack } = aiInsights.resolveProvider();
  assert.equal(provider, 'openrouter');
  assert.equal(key, 'or-key');
  assert.equal(fellBack, 'gemini', 'the unusable choice is reported so it can be logged');
});

test('the fallback searches every provider, not just the next one', () => {
  configure({ gemini: 'gm-key', provider: 'claude' });
  const { provider, key, fellBack } = aiInsights.resolveProvider();
  assert.equal(provider, 'gemini');
  assert.equal(key, 'gm-key');
  assert.equal(fellBack, 'claude');
});

test('no keys at all resolves to no provider', () => {
  configure({});
  const { provider, key } = aiInsights.resolveProvider();
  assert.equal(provider, null);
  assert.equal(key, null);
});

test('generateInsight returns null when nothing is configured', async () => {
  configure({});
  assert.equal(await aiInsights.generateInsight(), null);
});

test('a stored value is normalised for case and whitespace', () => {
  // Hand edited settings rows and older exports should not silently reset the
  // choice to OpenRouter.
  configure({ openrouter: 'or-key', gemini: 'gm-key', provider: '  GEMINI  ' });
  assert.equal(aiInsights.resolveProvider().provider, 'gemini');
});

test('an unrecognised value falls back to the default rather than failing', () => {
  configure({ openrouter: 'or-key', gemini: 'gm-key', provider: 'some-other-service' });
  assert.equal(aiInsights.resolveProvider().provider, 'openrouter');
});

test('bill parsing reads gemini_api_key directly and is unaffected by the choice', () => {
  configure({ openrouter: 'or-key', gemini: 'bill-parsing-key', provider: 'openrouter' });
  assert.equal(aiInsights.resolveProvider().provider, 'openrouter');
  assert.equal(db.getSetting('gemini_api_key'), 'bill-parsing-key');
});

test('the default ships as openrouter so upgrades are a no-op', () => {
  const fresh = path.join(os.tmpdir(), `wattsnatch-aiprovider-default-${process.pid}-${Date.now()}.db`);
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e',
    "process.env.WATTSNATCH_DB_PATH=process.argv[1];" +
    "const d=require('./src/db');d.initDb();" +
    "process.stdout.write(String(d.getSetting('ai_insight_provider')));",
    fresh,
  ], { cwd: path.join(__dirname, '..') }).toString();
  try { fs.unlinkSync(fresh); } catch { /* already gone */ }
  assert.equal(out, 'openrouter');
});
