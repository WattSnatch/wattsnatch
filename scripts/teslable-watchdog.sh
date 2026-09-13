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
#   - Never grep historical container logs. A fixed error stays in a --since window and retriggers.
#   - Confirm a fault on 2 consecutive checks before acting.
#   - Hard cooldown plus an actions-per-hour cap, so even a wrong rule cannot thrash production;
#     past the cap it stops and complains loudly, because a watchdog firing constantly is broken.
#
# Note: bluetoothd is disabled on this host (2026-09-13). It is another HCI-socket holder with no
# job here (no paired devices, no audio), so leaving it off removes a second source of stray
# traffic. A side effect is that the adapter comes up DOWN after a reboot - the reset path below
# brings it up, which is safe because it runs with the container stopped.

VIN="LRWYHCFJ5SC179194"
PROXY_URL="http://localhost:8080/api/1/vehicles/${VIN}/body_controller_state"
CONTAINER="tesla-ble-http-proxy"
LOG_FILE="$HOME/TeslaBleHttpProxy/watchdog.log"
ADAPTER_MAC="C0:3A:55:D2:EA:61"      # TP-Link UB500 dongle - update if the dongle is swapped

STRIKES_FILE="/tmp/teslable_wd_strikes"
LASTFAULT_FILE="/tmp/teslable_wd_lastfault"
LASTACTION_FILE="/tmp/teslable_wd_last_action"
LASTREMEDY_FILE="/tmp/teslable_wd_lastremedy"
HISTORY_FILE="/tmp/teslable_wd_history"

PROBE_TIMEOUT=12
STRIKES_TO_ACT=2          # ~2 min at a 60s loop
COOLDOWN_SECS=600         # 10 min minimum between actions
MAX_ACTIONS_PER_HOUR=4

log() { echo "$(date -Iseconds) $1" >> "$LOG_FILE"; }
now() { date +%s; }

# ONLY safe to call with the container stopped. See THE ONE RULE above.
resolve_hci_container_stopped() {
  hciconfig -a 2>/dev/null | grep -B1 "$ADAPTER_MAC" | head -1 | cut -d: -f1
}

# ── Probe: the proxy's HTTP interface is the sole source of truth ───────────────────────────
RESP=$(curl -s -m "$PROBE_TIMEOUT" -w $'\n%{http_code}' "$PROXY_URL" 2>/dev/null)
HTTP_CODE=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')

FAULT=""
if [ "$HTTP_CODE" = "000" ]; then
  FAULT="no-response"                     # proxy not answering at all
elif printf '%s' "$BODY" | grep -q "Command Disallowed"; then
  FAULT="firmware-wedge"                  # adapter refusing scan commands; needs an adapter reset
elif printf '%s' "$BODY" | grep -qE "hci socket|broken pipe|socket hang up"; then
  FAULT="stale-socket"                    # proxy's adapter handle is dead; a restart fixes it
fi
# Anything else - including 200 and "Vehicle is not in range" - is healthy.

if [ -z "$FAULT" ]; then
  [ "$(cat "$STRIKES_FILE" 2>/dev/null || echo 0)" != "0" ] && log "healthy again (HTTP $HTTP_CODE) - clearing strikes"
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
echo 0 > "$STRIKES_FILE"; : > "$LASTFAULT_FILE"
log "action complete"
