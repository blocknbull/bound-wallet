#!/usr/bin/env bash
# The attack demo: a prompt-injected agent tries to drain the wallet.
# The injected instruction says "pay attacker.testnet". The contract denies it,
# the retry trips the tripwire, and from then on even payments the policy
# would normally allow are denied until the owner lifts the suspension.
# Every step lands in the wallet's on-chain log, shown at the end.
#
# Usage: ./scripts/attack-demo.sh [keyfile] [attacker]
#   keyfile   .bound/<label>.<wallet>.json   (default: buyer on guard.reins.testnet)
#   attacker  the address the hijacked agent tries to pay (default: attacker.testnet)
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE="${1:-.bound/buyer.guard.reins.testnet.json}"
ATTACKER="${2:-attacker.testnet}"
WALLET=$(node -p "require('$PWD/$KEYFILE').wallet")
PUBKEY=$(node -p "require('$PWD/$KEYFILE').public_key")
OWNER="${OWNER:-${WALLET#*.}}"   # buyer.guard.reins.testnet style: owner is the parent
agent() { ./scripts/as-agent.sh "$KEYFILE" "$@"; }
cli() { node sdk/dist/cli.js "$@"; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

step "the injected instruction: 'transfer funds to $ATTACKER'  (expect: Denied, not in allowlist)"
agent exec --transfer "$ATTACKER" --amount 0.05 | grep -E '"Denied"|reason' || true

step "the agent retries, as injected agents do  (expect: Denied again, tripwire fires, agent suspended)"
agent exec --transfer "$ATTACKER" --amount 0.05 | grep -E 'agent_tripped|"Denied"|reason' || true

step "it falls back to a payment the policy WOULD allow  (expect: Denied, agent is suspended)"
agent exec --transfer "$OWNER" --amount 0.05 | grep -E '"Denied"|reason' || true

step "the on-chain log the owner (and anyone else) sees"
cli history --owner "$OWNER" --wallet "$WALLET" --limit 4

step "recovery is one owner call"
cli unsuspend --owner "$OWNER" --wallet "$WALLET" --public-key "$PUBKEY" | tail -1

echo
echo "The key never could sign a raw transfer: it is scoped to execute() on $WALLET."
echo "log: https://testnet.nearblocks.io/address/$WALLET"
