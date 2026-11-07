#!/usr/bin/env bash
# What a NEAR function-call key actually restricts, read off the chain.
#
# The claim people make about agent keys is that they are "limited". They are:
# limited to a contract and a set of methods, with an allowance that caps GAS.
# Nothing in the key restricts how much value a permitted call may move. That
# is the whole reason the policy has to live in a contract.
#
# Usage: ./scripts/key-limits.sh [keyfile]
#   keyfile  .bound/<label>.<wallet>.json  (default: buyer on guard.reins.testnet)
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE="${1:-.bound/buyer.guard.reins.testnet.json}"
WALLET=$(node -p "require('$PWD/$KEYFILE').wallet")
PUBKEY=$(node -p "require('$PWD/$KEYFILE').public_key")
NET=$(node -p "require('$PWD/$KEYFILE').network")
RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
[ "$NET" = mainnet ] && RPC="${NEAR_RPC_URL:-https://free.rpc.fastnear.com}"
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

rpc() { # request_type extra-json
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"$1\",\"finality\":\"final\",$2}}"
}

step "the agent's credentials, as any agent framework would hold them"
cat <<ENV
  BOUND_WALLET=$WALLET
  BOUND_AGENT_KEY=ed25519:<secret key, never printed>
ENV

step "what that key is permitted to do, straight from the chain"
rpc view_access_key "\"account_id\":\"$WALLET\",\"public_key\":\"$PUBKEY\"" \
  | python3 -c "
import sys, json
r = json.load(sys.stdin)['result']
fc = r['permission']['FunctionCall']
print(json.dumps({'permission': {'FunctionCall': {
    'allowance': fc['allowance'], 'receiver_id': fc['receiver_id'],
    'method_names': fc['method_names']}}}, indent=2))
print()
print('  allowance    %.3f NEAR  <- a GAS budget' % (int(fc['allowance'])/10**24))
print('  receiver_id  %s  <- one contract' % fc['receiver_id'])
print('  method_names %s  <- one method' % fc['method_names'])
"

step "the balance that key sits next to"
rpc view_account "\"account_id\":\"$WALLET\"" \
  | python3 -c "
import sys, json
r = json.load(sys.stdin)['result']
print('  %s holds %.3f NEAR' % ('$WALLET', int(r['amount'])/10**24))
"

cat <<'TXT'

  The allowance is spent on gas, never on the transfer. NEAR checks it
  against prepaid gas and nothing else, so it is not a spending limit.

TXT

step "the same key shape, without a Bound wallet"
cat <<TXT
  receiver_id   a token contract
  method_names  ["ft_transfer"]

  That key is "limited" by every description NEAR gives it, and one call
  moves the entire token balance. The allowance never notices: it only
  ever paid for gas.

  Here the key may call exactly one method, execute(), on $WALLET.
  Every limit that matters is on the other side of that call, in a
  contract the agent cannot change.
TXT
