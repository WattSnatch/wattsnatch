# OCPP support - design notes

Status: **built, not yet deployed to production.** `charging_backend` defaults to
`'tesla'` on every install, including this one - nothing changes until it's
deliberately switched to `'ocpp'` and the app is restarted. Not yet tested
against real OCPP hardware (see Testing below).

Goal: let WattSnatch control non-Tesla EVs by talking to the *charger* over OCPP,
rather than to the car over a manufacturer API.

## What actually shipped, and what changed from the plan below

The design below (adapter with identical Tesla-shaped signatures, one require
line in `controller.js`) held up, with two corrections found by reading the
real code rather than trusting this document:

1. **`services/telemetry.js` is a second Tesla-specific dependency**, not just
   `services/tesla.js` - a stateful ZMQ push cache with 18 call sites in
   `controller.js`, not a stateless function set. The adapter
   (`src/services/charging/`) covers both: `tesla.js` re-exports the real
   `services/tesla.js` functions *and* a `telemetry` object wrapping the real
   `services/telemetry.js`.
2. **`controller.js` is required before `db.initDb()` runs** (`src/server.js`:
   `controller.js` at line 14, `initDb()` inside `main()` at line 45). A
   dispatcher that decided Tesla-vs-OCPP via `db.getSetting(...)` at
   require/module-load time would crash the server on boot. `services/charging/
   index.js` decides **per call** instead - a pure forwarding wrapper, not a
   cached-at-load-time reference. The safety property is "argument/return/throw
   forwarded unchanged," proven by `test/chargingBackendPassthrough.test.js`,
   rather than literal function-reference identity (which turned out to be
   impossible to get at require time without the DB crash above).

Built: `src/services/charging/{index,tesla}.js` (dispatcher + Tesla passthrough),
`src/services/charging/ocpp/{protocol,server,handlers,state,index}.js` (OCPP-J
1.6 CSMS - `ws` is now a direct dependency), the 3-point `controller.js` touch
(the two require lines plus a defensive length guard on the VIN-to-model-name
lookup, since a 17-char check is what makes it safe for a non-VIN-shaped OCPP
charge-point ID), settings (`charging_backend`, `ocpp_ws_port`,
`ocpp_charge_point_id`, `ocpp_id_tag`) with UI in Settings and a new step 4
picker in the setup wizard (reuses the existing Fleet/BLE branch-and-skip
mechanism - choosing OCPP jumps straight from step 4 to step 10, skipping every
Tesla-only step). Tests: `test/chargingBackendPassthrough.test.js` (Tesla-path
safety proof) and `test/ocppProtocol.test.js` (a real `ws` client running the
full OCPP-J lifecycle against the real CSMS server) - 73/73 tests passing,
including all pre-existing ones, unchanged.

One real bug found and fixed along the way: current `ws` versions pass
`handleProtocols` a `Set`, not an array (older versions/most examples online
show an array) - `.includes()` on it throws and silently hangs every
connection attempt. Handled defensively (`.has()` if available, `.includes()`
otherwise).

No SoC on typical home AC OCPP chargers, as expected (see below) -
`chargeLimitAt` never gets set, so `getChargeLimitAge()` is always `Infinity`,
so `limitConfirmed` is always `false`, so the battery>=limit stop condition can
provably never fire for this backend - verified in `test/ocppProtocol.test.js`.

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

**Shipped.** Step 4 (previously just Fleet API vs Bluetooth LE) now leads with a
Tesla-vs-OCPP choice; OCPP jumps straight to step 10 (Charging Preferences),
skipping every Tesla-only step (developer app, vehicle confirmation, key
pairing, BLE proxy). Verified in a real browser against an isolated instance
(throwaway DB, not production) - both paths save the correct settings,
including a `tesla_vin` fallback (`ocpp_charge_point_id` or a fixed
placeholder), since `controller.js`'s main loop requires a non-empty
`tesla_vin` to run *at all*, for either backend.

Future (explicitly out of scope for this pass): two Teslas, or one Tesla
plus one OCPP charger. See the notes on multi-vehicle below.

---

## Two real bugs found by the charging-logic test pass

Both were invisible to the protocol tests, because the protocol was fine - the
bugs were in how `controller.js` treats a backend that has no Tesla token and
no battery percentage. Both are fixed, each pinned by regression tests.

**1. Departure scheduling forced hours of grid charging.** `batteryPct` is a
permanent 0 on OCPP, so `missingPct = target - currentSoc` stayed permanently
equal to the full target: it never hit the `missingPct === 0` auto-clear, so
`needsGridCharge` latched true for the whole 6-hour activation window before
every departure. Measured against the real code before the fix:
`{ active: true, needsGridCharge: true, missingPct: 80, hoursUntil: 3 }` -
six hours of full-rate grid import, the exact opposite of the app's purpose,
ending only when the departure time passed. Fixed by refusing to answer rather
than answering wrongly (`departureScheduler.socAvailable()`), at three layers:
`setDeparture()` rejects with an explanation, `getDepartureDecision()` returns
inactive (covering a departure stored under Tesla before switching), and the
dashboard replaces the scheduler with the reason. Auto trip-charging was
already safe - it bails at an existing `battery SOC unknown - skipping` guard.

**2. CHARGE NOW, scheduled/free-power windows, and the manual STOP button
silently did nothing.** `_canSendCommands()` returned `!!token`, and OCPP has
no Tesla OAuth token, so every command path gated on it was a no-op -
`_runOverride`, `_runScheduled`, `_runDeparture`, and `commandStop`. Plain
solar charging kept working the entire time because `_stateMachine` dispatches
*without* that gate, which is precisely why this was easy to miss in casual
testing. The STOP case is the serious one: pressing STOP appeared to work and
did not stop the charger. Fixed by exempting the OCPP backend from the token
requirement; the Tesla Fleet/BLE behaviour is unchanged and pinned by
`test/ocppChargingLogic.test.js`.

## Verified charging behaviour (test/ocppChargingLogic.test.js)

Real CSMS + real `ws` charge point + the real controller, with only the solar
meter stubbed. `_loop()` is driven manually so each tick is deterministic
(commands run every *other* tick by design, to halve Tesla API cost).
Confirmed: amps track solar up and down and clamp to `max_charge_amps`; a live
EV draw is added back into the excess rather than counted as house load (getting
this wrong would stop charging dead); solar loss steps down and stops only after
the hold timer, not instantly; CHARGE NOW and scheduled windows command full
rate regardless of solar; manual STOP reaches the charger; and a mid-charge
charger disconnect does not crash the control loop.

## Known limitations to be honest about in the UI

### Departure scheduling is unavailable (follows from no SoC)

Disabled on OCPP rather than approximated - see bug 1 above. A time-based
**scheduled charging window** is the equivalent that works on any backend, and
is what the UI points users to. An energy-delivered target (kWh rather than %)
would be a reasonable future substitute, but inventing one that has never been
validated against real hardware is how you get a third bug.

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

**Done:** `test/ocppProtocol.test.js` drives a real `ws` client (not a mock)
through the full lifecycle - BootNotification, Heartbeat, StatusNotification,
Authorize, StartTransaction, MeterValues, StopTransaction - against the real
CSMS server, plus asserts correct outbound RemoteStartTransaction /
RemoteStopTransaction / SetChargingProfile frames when `services/charging/
ocpp`'s exported functions are called. Also checked npm for a maintained OCPP
1.6 simulator library as a bonus cross-check (`ocpp-rpc` looks solid) but
didn't add it as a dependency - the hand-rolled fixtures already exercise the
real protocol end to end, and a library brought in only for extra test
confidence isn't worth the added dependency.

**Not done, and still necessary before relying on this for real charging:**
testing against an actual physical OCPP charge point. Simulator/fixture-passing
proves the protocol implementation, not compatibility with any specific piece
of hardware - real chargers have historically been sloppy about spec
conformance (message ordering, optional-field handling, non-standard
`StatusNotification` sequences). Treat `charging_backend=ocpp` as unverified
against real hardware until it has been.

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
