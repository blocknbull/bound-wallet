#!/usr/bin/env bash
# Run any agent-side CLI command with a key file written by `bound add-agent`.
# Usage: ./scripts/as-agent.sh .bound/<label>.<wallet>.json <command> [args]
#   e.g. ./scripts/as-agent.sh .bound/dollars.dollars.reins.testnet.json me
#        ./scripts/as-agent.sh .bound/x.json swap-quote --amount 1 --to usdc:base --recipient 0x...
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE="${1:?path to .bound/<label>.<wallet>.json}"; shift
export BOUND_WALLET=$(node -p "require('$PWD/$KEYFILE').wallet")
export BOUND_AGENT_KEY=$(node -p "require('$PWD/$KEYFILE').secret_key")
export NEAR_NETWORK=$(node -p "require('$PWD/$KEYFILE').network")
exec node sdk/dist/cli.js "$@"
