# OCPP support - design notes

Status: **planned, not started.** Written up so the architectural decision is not
re-derived from scratch later.

Goal: let WattSnatch control non-Tesla EVs by talking to the *charger* over OCPP,
rather than to the car over a manufacturer API.

---

## The constraint that shapes everything

`src/controller.js` line 17 destructures the Tesla command functions directly:

```js
const { wakeVehicle, setChargingAmps, startCharging, stopCharging,
        getVehicleState, getVehicleData, useBleCommands,
        getVehicleDataBle, getBodyStateBle } = require('./services/tesla');
```

and calls them from roughly 25 sites throughout the file.

That file decides when a real car charges. Refactoring all 25 call sites to go
through a generic backend interface is the obvious approach and it is the wrong
one: it puts every charging decision in the blast radius of a feature that
existing users do not even use.

## The approach instead: an adapter with identical signatures

```
src/services/charging/
  index.js      dispatches on a setting (default: tesla)
  tesla.js      thin passthrough to the existing services/tesla.js
  ocpp.js       OCPP 1.6J implementation
```

`controller.js` changes by **exactly one line** - the require path on line 17.
Nothing else in that file moves.

This works because the existing signatures are already uniform:

| Function | Signature | OCPP 1.6 equivalent |
|---|---|---|
| `setChargingAmps` | `(vin, amps, token)` | `SetChargingProfile` with a current limit |
| `startCharging` | `(vin, token)` | `RemoteStartTransaction` |
| `stopCharging` | `(vin, token)` | `RemoteStopTransaction` |
| `wakeVehicle` | `(vin, token)` | no-op (no such concept) |
| `getVehicleState` | `(vin, token)` | is the charge point's WebSocket connected |
| `getVehicleData` | `(vin, token)` | synthesised from `MeterValues` + `StatusNotification` |

For OCPP, `vin` carries the charge point identifier and `token` is ignored.
`getVehicleData` returns `{ chargeState, driveState }`, which OCPP can populate
from meter values.

### The safety property worth testing explicitly

When the backend is Tesla, the adapter must call **the same functions with the
same arguments** - not merely something equivalent. Worth an explicit test
asserting the adapter's exported functions are reference-identical to
`services/tesla.js`'s, so a regression cannot pass silently.

---

## Scope decisions

- **OCPP 1.6J, not 2.0.1.** 1.6J (JSON over WebSocket) is overwhelmingly what
  home chargers actually speak. 2.0.1 is newer and thinner on the ground.
- **WattSnatch is the Central System (CSMS).** In OCPP the charge point is the
  WebSocket *client* and the backend is the *server*, so WattSnatch listens and
  chargers connect in. That is the standard topology, not an inversion of it.
- **`ws` must become a direct dependency.** It is currently present only
  transitively via `mqtt`, which is fragile - `mqtt` could drop or bump it.
- **Default stays Tesla.** Existing installs must be untouched on upgrade.
- **Build in a fresh worktree off current `main`.** Not the existing `sandbox`
  worktree, which sits on v1.16.0 and is 23 commits behind; building there means
  writing against stale code and a painful merge.

## Setup wizard

Ask which charging backend to use before the Tesla-specific steps, so an OCPP
user is never walked through Tesla developer account creation. Default to Tesla.

Future (explicitly out of scope for the first pass): two Teslas, or one Tesla
plus one OCPP charger. See the notes on multi-vehicle below.

---

## Known limitations to be honest about in the UI

### State of charge is often unavailable

OCPP 1.6 *does* define an SoC measurand in `MeterValues`, but the value has to
originate from the car over ISO 15118 ("Plug and Charge"). Most home AC wallboxes
are plain IEC 61851 units with no such vehicle communication, so requesting SoC
returns nothing useful.

Consequence: the controller's `batteryPct >= chargeLimit` stop condition has no
input on those setups. Charging has to be driven by delivered energy, letting the
car's own BMS terminate. That is a real behavioural difference from the Tesla
path and should be stated plainly rather than papered over.

Getting real SoC for non-Teslas needs a second, separate source - either a
per-manufacturer cloud API (the evcc model, fragmented and high-maintenance) or
an OBD-II dongle such as WiCAN publishing over MQTT. The MQTT route would reuse
the existing "bring your own inverter" ingestion pattern
(`mqtt_in_broker_url` and friends) rather than inventing new machinery.

### Testing

Must be driven against a real OCPP charge point simulator covering the full
lifecycle (BootNotification, Heartbeat, StatusNotification, Authorize,
StartTransaction, MeterValues, StopTransaction, RemoteStart/Stop,
SetChargingProfile) before shipping.

Simulator-passing is necessary but **not sufficient** - it proves the protocol
implementation, not compatibility with any specific piece of hardware.

---

## Multi-vehicle groundwork (related, separate)

Supporting two cars - even rotating one at a time through a single charger -
needs work that is independent of OCPP:

1. **Fleet Telemetry has no vehicle disambiguation today.** The ZMQ topic is
   `{namespace}_V` with no VIN, and `_handleVehicleData()` in
   `src/services/telemetry.js` never parses a VIN field even though Tesla's
   schema carries one. All state lands in one global `_state` object, so a second
   car would silently overwrite the first.
2. **`tesla_vin` is a scalar setting** - 11 references across 5 files. Small
   blast radius to generalise to a list plus an active-vehicle pointer.
3. **The history schema has no vehicle column at all.** `charge_sessions`, and
   everything built on it (Drives, Wrapped, the FBT log, the financial ledger)
   assumes a single car. Without a vehicle identifier threaded through, a second
   car's history blends into the first's.

Item 3 is the wide one and is worth deciding on before it gets built one way.
