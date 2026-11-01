#!/usr/bin/env bash
# Run one action as an agent, using a key file written by `bound add-agent`.
# Usage: ./scripts/agent-exec.sh .bound/buyer.demo.reins.testnet.json --transfer reins.testnet --amount 0.4
set -euo pipefail
cd "$(dirname "$0")/.."
KEYFILE="${1:?path to .bound/<label>.<wallet>.json}"; shift
export BOUND_WALLET=$(node -p "require('$PWD/$KEYFILE').wallet")
export BOUND_AGENT_KEY=$(node -p "require('$PWD/$KEYFILE').secret_key")
export NEAR_NETWORK=$(node -p "require('$PWD/$KEYFILE').network")
exec node sdk/dist/cli.js exec "$@"
