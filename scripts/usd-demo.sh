#!/usr/bin/env bash
# Dollar-denominated budgets. Deploys a wallet, sets a NEAR/USD price, registers
# an agent capped at $10 per action and $15 per day, and shows the caps bite.
# Usage: OWNER=you.testnet ./scripts/usd-demo.sh   (NAME, BALANCE, PRICE optional)
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${OWNER:?set OWNER=you.testnet}"
NAME="${NAME:-dollars$RANDOM}"
WALLET="$NAME.$OWNER"
PRICE="${PRICE:-20.00}"   # testnet wallets are small, so a high price keeps amounts tiny
CLI="node sdk/dist/cli.js"
export NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "1. deploy wallet $WALLET"
$CLI deploy --owner "$OWNER" --name "$NAME" --wasm contract/target/near/bound_wallet.wasm --balance "${BALANCE:-5}"

step "2. owner sets the price: 1 NEAR = \$$PRICE (testnet has no live on-chain feed)"
$CLI set-price --owner "$OWNER" --wallet "$WALLET" --usd "$PRICE"
$CLI price --owner "$OWNER" --wallet "$WALLET"

step "3. register agent 'dollars': \$10 per action, \$15 per day, pays anyone"
POLICY=$(mktemp)
cat > "$POLICY" <<JSON
{
  "max_per_tx": "340282366920938463463374607431768211455",
  "window_cap": "340282366920938463463374607431768211455",
  "window_secs": 86400,
  "max_tx_per_window": 0,
  "receivers": "Any",
  "calls": [],
  "tokens": [],
  "active_hours_utc": null,
  "expires_at": null,
  "approval_above": null,
  "max_per_tx_usd_cents": 1000,
  "window_cap_usd_cents": 1500
}
JSON
OUT=$($CLI add-agent --owner "$OWNER" --wallet "$WALLET" --label dollars --policy "$POLICY" --generate-key)
echo "$OUT" | grep -v BOUND_AGENT_KEY
export BOUND_WALLET="$WALLET"
export BOUND_AGENT_KEY=$(echo "$OUT" | sed -n 's/.*BOUND_AGENT_KEY=//p')

usd() { /usr/bin/python3 -c "print(round($1*$PRICE,2))"; }
step "4. agent pays 0.4 NEAR (= \$$(usd 0.4))  (expect Executed)"
$CLI exec --transfer "$OWNER" --amount 0.4 | grep -E '"result"|Executed|Denied' | head -2

step "5. agent pays 0.6 NEAR (= \$$(usd 0.6))  (expect Denied: over \$10 per action)"
$CLI exec --transfer "$OWNER" --amount 0.6 | grep -E '"reason"' | head -1

step "6. agent pays 0.4 NEAR again (= \$$(usd 0.4), \$$(usd 0.8) total)  (expect Denied: over \$15 per day)"
$CLI exec --transfer "$OWNER" --amount 0.4 | grep -E '"reason"' | head -1

step "7. remaining budget"
$CLI me | grep -E '"usd_cents"|"native"' | head -2
echo
echo "wallet: https://testnet.nearblocks.io/address/$WALLET"
