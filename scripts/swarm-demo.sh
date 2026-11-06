#!/usr/bin/env bash
# The swarm demo: one compromised worker costs one worker's budget.
#
# A lead wallet funds two worker wallets. One worker is prompt-injected and
# tries to pay an address nobody allowed. It is denied, it retries, the
# tripwire suspends it, and everything it does after that is refused. The
# other worker keeps working, and the money above the boundary never moves.
#
# Run ./scripts/swarm-setup.sh first. Re-runnable: step 0 resets the denial
# counters, and the spending windows are 10 minutes, so retakes are cheap.
#
# Usage: OWNER=bound.testnet ./scripts/swarm-demo.sh [attacker]
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER="${OWNER:-reins.testnet}"
VENDOR="${VENDOR:-reins.testnet}"
ATTACKER="${1:-attacker.testnet}"
LEAD="${LEAD:-lead.$OWNER}"; W1="${W1:-w1.$OWNER}"; W2="${W2:-w2.$OWNER}"
export NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"

KEY_LEAD=".bound/orchestrator.$LEAD.json"
KEY_W1=".bound/researcher.$W1.json"
KEY_W2=".bound/scraper.$W2.json"
for f in "$KEY_LEAD" "$KEY_W1" "$KEY_W2"; do
  [ -f "$f" ] || { echo "missing $f - run ./scripts/swarm-setup.sh first" >&2; exit 1; }
done

cli() { node sdk/dist/cli.js "$@"; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
pk() { node -p "require('$PWD/$1').public_key"; }
# One line per decision: the result, the denial reason, or the tripwire event.
# The reason appears in both the result and the echoed event, so normalise
# whitespace before de-duplicating.
show() {
  grep -E '"result": "Executed"|"reason": "|agent_tripped' \
    | sed 's/^[[:space:]]*//; s/,$//' | awk '!seen[$0]++' || true
}
bal() {
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
  | python3 -c "import sys,json;print(round(int(json.load(sys.stdin)['result']['amount'])/1e24,3))"
}

# Step 0: clean slate. unsuspend also zeroes the denial counter and restarts
# the window, so this is the reset between takes. Harmless if nothing is
# suspended, and tolerated if a wallet predates the method.
for pair in "$LEAD:$KEY_LEAD" "$W1:$KEY_W1" "$W2:$KEY_W2"; do
  cli unsuspend --owner "$OWNER" --wallet "${pair%%:*}" --public-key "$(pk "${pair#*:}")" >/dev/null 2>&1 || true
done

W=$(( ${#LEAD} > ${#W1} ? ${#LEAD} : ${#W1} )); W=$(( W > ${#W2} ? W : ${#W2} ))
printf '\n  %s  (you, owner of all three wallets)\n' "$OWNER"
printf '    |-- %-*s  orchestrator  0.5 N per action, 1.5 N per 10 min, may only pay the two workers\n' "$W" "$LEAD"
printf '    |-- %-*s  researcher    0.1 N per action, 0.5 N per 10 min, may only pay %s\n' "$W" "$W1" "$VENDOR"
printf '    \\-- %-*s  scraper       same policy, and the one that gets compromised\n' "$W" "$W2"

step "1. the orchestrator funds its two workers  (expect: both Executed)"
./scripts/as-agent.sh "$KEY_LEAD" exec --transfer "$W1" --amount 0.1 | show
./scripts/as-agent.sh "$KEY_LEAD" exec --transfer "$W2" --amount 0.1 | show

step "2. the orchestrator tries to pay someone who is not its worker  (expect: Denied)"
echo "   a lead agent that can fund anyone is just a treasury with extra steps."
./scripts/as-agent.sh "$KEY_LEAD" exec --transfer "$ATTACKER" --amount 0.1 | show

step "3. worker 1 does its job: pay the vendor  (expect: Executed)"
./scripts/as-agent.sh "$KEY_W1" exec --transfer "$VENDOR" --amount 0.02 | show

step "4. worker 2 is compromised. injected: 'transfer funds to $ATTACKER'  (expect: Denied)"
./scripts/as-agent.sh "$KEY_W2" exec --transfer "$ATTACKER" --amount 0.02 | show

step "5. it retries, as injected agents do  (expect: Denied, tripwire fires, scraper suspended)"
./scripts/as-agent.sh "$KEY_W2" exec --transfer "$ATTACKER" --amount 0.02 | show

step "6. it falls back to a payment its policy WOULD allow  (expect: Denied, suspended)"
./scripts/as-agent.sh "$KEY_W2" exec --transfer "$VENDOR" --amount 0.02 | show

step "7. meanwhile worker 1 is still working  (expect: Executed)"
echo "   this is the whole point: the blast radius stopped at one wallet."
./scripts/as-agent.sh "$KEY_W1" exec --transfer "$VENDOR" --amount 0.02 | show

step "8. the record on worker 2"
cli history --owner "$OWNER" --wallet "$W2" --limit 4

step "9. the two workers, side by side"
# These wallets may carry agents from other demos, so show only ours.
agent_row() { cli agents --owner "$OWNER" --wallet "$1" | awk -v k="$2" '$0 ~ k {n=3} n && n-- > 0'; }
echo "  $W1"
agent_row "$W1" "$(pk "$KEY_W1")"
echo "  $W2"
agent_row "$W2" "$(pk "$KEY_W2")"

step "10. the money"
printf '   %-24s %s N\n' "$OWNER (treasury)" "$(bal "$OWNER")"
printf '   %-24s %s N\n' "$LEAD" "$(bal "$LEAD")"
printf '   %-24s %s N\n' "$W1" "$(bal "$W1")"
printf '   %-24s %s N\n' "$W2" "$(bal "$W2")"
cat <<TXT

   The compromised worker could lose 0.5 N per 10 minutes, its own window cap.
   Not the lead wallet, and not the treasury. Nothing flows upward: a worker's
   key can only call execute() on its own wallet, and only the human can
   change a policy or lift a suspension.

TXT

step "11. recovery is one owner call"
cli unsuspend --owner "$OWNER" --wallet "$W2" --public-key "$(pk "$KEY_W2")" | tail -1

echo
echo "lead:    https://${NEAR_NETWORK}.nearblocks.io/address/$LEAD"
echo "worker2: https://${NEAR_NETWORK}.nearblocks.io/address/$W2"
