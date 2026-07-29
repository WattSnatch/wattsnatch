/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Utility rate plan template registry - see ./README.md for the full
// contract and the accuracy disclaimer that applies to every template here.

const templates = {
  pge_etouc:      require('./pge_etouc'),
  sce_toudprime:  require('./sce_toudprime'),
  sdge_tou:       require('./sdge_tou'),
  coned_tou:      require('./coned_tou'),
};

function getTemplate(id) {
  return templates[id] || null;
}

function listTemplates({ country, region } = {}) {
  return Object.values(templates)
    .filter((t) => !country || t.country === country)
    .filter((t) => !region || t.region === region)
    .map((t) => ({
      id: t.id, label: t.label, country: t.country, region: t.region, sourceNote: t.sourceNote,
    }));
}

module.exports = { getTemplate, listTemplates };
