/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// Display-only currency helpers, driven by the `country` setting. Internal
// columns/settings/variables keep their existing `_aud` suffix regardless of
// country - this is a deliberate scope decision (a full rename would be a
// large, risky schema/variable migration for no functional benefit), so this
// file only controls how numbers are *shown*, never how they're computed.

function currencySymbol(country) {
  // AU and US both use '$' - kept as a lookup (not a bare literal) so a
  // future country needing a different symbol is a one-line addition here.
  const symbols = { AU: '$', US: '$' };
  return symbols[country] || '$';
}

function formatCurrency(amount, country) {
  const n = Number(amount) || 0;
  return `${currencySymbol(country)}${n.toFixed(2)}`;
}
