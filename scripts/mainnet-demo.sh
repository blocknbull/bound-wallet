#!/usr/bin/env bash
# The mainnet proof: deploy a Bound wallet, give an agent a dollar budget with
# swaps allowed, and let it swap 1 NEAR to USDC on Base through NEAR Intents.
# Costs about 3.3 NEAR locked for storage (recoverable by deleting the wallet
# later), plus whatever is swapped.
#
# Usage: OWNER=you.near RECIPIENT=0xYourBaseAddress ./scripts/mainnet-demo.sh
# Optional: NAME=agents BALANCE=6 SWAP=1
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${OWNER:?set OWNER=you.near (mainnet, key in ~/.near-credentials/mainnet)}"
RECIPIENT="${RECIPIENT:?set RECIPIENT=0x... (Base address to receive USDC)}"
NAME="${NAME:-agents}"
WALLET="$NAME.$OWNER"
SWAP="${SWAP:-1}"
cli() { node sdk/dist/cli.js "$@"; }
export NEAR_NETWORK=mainnet
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "1. deploy $WALLET with ${BALANCE:-6} NEAR"
cli deploy --owner "$OWNER" --name "$NAME" --wasm contract/target/near/bound_wallet.wasm --balance "${BALANCE:-6}"

step "2. price source: Ref pool 3 (wNEAR/USDC), refreshed by the wallet itself"
cli price-source --owner "$OWNER" --wallet "$WALLET" --source ref:3 --max-age 900
cli refresh-price --owner "$OWNER" --wallet "$WALLET"
cli price --owner "$OWNER" --wallet "$WALLET"

step "3. register agent 'swapper': \$10 per action, \$25 per day, swaps allowed, tripwire 3 denials/hour"
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
OUT=$(cli add-agent --owner "$OWNER" --wallet "$WALLET" --label swapper --policy "$POLICY" --generate-key)
echo "$OUT" | grep -v BOUND_AGENT_KEY
export BOUND_WALLET="$WALLET"
export BOUND_AGENT_KEY=$(echo "$OUT" | sed -n 's/.*BOUND_AGENT_KEY=//p')

step "4. agent: dry quote $SWAP NEAR -> USDC on Base"
cli swap-quote --amount "$SWAP" --to usdc:base --recipient "$RECIPIENT"

step "5. agent: the real swap, funded by the wallet under policy"
cli swap --amount "$SWAP" --to usdc:base --recipient "$RECIPIENT" | tee /tmp/bound-swap.json

step "6. agent: a second swap that breaks the \$10 per-action cap (expect Denied)"
cli swap --amount 3 --to usdc:base --recipient "$RECIPIENT" 2>&1 | grep -E "Denied|reason|result" | head -3 || true

step "7. history"
cli history --owner "$OWNER" --wallet "$WALLET" --limit 5

DEP=$(node -p "try{JSON.parse(require('fs').readFileSync('/tmp/bound-swap.json','utf8').split('\n').filter(l=>l.trim().startsWith('{')).join('\n')).depositAddress}catch(e){''}" 2>/dev/null || true)
echo
echo "wallet:  https://nearblocks.io/address/$WALLET"
[ -n "$DEP" ] && echo "track:   node sdk/dist/cli.js swap-status --deposit $DEP"
echo "register in the registry once it is on mainnet: bound rep-register --registry <registry> --wallet $WALLET"
