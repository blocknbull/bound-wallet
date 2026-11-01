#!/usr/bin/env bash
# Mainnet launch, everything except the swap (which needs RECIPIENT=0x...):
# deploy the wallet, point the price at Ref pool 3, register the swapper
# agent, deploy the reputation registry, register and verify the wallet.
# Usage: ./scripts/mainnet-launch.sh          (OWNER defaults to boundwallet.near)
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${OWNER:-boundwallet.near}"
WALLET="agents.$OWNER"
REGISTRY="reputation.$OWNER"
cli() { node sdk/dist/cli.js "$@"; }
export NEAR_NETWORK=mainnet
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "1. deploy $WALLET with ${BALANCE:-6} NEAR"
cli deploy --owner "$OWNER" --name agents --wasm contract/target/near/bound_wallet.wasm --balance "${BALANCE:-6}"

step "2. price source: Ref pool 3 (wNEAR/USDC), refreshed by the wallet itself"
cli price-source --owner "$OWNER" --wallet "$WALLET" --source ref:3 --max-age 900
cli refresh-price --owner "$OWNER" --wallet "$WALLET"
cli price --owner "$OWNER" --wallet "$WALLET"

step "3. agent 'swapper': \$10 per action, \$25 per day, swaps on, tripwire 3 denials/hour"
POLICY=$(mktemp)
cat > "$POLICY" <<JSON
{
  "max_per_tx": "340282366920938463463374607431768211455",
  "window_cap": "340282366920938463463374607431768211455",
  "window_secs": 86400,
  "max_tx_per_window": 20,
  "receivers": { "Allowlist": ["$OWNER"] },
  "calls": [],
  "tokens": [],
  "active_hours_utc": null,
  "expires_at": null,
  "approval_above": null,
  "max_per_tx_usd_cents": 1000,
  "window_cap_usd_cents": 2500,
  "allow_intents": true,
  "tripwire": { "max_denials": 3, "window_secs": 3600 }
}
JSON
cli add-agent --owner "$OWNER" --wallet "$WALLET" --label swapper --policy "$POLICY" --generate-key | grep -v BOUND_AGENT_KEY
echo "(agent key saved under .bound/)"

step "4. reputation registry at $REGISTRY"
OWNER="$OWNER" node scripts/deploy-registry.mjs

step "5. register + verify $WALLET in the registry"
cli rep-register --owner "$OWNER" --registry "$REGISTRY" --wallet "$WALLET"
cli rep-verify   --owner "$OWNER" --registry "$REGISTRY" --wallet "$WALLET"

echo
echo "wallet:   https://nearblocks.io/address/$WALLET"
echo "registry: https://nearblocks.io/address/$REGISTRY"
echo "next:     the swap needs a Base address:"
echo "          ./scripts/as-agent.sh .bound/swapper.$WALLET.json swap --amount 1 --to usdc:base --recipient 0xYourBaseAddress"
