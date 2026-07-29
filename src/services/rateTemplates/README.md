# Rate template registry

Same provider-registry pattern as `src/services/meters/` and
`src/services/calendar/` - a flat map of modules, each describing one
utility's published rate plan, filterable by country/region and "applied"
as a one-time preset into the existing `tou_rate_configs`/`export_rate_configs`
tables (via `POST /api/rate-templates/:id/apply`).

## Contract

Each template module exports a single object:

```js
{
  id: 'pge_etouc',                 // stable key, used in the apply route
  label: 'PG&E E-TOU-C (residential TOU)',
  country: 'US',
  region: 'CA',                     // state/region code, for filtering
  importDefaultRateAud: Number,     // off-peak/default import rate ($ - kept "_aud"-suffixed internally, see currency note below)
  importWindows: [                  // shape matches a tou_rate_windows row minus config_id
    { label, rate_aud, days: [0-6], start_time: 'HH:MM', end_time: 'HH:MM' },
  ],
  exportDefaultRateAud: Number|null,  // null when the template has no time-varying export concept
  exportWindows: Array|null,          // null = "leave export_rate_mode on flat", populated = NEM-3.0-style
  sourceNote: String,                 // shown in the UI - see below
}
```

`importDefaultRateAud`/`rate_aud` fields keep the `_aud` suffix used
throughout the rest of the codebase even for US templates - this is a
deliberate scope decision (see `public/js/currency.js`), not an oversight.

## Applying a template

Applying calls `db.addTouConfig(...)` for the import side (always) and, only
when `exportWindows` is non-null, `db.addExportConfig(...)` for the export
side (and sets `export_rate_mode` to `'tou'`). Both inserts create a new
**dated config** exactly like manually adding a TOU config in the existing
Settings UI - this is a one-time preset, not a live link back to the
template, so the user can freely hand-edit the resulting windows afterward
without any special-casing.

## Accuracy disclaimer

**These four templates' rate values are approximated from each utility's
publicly published rate-schedule documentation. They have not been verified
against a live utility account or an actual bill, and utility rate schedules
change periodically (often annually).** Treat every template as a
starting point to hand-tune in the TOU editor after applying it, not an
authoritative, up-to-date lookup. The `sourceNote` field on each template
exists specifically to carry this caveat into the UI next to the picker.
