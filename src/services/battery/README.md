# Battery Provider Interface

This mirrors `src/services/meters/README.md`'s shape, but for home batteries
(Sigenergy, Sungrow, Tesla Powerwall) rather than solar meters. It's a
separate registry - not a `usage` mode bolted onto `meters/` - because
batteries are a materially different concern: bidirectional power flow
(charge vs discharge), a state-of-charge reading, and for some brands a
write/control channel that meters never need.

## Why batteries don't change the existing solar-excess formula

`controller.js` computes `solarExcessW = readings.solarW - readings.consumptionW`
at every diversion decision point. For all three supported brands, the
battery sits behind the primary meter's measurement point (it's an AC-coupled
hybrid inverter or gateway sitting between solar production and the grid
connection), so whatever the battery draws to charge itself is already
folded into `consumptionW` as read by the existing Enphase/Fronius/SolarEdge/
etc. meter. That means **adding battery support requires zero changes to the
excess formula or its 6 call sites** - the battery is either invisible to it
(when left alone) or influenced indirectly (when WattSnatch commands it to
stop charging, which shows up as a drop in `consumptionW` on a later tick).

## The contract

Every provider module exports:

```js
{
  id: 'sungrow',
  label: 'Sungrow SH Series Hybrid',
  authType: 'local-modbus' | 'local-key' | 'none',
  capabilities: ['read'] | ['read', 'control'],

  isConfigured() { /* boolean */ },

  // Required - the only call the controller's arbitration step makes every tick.
  async fetchReadings(config) {
    return {
      socPct: Number,        // 0-100
      powerW: Number,        // + = charging (drawing), - = discharging (supplying)
      capacityWh: Number | null,
      timestamp: Number,
    };
  },

  async testConnection(config) { /* returns { ok, error?, readings? } */ },

  // Only present when capabilities includes 'control'. Today only Sungrow
  // implements this - Sigenergy and Tesla Powerwall have no exposed
  // charge-power-limit/pause register in their local APIs (see each
  // provider's own file header for what was checked and why).
  async setMode(config, mode) {
    // mode: 'normal' (default self-consumption, no override) | 'hold_for_ev'
    // (cap battery charge power near zero so solar excess flows to the EV instead)
  },
}
```

## Registry (`index.js`)

```js
const providers = { sigenergy, sungrow, tesla_powerwall };
function getProvider(id) { return providers[id] || null; }
function getActiveProvider() { return getProvider(db.getSetting('battery_brand') || 'none'); }
```

New setting: `battery_brand` (defaults to `'none'`, so nothing changes for
existing installs), `battery_priority` (`'battery_first'` default or
`'ev_first'`).

## Priority arbitration (`controller.js`)

`battery_first` is a no-op: it's what every one of these systems already does
on its own firmware (self-consumption before export), so there's nothing for
WattSnatch to actively do.

`ev_first` only has teeth where a provider exposes `setMode`. When enabled
and the EV is plugged in and the battery is currently drawing charge power,
the controller calls `setMode(config, 'hold_for_ev')`; when the EV
disconnects or stops wanting more, it calls `setMode(config, 'normal')` to
restore default behavior. For Sigenergy and Tesla Powerwall, selecting
`ev_first` is accepted but has no effect (surfaced in the Settings UI as a
caveat, not silently ignored) - their local APIs don't expose a lever for it.

## Protocol sources and honesty about verification

The Modbus register addresses (Sigenergy, Sungrow) and local Gateway API
endpoints (Tesla Powerwall) below were taken from
[evcc-io/evcc](https://github.com/evcc-io/evcc) (MIT licensed - see
`THIRD_PARTY_LICENSES.md`) and the [andig/go-powerwall](https://github.com/andig/go-powerwall)
library it depends on for Powerwall - not from testing against real hardware.
Same "unverified, best-effort" labeling as the SPAN Panel provider: please
open an issue if your unit behaves differently.
