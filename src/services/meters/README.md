# Meter Provider Interface (proposal)

This folder is a **sketch, not yet wired in**. `controller.js` still imports `fetchMeterReadings` directly from `../enphase.js` - nothing about current Enphase behaviour changes until we deliberately swap that one import for `meters.getProvider(...)`.

## Why this shape

`controller.js` only ever touches Enphase through one call:

```js
const readings = await fetchMeterReadings(gatewayIp, enphaseJwt);
// { solarW, consumptionW, gridW, solarActEnergyDlvdWh, timestamp }
```

Every other Enphase-specific thing (Enlighten cloud auth, gateway discovery, per-panel telemetry) lives outside that call. So the seam is already there - we just need to formalize it so any brand can sit behind it.

## The contract

Every provider module exports:

```js
{
  id: 'enphase',                 // matches db.getToken(id) / db.setToken(id) - already provider-keyed, no schema change needed
  label: 'Enphase IQ Gateway',
  authType: 'cloud-token' | 'local-key' | 'none',

  // Required - this is the only call controller.js makes on every tick.
  async fetchReadings(config) {
    // must return exactly this shape:
    return {
      solarW: Number,             // >= 0
      consumptionW: Number,       // >= 0
      gridW: Number,              // + = importing, - = exporting
      solarActEnergyDlvdWh: Number | null,  // lifetime accumulator, for accurate daily totals - null if the brand doesn't expose one
      timestamp: Number,
    };
  },

  // Optional - used by the setup wizard, not the control loop
  async testConnection(config) { /* returns { ok, error? } */ },
  async discover() { /* LAN auto-discovery, returns ip or null - optional, not all brands support it */ },

  // Optional - only Enphase implements this today (per-microinverter telemetry).
  // Most string inverters (Fronius, SolarEdge, Sungrow...) have no per-panel data at all,
  // so this stays undefined for them and the Panel Health tab just doesn't show for that brand.
  supportsPanelHealth: false,
}
```

`solarActEnergyDlvdWh` being nullable matters: it's how the controller works around Enphase's broken `wattHoursToday` firmware field (see `controller.js` - "today's production = current accumulator − midnight baseline"). Brands with a reliable daily-total field can return it directly instead; brands with neither would need the controller's own running-integration fallback (a small addition to `controller.js`, not a per-provider concern).

## Registry (`index.js`, not yet created)

```js
const providers = { enphase: require('./enphase') /*, fronius, solaredge, sungrow... */ };
function getProvider(id) { return providers[id] || null; }
```

`controller.js`'s change, when we do it, is small and mechanical:
```diff
- const { fetchMeterReadings } = require('./services/enphase');
+ const { getProvider } = require('./services/meters');
  ...
- readings = await fetchMeterReadings(gatewayIp, enphaseJwt);
+ const provider = getProvider(db.getSetting('inverter_brand') || 'enphase');
+ readings = await provider.fetchReadings(providerConfig);
```

## New setting

One new setting, `inverter_brand` (defaults to `'enphase'` so existing installs are unaffected on upgrade), plus the setup wizard's "Step 2: Enphase Gateway" becomes "Step 2: Choose your inverter brand" with brand-specific sub-steps.

## Enphase adapter (`enphase.js`, not yet created)

Thin wrapper - re-exports the existing, untouched `../enphase.js` functions under the new shape. Zero behaviour change for current users; it's purely an adapter.
