#!/usr/bin/env bash
# End-to-end testnet demo. Deploys a wallet, registers an agent, then shows
# an allowed action, a denied action, a queued action and its approval.
#
# Usage: OWNER=you.testnet ./scripts/demo.sh   (FRIEND defaults to OWNER)
# Needs: OWNER's key in ~/.near-credentials/testnet/, built contract and SDK.
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="${OWNER:?set OWNER=you.testnet}"
FRIEND="${FRIEND:-$OWNER}"
NAME="${NAME:-agent$RANDOM}"
WALLET="$NAME.$OWNER"
WASM="contract/target/near/bound_wallet.wasm"
CLI="node sdk/dist/cli.js"
export NEAR_NETWORK="${NEAR_NETWORK:-testnet}"

[ -f "$WASM" ] || { echo "build the contract first: cd contract && cargo near build non-reproducible-wasm"; exit 1; }
[ -f sdk/dist/cli.js ] || { echo "build the sdk first: cd sdk && npm install && npm run build"; exit 1; }

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "1. deploy wallet $WALLET with ${BALANCE:-5} NEAR (about 3.3 NEAR is locked by contract storage)"
$CLI deploy --owner "$OWNER" --name "$NAME" --wasm "$WASM" --balance "${BALANCE:-5}"

step "2. register agent 'buyer' (allowlist: $FRIEND, 0.5 N per tx, 2 N per day, approval above 0.25 N)"
POLICY=$(mktemp)
sed "s/vendor.testnet/$FRIEND/" examples/policy.buyer.json > "$POLICY"
OUT=$($CLI add-agent --owner "$OWNER" --wallet "$WALLET" --label buyer --policy "$POLICY" --generate-key)
echo "$OUT"
export BOUND_WALLET="$WALLET"
export BOUND_AGENT_KEY=$(echo "$OUT" | sed -n 's/.*BOUND_AGENT_KEY=//p')

step "3. agent: status"
$CLI me

step "4. agent: pay $FRIEND 0.1 N  (expect Executed)"
$CLI exec --transfer "$FRIEND" --amount 0.1

step "5. agent: pay stranger.testnet 0.1 N  (expect Denied: not in allowlist)"
$CLI exec --transfer stranger.testnet --amount 0.1

step "6. agent: pay $FRIEND 0.4 N  (expect Queued: above approval threshold)"
$CLI exec --transfer "$FRIEND" --amount 0.4

step "7. owner: pending queue"
$CLI pending --owner "$OWNER" --wallet "$WALLET"

step "8. owner: approve id 1  (expect Executed)"
$CLI approve --owner "$OWNER" --wallet "$WALLET" --id 1

step "9. owner: pause, then agent tries again  (expect Denied: paused)"
$CLI pause --owner "$OWNER" --wallet "$WALLET"
$CLI exec --transfer "$FRIEND" --amount 0.1

step "10. agent record: policy, remaining budget, counters"
$CLI agents --owner "$OWNER" --wallet "$WALLET"

echo
echo "wallet: https://testnet.nearblocks.io/address/$WALLET"
