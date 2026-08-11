#!/usr/bin/env bash
#
# Copyright (c) 2026 James Shafton
# Licensed under the PolyForm Noncommercial License 1.0.0
# See LICENSE file in the project root, or
# https://polyformproject.org/licenses/noncommercial/1.0.0
#
# Partner-token diagnostic matrix.
#
# `invalid_audience` from the client_credentials grant has several plausible
# causes that all look identical from the outside: wrong auth host, wrong
# audience format, wrong region, or a scope the app cannot grant. This fires
# every combination once and prints a table, so the answer comes from evidence
# rather than from guessing which one it was.
#
# Read-only: requests tokens, sends no commands, changes nothing. Nothing is
# registered or modified on your Tesla account.
#
# Usage:
#   TESLA_CLIENT_ID=xxx TESLA_CLIENT_SECRET=yyy bash scripts/diag-partner-token.sh
#
# Secrets are read from the environment and never printed.

set -uo pipefail

CID="${TESLA_CLIENT_ID:-}"
CSEC="${TESLA_CLIENT_SECRET:-}"
if [ -z "$CID" ] || [ -z "$CSEC" ]; then
  echo "Set TESLA_CLIENT_ID and TESLA_CLIENT_SECRET first, e.g.:"
  echo "  TESLA_CLIENT_ID=abc TESLA_CLIENT_SECRET=xyz bash scripts/diag-partner-token.sh"
  exit 1
fi

# The two auth hosts Tesla operates. Partner tokens are documented against
# fleet-auth; auth.tesla.com is the user-facing OAuth server.
HOSTS=(
  "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"
  "https://auth.tesla.com/oauth2/v3/token"
)

# Audience variants. Region matters, and so might trailing slashes or a missing
# scheme - all three have been suggested as causes at various times.
AUDIENCES=(
  "https://fleet-api.prd.na.vn.cloud.tesla.com"
  "https://fleet-api.prd.na.vn.cloud.tesla.com/"
  "fleet-api.prd.na.vn.cloud.tesla.com"
  "https://fleet-api.prd.eu.vn.cloud.tesla.com"
)

# With and without scope: some grants reject a scope the app cannot issue.
SCOPES=(
  "vehicle_cmds vehicle_charging_cmds"
  ""
)

printf '%-46s | %-42s | %-30s | %s\n' "AUTH HOST" "AUDIENCE" "SCOPE" "RESULT"
printf '%.0s-' {1..150}; echo

for host in "${HOSTS[@]}"; do
  for aud in "${AUDIENCES[@]}"; do
    for scope in "${SCOPES[@]}"; do
      args=(--silent --max-time 25 -X POST "$host"
            -H "Content-Type: application/x-www-form-urlencoded"
            --data-urlencode "grant_type=client_credentials"
            --data-urlencode "client_id=$CID"
            --data-urlencode "client_secret=$CSEC"
            --data-urlencode "audience=$aud")
      [ -n "$scope" ] && args+=(--data-urlencode "scope=$scope")

      body="$(curl "${args[@]}" 2>/dev/null)"

      if printf '%s' "$body" | grep -q '"access_token"'; then
        result="SUCCESS - token issued"
      elif printf '%s' "$body" | grep -q '"error"'; then
        err="$(printf '%s' "$body" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')"
        result="${err:-unknown error}"
      else
        # Never echo an unparsed body verbatim - it could contain a token.
        result="no error field (HTTP/transport issue)"
      fi

      short_host="$(printf '%s' "$host" | sed 's|https://||; s|/oauth2/v3/token||')"
      printf '%-46s | %-42s | %-30s | %s\n' \
        "$short_host" "$aud" "${scope:-(none)}" "$result"
    done
  done
done

echo
echo "If any row says SUCCESS, that combination is the one WattSnatch should use."
echo "If every row fails identically, the problem is the application or account"
echo "rather than the request shape - worth raising with Tesla developer support,"
echo "quoting your client_id and the x-txid header from a failed response."
