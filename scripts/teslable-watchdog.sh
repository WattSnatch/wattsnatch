#!/bin/bash
#
# Copyright (c) 2026 James Shafton
# Licensed under the PolyForm Noncommercial License 1.0.0
#
# TeslaBleHttpProxy watchdog.
#
# ══ THE ONE RULE ═══════════════════════════════════════════════════════════════════════════
#
#   NOTHING MAY OPEN AN HCI SOCKET WHILE THE PROXY CONTAINER IS RUNNING.
#
#   No hciconfig. No bluetoothctl. No hcitool, btmon, or btmgmt. Not even read-only ones.
#
#   The proxy's BLE library owns the adapter through a raw HCI socket and assumes it is the only
#   thing talking to it. The kernel broadcasts command-completion events to EVERY open HCI
#   socket, so when another tool runs, the proxy receives a completion for a command it never
#   sent, fails to match it, and its socket dies ("can't find the cmd for CommandCompleteEP ..."
#   followed ~2s later by "can't read hci socket: broken pipe"). The proxy then answers every
#   request with HTTP 503 until it is restarted.
#
#   Proven directly 2026-09-13: proxy restarted and left alone answered 200/200/200/200 over a
#   minute; a SINGLE `hciconfig -a` then took it to 503 and it never recovered on its own. Note
#   that `hciconfig -a` is read-only in intent - it still sends Read_Local_Name, which is enough.
#
#   This mattered enormously: an earlier version of this script resolved the adapter with
#   `hciconfig -a` on every check. Every check therefore killed the proxy, the watchdog restarted
#   it, the restart re-registered the adapter under a new hci index, and the next check killed it
#   again. Tightening the check interval (5min -> 2min -> 60s) made it strictly worse, because
#   the diagnostic WAS the fault. The apparent "adapter index churn" was largely an artifact of
#   the tool being used to watch for it.
#
#   So: this script decides everything from the proxy's own HTTP responses, and touches the
#   adapter only after stopping the container.
#
# ══ Other rules, same lineage ══════════════════════════════════════════════════════════════
#
#   - Never trigger on the hci index changing. The index changes every time the proxy starts
#     (it resets the adapter on startup) - that is normal aftermath, not a fault. A watchdog that
#     restarts on it is its own cause.
#   - Never trigger on the car being away. "Vehicle is not in range" is normal for most of the day.
#     It is one of exactly two entries on the benign allowlist in classify_response below, and that
#     allowlist is the only thing that stops a response being treated as a fault. Unrecognised
#     means faulty, never healthy - see the note on the eleven-hour outage down there.
#   - Never treat a slow Bluetooth answer as a dead proxy. Found 2026-10-12: this script was
#     resetting the proxy 10 to 50 times a day, nearly all for "no response", and the log flipped
#     to faulty within a minute of the car leaving and back to healthy within a minute of it
#     returning. Measured directly: a read for a car that is not there takes about 15s to come
#     back as "not in range", longer than the 12s probe, and a read that arrives while another
#     one is in progress waits behind it (13.9s instead of about 1s), which is what happens while
#     WattSnatch is sending charging commands. So every trip, and some charging sessions, looked
#     like a dead proxy. The resets used up the hourly cap, and on 2026-10-12 the adapter went
#     into a firmware wedge right after one of them as the car came home, and the cap then kept
#     it wedged for 18 minutes. A timed-out probe is now followed by a request to the proxy's web
#     root, which never touches Bluetooth and answers in about 10ms even mid-scan. If that
#     answers, the proxy is alive and Bluetooth is just busy or the car is away: not a fault. If
#     it does not, the proxy really has hung, and that is still acted on exactly as before.
#     A proxy whose web side stays up while its Bluetooth side hangs would now go unnoticed, so
#     a long-stop still treats "busy" as a fault once it has lasted LONG_BUSY_SECS without a
#     break. Every fault seen in the log so far came back as a fast error, which is unchanged.
#   - Never grep historical container logs. A fixed error stays in a --since window and retriggers.
#   - Confirm a fault on 2 consecutive checks before acting.
#   - Hard cooldown plus an actions-per-hour cap, so even a wrong rule cannot thrash production;
#     past the cap it stops and complains loudly, because a watchdog firing constantly is broken.
#
# Note: bluetoothd is disabled on this host (2026-09-13). It is another HCI-socket holder with no
# job here (no paired devices, no audio), so leaving it off removes a second source of stray
# traffic. A side effect is that the adapter comes up DOWN after a reboot - the reset path below
# brings it up, which is safe because it runs with the container stopped.

# The car's VIN and the Bluetooth adapter's address are personal, and this repository is public,
# so neither is ever written in this file. On the proxy machine they live in watchdog.env, next
# to this script, readable only by its owner:
#   VIN=<the car's VIN>
#   ADAPTER_MAC=<the dongle's address, as hciconfig shows it>
WD_ENV_FILE="${TESLABLE_WD_ENV_FILE:-$(cd "$(dirname "$0")" && pwd)/watchdog.env}"
env_value() { [ -f "$WD_ENV_FILE" ] && sed -n "s/^$1=//p" "$WD_ENV_FILE" | head -1 | tr -d '\r"'; }
VIN="${TESLABLE_WD_VIN:-$(env_value VIN)}"
# The TESLABLE_WD_* variables exist only so test/bleWatchdogFlow.test.js can run this script
# against a fake proxy with throwaway state. Unset, as they are in production, nothing changes.
PROXY_BASE="${TESLABLE_WD_PROXY_BASE:-http://localhost:8080}"
PROXY_URL="${PROXY_BASE}/api/1/vehicles/${VIN}/body_controller_state"
ROOT_URL="${PROXY_BASE}/"            # the proxy's web root: no Bluetooth involved, any reply = alive
CONTAINER="tesla-ble-http-proxy"
LOG_FILE="${TESLABLE_WD_LOG:-$HOME/TeslaBleHttpProxy/watchdog.log}"
ADAPTER_MAC="${TESLABLE_WD_ADAPTER_MAC:-$(env_value ADAPTER_MAC)}"   # TP-Link UB500 dongle: set in watchdog.env

STATE_DIR="${TESLABLE_WD_STATE_DIR:-/tmp}"
STRIKES_FILE="$STATE_DIR/teslable_wd_strikes"
LASTFAULT_FILE="$STATE_DIR/teslable_wd_lastfault"
LASTACTION_FILE="$STATE_DIR/teslable_wd_last_action"
LASTREMEDY_FILE="$STATE_DIR/teslable_wd_lastremedy"
HISTORY_FILE="$STATE_DIR/teslable_wd_history"
BUSY_SINCE_FILE="$STATE_DIR/teslable_wd_busy_since"

PROBE_TIMEOUT="${TESLABLE_WD_PROBE_TIMEOUT:-12}"
ROOT_TIMEOUT=3
# Long-stop for "busy" (proxy up, Bluetooth not answering). Long enough that an ordinary day out
# costs at most a few resets rather than dozens, short enough that a proxy whose Bluetooth side
# has silently hung while the car is home is caught the same day.
LONG_BUSY_SECS="${TESLABLE_WD_LONG_BUSY_SECS:-10800}"
STRIKES_TO_ACT=2          # ~2 min at a 60s loop
COOLDOWN_SECS=600         # 10 min minimum between actions
MAX_ACTIONS_PER_HOUR=4

log() { echo "$(date -Iseconds) $1" >> "$LOG_FILE"; }
now() { date +%s; }

# ONLY safe to call with the container stopped. See THE ONE RULE above.
resolve_hci_container_stopped() {
  hciconfig -a 2>/dev/null | grep -B1 "$ADAPTER_MAC" | head -1 | cut -d: -f1
}

# Decide whether a proxy response is a fault. Prints the fault name, or nothing when there is
# nothing to do.
#
# Benign responses are an ALLOWLIST and everything else is a fault. That direction is the whole
# point, and it is the opposite of what this did until 2026-09-16. It used to name the faults it
# knew about and treat anything unrecognised as healthy, so when the proxy started answering
#
#   ble: failed to scan for <VIN>: received scan response <MAC> with no associated
#   Advertising Data packet
#
# which was not in that list, every check read it as healthy and logged the cheerfully wrong
# "healthy again (HTTP 503)". The car sat one metre from the house for ELEVEN HOURS with no
# charging control while the watchdog reported nothing wrong. A watchdog that does not recognise
# an error must assume the worst, because the alternative is exactly that silence.
#
# The two benign entries are here on evidence, not guesswork. Both appear in the proxy's own logs
# over any given week, and acting on either would be actively wrong rather than merely wasteful:
#   - "Vehicle is not in range": the car is genuinely away, which is most of the day.
#   - "maximum number of BLE devices": Tesla caps simultaneous BLE connections, so this is
#     transient contention that clears itself. Restarting into it just adds another reconnect.
classify_response() {
  code="$1"
  body="$2"
  root_code="$3"   # only set when the Bluetooth probe got no answer: what the web root said

  [ "$code" = "200" ] && return 0
  if [ "$code" = "000" ]; then
    # No answer in time. If the web root still answers, the proxy is alive and Bluetooth is busy
    # or the car is away. If it does not (or was never asked), the proxy itself is not answering.
    if [ -n "$root_code" ] && [ "$root_code" != "000" ]; then echo "busy"; else echo "no-response"; fi
    return 0
  fi

  printf '%s' "$body" | grep -q "Vehicle is not in range"     && return 0
  printf '%s' "$body" | grep -q "maximum number of BLE devices" && return 0

  # Named faults, purely so the log and the escalation below can be specific.
  printf '%s' "$body" | grep -q "Command Disallowed" && { echo "firmware-wedge"; return 0; }
  printf '%s' "$body" | grep -qE "hci socket|broken pipe|socket hang up" && { echo "stale-socket"; return 0; }

  # Anything else the proxy reports is a fault we have not seen before. Say so.
  echo "unhealthy"
}

# Self-test hook: `teslable-watchdog.sh --classify <http_code> <body>` prints the verdict and
# exits, touching nothing. test/bleWatchdogClassify.test.js drives the rules above through this
# against real recorded proxy responses, so the allowlist cannot quietly rot again.
if [ "$1" = "--classify" ]; then
  classify_response "$2" "$3" "$4"
  exit 0
fi

# Without a VIN there is nothing to probe. Say so once rather than every minute, and do nothing:
# acting on a check that never ran would be worse than not checking.
NOVIN_FILE="$STATE_DIR/teslable_wd_novin"
if [ -z "$VIN" ]; then
  [ -f "$NOVIN_FILE" ] || { log "no VIN configured - add VIN=... to $WD_ENV_FILE. Not checking until then."; touch "$NOVIN_FILE"; }
  exit 0
fi
rm -f "$NOVIN_FILE"

# ── Probe: the proxy's HTTP interface is the sole source of truth ───────────────────────────
RESP=$(curl -s -m "$PROBE_TIMEOUT" -w $'\n%{http_code}' "$PROXY_URL" 2>/dev/null)
HTTP_CODE=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')

ROOT_CODE=""
if [ "$HTTP_CODE" = "000" ]; then
  ROOT_CODE=$(curl -s -o /dev/null -m "$ROOT_TIMEOUT" -w '%{http_code}' "$ROOT_URL" 2>/dev/null)
  [ -z "$ROOT_CODE" ] && ROOT_CODE="000"
fi

FAULT=$(classify_response "$HTTP_CODE" "$BODY" "$ROOT_CODE")

# ── Busy: the proxy is up, Bluetooth is slow or the car is away ────────────────────────────
if [ "$FAULT" = "busy" ]; then
  BUSY_SINCE=$(cat "$BUSY_SINCE_FILE" 2>/dev/null)
  if [ -z "$BUSY_SINCE" ]; then
    BUSY_SINCE=$(now); echo "$BUSY_SINCE" > "$BUSY_SINCE_FILE"
    log "Bluetooth did not answer within ${PROBE_TIMEOUT}s but the proxy is up (web root HTTP $ROOT_CODE) - car away or proxy busy, not a fault"
  fi
  if [ $(( $(now) - BUSY_SINCE )) -lt "$LONG_BUSY_SECS" ]; then
    echo 0 > "$STRIKES_FILE"; : > "$LASTFAULT_FILE"
    exit 0
  fi
  # Busy without a break for LONG_BUSY_SECS: act on it like any other fault, in case the proxy's
  # Bluetooth side has hung while its web side carries on. Confirmation, cooldown and the hourly
  # cap all still apply below.
  FAULT="busy-too-long"
else
  BUSY_SINCE=$(cat "$BUSY_SINCE_FILE" 2>/dev/null)
  if [ -n "$BUSY_SINCE" ]; then
    BUSY_MINS=$(( ($(now) - BUSY_SINCE) / 60 ))
    if [ -z "$FAULT" ]; then
      log "Bluetooth answering again (HTTP $HTTP_CODE) after ${BUSY_MINS} min busy"
    else
      log "busy spell ended after ${BUSY_MINS} min, now '$FAULT' (HTTP $HTTP_CODE)"
    fi
    : > "$BUSY_SINCE_FILE"
  fi
fi

if [ -z "$FAULT" ]; then
  [ "$(cat "$STRIKES_FILE" 2>/dev/null || echo 0)" != "0" ] && log "no fault (HTTP $HTTP_CODE) - clearing strikes"
  echo 0 > "$STRIKES_FILE"; : > "$LASTFAULT_FILE"
  exit 0
fi

# ── Confirm over consecutive checks ─────────────────────────────────────────────────────────
if [ "$FAULT" = "$(cat "$LASTFAULT_FILE" 2>/dev/null || echo '')" ]; then
  STRIKES=$(( $(cat "$STRIKES_FILE" 2>/dev/null || echo 0) + 1 ))
else
  STRIKES=1
fi
echo "$STRIKES" > "$STRIKES_FILE"; echo "$FAULT" > "$LASTFAULT_FILE"

if [ "$STRIKES" -lt "$STRIKES_TO_ACT" ]; then
  log "fault '$FAULT' (HTTP $HTTP_CODE) - strike $STRIKES/$STRIKES_TO_ACT, waiting for confirmation"
  exit 0
fi

# ── Cooldown ────────────────────────────────────────────────────────────────────────────────
LAST_ACTION=$(cat "$LASTACTION_FILE" 2>/dev/null || echo 0)
SINCE=$(( $(now) - LAST_ACTION ))
if [ "$LAST_ACTION" -gt 0 ] && [ "$SINCE" -lt "$COOLDOWN_SECS" ]; then
  log "fault '$FAULT' confirmed, but last action was ${SINCE}s ago (cooldown ${COOLDOWN_SECS}s) - not acting"
  exit 0
fi

# ── Actions-per-hour cap ────────────────────────────────────────────────────────────────────
touch "$HISTORY_FILE"
RECENT=$(awk -v t="$(( $(now) - 3600 ))" '$1 > t' "$HISTORY_FILE" | wc -l)
if [ "$RECENT" -ge "$MAX_ACTIONS_PER_HOUR" ]; then
  log "REFUSING TO ACT: $RECENT actions in the last hour (cap $MAX_ACTIONS_PER_HOUR) and '$FAULT' persists. Needs a human, not more restarts."
  exit 0
fi

# ── Act ─────────────────────────────────────────────────────────────────────────────────────
# Escalate to an adapter reset for a firmware wedge, or if a plain restart already failed to
# clear this same fault last time.
NEED_RESET="no"
[ "$FAULT" = "firmware-wedge" ] && NEED_RESET="yes"
[ "$FAULT" = "$(cat "$LASTREMEDY_FILE" 2>/dev/null || echo '')" ] && NEED_RESET="yes"

if [ "$NEED_RESET" = "yes" ]; then
  log "fault '$FAULT' confirmed over $STRIKES checks - stopping container, resetting adapter, starting it back up"
  docker stop "$CONTAINER" >> "$LOG_FILE" 2>&1
  sleep 1
  # Container is stopped, so touching HCI is safe here and ONLY here.
  DEV=$(resolve_hci_container_stopped)
  if [ -n "$DEV" ]; then
    sudo /usr/bin/hciconfig "$DEV" down >> "$LOG_FILE" 2>&1
    sleep 1
    sudo /usr/bin/hciconfig "$DEV" up   >> "$LOG_FILE" 2>&1
    sleep 2
    log "adapter $DEV reset"
  else
    log "no hci device matches $ADAPTER_MAC - is the dongle plugged in? starting proxy anyway"
  fi
  docker start "$CONTAINER" >> "$LOG_FILE" 2>&1
else
  log "fault '$FAULT' confirmed over $STRIKES checks - restarting proxy"
  docker restart "$CONTAINER" >> "$LOG_FILE" 2>&1
fi

echo "$(now)" > "$LASTACTION_FILE"
echo "$FAULT"  > "$LASTREMEDY_FILE"
echo "$(now) $FAULT" >> "$HISTORY_FILE"
tail -50 "$HISTORY_FILE" > "$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
echo 0 > "$STRIKES_FILE"; : > "$LASTFAULT_FILE"; : > "$BUSY_SINCE_FILE"
log "action complete"
