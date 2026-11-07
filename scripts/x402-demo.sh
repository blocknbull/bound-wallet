#!/usr/bin/env bash
# Pay-per-request under policy, end to end on testnet:
# a local vendor charges per call; the agent pays the cheap route through its
# Bound wallet, and the pricey route lands in the owner's approval queue.
#
# Usage: ./scripts/x402-demo.sh .bound/<label>.<wallet>.json <payto-account>
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE="${1:?path to .bound/<label>.<wallet>.json}"
PAYTO="${2:?account that receives the payments (must pass the agent allowlist)}"
PORT="${PORT:-4402}"
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
# QUIET=1 hides the raw event echo and the receipt ids so the request/
# response narrative reads on screen. The HTTP status and the payment
# line are untouched.
if [ -n "${QUIET:-}" ]; then
  tidy() { grep -vE 'EVENT_JSON|^Receipts?: '; }
else
  tidy() { cat; }
fi

step "vendor: charging 0.05 N for /cheap and 0.4 N for /pricey (payTo $PAYTO)"
PAYTO="$PAYTO" PORT="$PORT" node examples/x402-server.mjs & SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1.5

step "agent: GET /cheap  (expect: pays 0.05 N, gets the data)"
./scripts/as-agent.sh "$KEYFILE" fetch --url "http://localhost:$PORT/cheap" 2>&1 | tidy

step "agent: GET /pricey  (expect: 0.4 N is above the approval threshold, payment queued)"
./scripts/as-agent.sh "$KEYFILE" fetch --url "http://localhost:$PORT/pricey" 2>&1 | tidy

step "agent: GET /cheap with a 0.01 N client ceiling  (expect: not even submitted)"
./scripts/as-agent.sh "$KEYFILE" fetch --url "http://localhost:$PORT/cheap" --max 0.01 2>&1 | tidy
