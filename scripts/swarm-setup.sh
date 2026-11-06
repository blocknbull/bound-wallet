#!/usr/bin/env bash
# One-time setup for the swarm demo: a lead wallet that funds two worker
# wallets, with the same human owning all three.
#
#   you (OWNER)
#     |-- lead.<owner>   agent "orchestrator"   may only pay w1 and w2
#     |-- w1.<owner>     agent "researcher"     may only pay the vendor
#     \-- w2.<owner>     agent "scraper"        may only pay the vendor
#
# This is the budget cascade pattern. The owner is the human on all three
# wallets, so the kill switch never leaves their hands and no agent can
# change any policy. The lead wallet's window cap is the rate the whole
# swarm can be funded; each worker's cap is one worker's blast radius.
#
# Needs no contract changes: assert_owner() checks the predecessor account,
# so an owner can be any account, and a worker's agent key can only ever
# call execute() on its own wallet.
#
# Usage: OWNER=reins.testnet ./scripts/swarm-setup.sh
#        VENDOR=<acct>   the one account workers are allowed to pay
#        W1=, W2=        reuse existing Bound wallets as the workers instead
#                        of deploying w1.<owner> and w2.<owner>. They must
#                        already be owned by OWNER.
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="${OWNER:-reins.testnet}"
VENDOR="${VENDOR:-reins.testnet}"
LEAD="${LEAD:-lead.$OWNER}"
W1="${W1:-w1.$OWNER}"
W2="${W2:-w2.$OWNER}"
WASM="${WASM:-contract/target/near/bound_wallet.wasm}"
export NEAR_NETWORK="${NEAR_NETWORK:-testnet}"

cli() { node sdk/dist/cli.js "$@"; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
yocto() { python3 -c "from decimal import Decimal; print(int(Decimal('$1')*10**24))"; }

[ -f "$WASM" ] || { echo "no wasm at $WASM (cargo near build)" >&2; exit 1; }

# A worker: small per-action cap, a small rolling window, one allowed payee,
# and a tripwire tight enough that two probes end its day.
worker_policy() {
  cat <<JSON
{
  "max_per_tx": "$(yocto 0.1)",
  "window_cap": "$(yocto 0.5)",
  "window_secs": 600,
  "max_tx_per_window": 10,
  "receivers": { "Allowlist": ["$VENDOR"] },
  "calls": [],
  "tokens": [],
  "active_hours_utc": null,
  "expires_at": null,
  "approval_above": null,
  "tripwire": { "max_denials": 2, "window_secs": 600 }
}
JSON
}

# The lead: may pay nobody except its own workers. Its window cap is the
# ceiling on how fast the entire swarm can be funded.
lead_policy() {
  cat <<JSON
{
  "max_per_tx": "$(yocto 0.5)",
  "window_cap": "$(yocto 1.5)",
  "window_secs": 600,
  "max_tx_per_window": 20,
  "receivers": { "Allowlist": ["$W1", "$W2"] },
  "calls": [],
  "tokens": [],
  "active_hours_utc": null,
  "expires_at": null,
  "approval_above": null,
  "tripwire": { "max_denials": 10, "window_secs": 600 }
}
JSON
}

add_agent() { # wallet label policy-file
  cli add-agent --owner "$OWNER" --wallet "$1" --label "$2" --policy "$3" --generate-key \
    | grep -v BOUND_AGENT_KEY
}

# A wallet already deployed here is reused rather than redeployed, so this
# script is safe to re-run and can hang the swarm off wallets that exist.
has_contract() {
  curl -s -X POST "${NEAR_RPC_URL:-https://test.rpc.fastnear.com}" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
  | python3 -c "import sys,json; r=json.load(sys.stdin).get('result'); print('yes' if r and r['code_hash']!='11111111111111111111111111111111' else 'no')"
}

deploy_if_missing() { # account short-name balance
  if [ "$(has_contract "$1")" = yes ]; then
    echo "   $1 already has a wallet contract, reusing it"
  else
    cli deploy --owner "$OWNER" --name "$2" --wasm "$WASM" --balance "$3"
  fi
}

step "1. the three wallets (owner: $OWNER)"
deploy_if_missing "$LEAD" "${LEAD%%.*}" "${LEAD_BALANCE:-4.5}"
deploy_if_missing "$W1"   "${W1%%.*}"   "${WORKER_BALANCE:-4.5}"
deploy_if_missing "$W2"   "${W2%%.*}"   "${WORKER_BALANCE:-4.5}"

step "2. agent 'orchestrator' on $LEAD: 0.5 N per action, 1.5 N per 10 min, may only pay w1 and w2"
P=$(mktemp); lead_policy > "$P"; add_agent "$LEAD" orchestrator "$P"

step "3. agent 'researcher' on $W1: 0.1 N per action, 0.5 N per 10 min, may only pay $VENDOR"
P=$(mktemp); worker_policy > "$P"; add_agent "$W1" researcher "$P"

step "4. agent 'scraper' on $W2: same policy, and this is the one we compromise"
P=$(mktemp); worker_policy > "$P"; add_agent "$W2" scraper "$P"

cat <<TXT

Setup done. Three wallets, three keys, each key scoped to execute() on its own wallet.

  lead:    https://${NEAR_NETWORK}.nearblocks.io/address/$LEAD
  worker1: https://${NEAR_NETWORK}.nearblocks.io/address/$W1
  worker2: https://${NEAR_NETWORK}.nearblocks.io/address/$W2

Run the demo:   OWNER=$OWNER ./scripts/swarm-demo.sh
Reclaim funds:  node sdk/dist/cli.js withdraw --owner $OWNER --wallet $W1 --to $OWNER --amount 1
TXT
