#!/usr/bin/env bash
# Is everything a judge will open still up, and can the contracts still act?
#
#   ./scripts/health.sh            # mainnet
#   NET=testnet ./scripts/health.sh
#
# Exits 0 when everything passes, 1 if anything FAILs. WARNs do not fail the
# run; they are the things that become failures if left alone.
#
# Checked daily through judging (16-18 Nov) and while the hosted demo must stay
# up (25 Nov, hackathon Q-012). Nothing here drains on its own, so a balance
# that moved means something called a contract.
set -uo pipefail
cd "$(dirname "$0")/.."

NET="${NET:-mainnet}"
if [ "$NET" = mainnet ]; then
  RPC="${NEAR_RPC_URL:-https://free.rpc.fastnear.com}"
  WALLET=agents.boundwallet.near
  REGISTRY=reputation.boundwallet.near
  OWNER=boundwallet.near
else
  RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
  WALLET=guard.reins.testnet
  REGISTRY=rep.reins.testnet
  OWNER=reins.testnet
fi

# A NEAR account cannot spend the part of its balance that pays for its own
# storage, so "available" is what it can actually use for gas and transfers.
MIN_AVAIL=0.5      # N, below this an account is one busy day from stuck
MIN_ALLOWANCE=0.2  # N, below this the agent key stops being able to pay gas

FAIL=0; WARN=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; WARN=$((WARN+1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)); }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

rpc() { # request_type extra-json
  # A free public RPC rate-limits before it refuses. That is the endpoint being
  # busy, not the deployment being down, so back off and ask again rather than
  # reporting a contract as unreachable.
  local body attempt=1
  while :; do
    body=$(curl -s --max-time 20 -X POST "$RPC" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"$1\",\"finality\":\"final\",$2}}")
    case "$body" in
      *-429*|"")
        [ "$attempt" -ge 4 ] && break
        sleep $((attempt * 2)); attempt=$((attempt + 1)); continue ;;
    esac
    break
  done
  printf '%s' "$body"
}

# True when an error payload is the RPC throttling us rather than a real fault.
throttled() { case "$1" in *-429*|*"Rate limit"*) return 0 ;; *) return 1 ;; esac; }

view() { # account method args-json -> prints the return value as JSON
  local args
  args=$(printf '%s' "${3:-{\}}" | base64 | tr -d '\n')
  rpc call_function "\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$args\"" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'result' not in d or 'result' not in d['result']:
    print('__ERR__' + json.dumps(d.get('error', d))[:200]); raise SystemExit
print(''.join(map(chr, d['result']['result'])))
"
}

step "accounts on $NET"
for a in "$OWNER" "$WALLET" "$REGISTRY"; do
  out=$(rpc view_account "\"account_id\":\"$a\"" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'result' not in d:
    print('ERR ' + json.dumps(d.get('error', d))[:120]); raise SystemExit
r = d['result']
bal = int(r['amount']) / 10**24
# storage is billed at 1e19 yoctoNEAR per byte
reserved = r['storage_usage'] * 1e-5
print('%.4f %.4f %.4f %d' % (bal, reserved, bal - reserved, r['storage_usage']))
")
  case "$out" in
    ERR*) if throttled "$out"; then warn "$a: the RPC throttled us, not a deployment fault"; else fail "$a unreadable: ${out#ERR }"; fi; continue ;;
  esac
  read -r bal reserved avail bytes <<<"$out"
  msg=$(printf '%-30s %8s N held, %8s N free (storage %s B)' "$a" "$bal" "$avail" "$bytes")
  if awk "BEGIN{exit !($avail < $MIN_AVAIL)}"; then
    warn "$msg  <- under ${MIN_AVAIL} N free, top it up"
  else
    ok "$msg"
  fi
done

step "the agent key can still pay for gas"
KEYS=$(rpc view_access_key_list "\"account_id\":\"$WALLET\"" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'result' not in d:
    print('ERR'); raise SystemExit
for k in d['result']['keys']:
    p = k['access_key']['permission']
    if p == 'FullAccess':
        print('FULL %s' % k['public_key']); continue
    fc = p['FunctionCall']
    a = fc['allowance']
    print('FC %s %s %s' % (k['public_key'], 'unlimited' if a is None else int(a), fc['receiver_id']))
")
while read -r kind pk rest; do
  case "$kind" in
    ERR)  fail "cannot read the access keys on $WALLET" ;;
    FULL) warn "$WALLET still has a full-access key ($pk). Deliberate: it is the upgrade path. Remove it only after judging." ;;
    FC)   set -- $rest
          if [ "$1" = unlimited ]; then ok "agent key $pk has an unlimited gas allowance"; continue; fi
          n=$(python3 -c "print('%.4f' % ($1/10**24))")
          if awk "BEGIN{exit !($n < $MIN_ALLOWANCE)}"; then
            warn "agent key $pk has $n N of gas allowance left, top_up_gas it"
          else
            ok "agent key $pk has $n N of gas allowance"
          fi ;;
  esac
done <<< "$KEYS"

step "the contracts answer, and are not paused"
o=$(view "$WALLET" get_owner)
case "$o" in
  __ERR__*) if throttled "$o"; then warn "$WALLET get_owner: the RPC throttled us, not a deployment fault"; else fail "$WALLET get_owner: ${o#__ERR__}"; fi ;;
  *)        ok "wallet owner is $o" ;;
esac
p=$(view "$WALLET" is_paused)
case "$p" in
  __ERR__*) if throttled "$p"; then warn "$WALLET is_paused: the RPC throttled us, not a deployment fault"; else fail "$WALLET is_paused: ${p#__ERR__}"; fi ;;
  true)     fail "$WALLET is PAUSED. The kill switch is on; nothing executes until unpause()" ;;
  false)    ok "wallet is not paused" ;;
  *)        warn "$WALLET is_paused returned $p" ;;
esac
pr=$(view "$WALLET" get_price)
case "$pr" in
  __ERR__*) if throttled "$pr"; then warn "$WALLET get_price: the RPC throttled us, not a deployment fault"; else warn "$WALLET get_price: ${pr#__ERR__}"; fi ;;
  null)     warn "no price is set, so dollar caps cannot be evaluated" ;;
  *)        # Every USD cap is checked against this price. execute() refreshes
            # it from the on-chain source before evaluating, so the agent path
            # self-heals; approve() does not, and panics on a USD policy while
            # the price is stale. The dashboard shows whatever is cached.
            # refresh_price() is permissionless: anyone can call it.
            pstat=$(printf '%s' "$pr" | python3 -c "
import sys, json, time
d = json.load(sys.stdin)
age = time.time() - int(d['updated_at']) / 1e9
print('%s %d %d %d' % (d.get('fresh'), age, d['max_age_secs'], d['cents_per_near']))
")
            read -r fresh age maxage cents <<< "$pstat"
            usd=$(python3 -c "print('%.2f' % ($cents/100))")
            if [ "$fresh" = True ] || [ "$fresh" = true ]; then
              ok "price \$$usd/NEAR, ${age}s old (limit ${maxage}s)"
            else
              # Ref spot only stays fresh for max_age_secs, so staleness is the
              # normal resting state, not an incident: execute() refreshes before
              # it evaluates. It only breaks something when an action is already
              # queued, because approve() panics on a stale price instead.
              npend=$(view "$WALLET" get_pending | python3 -c "
import sys, json
try: print(len(json.load(sys.stdin)))
except Exception: print(-1)
")
              if [ "$npend" -gt 0 ] 2>/dev/null; then
                warn "price is stale (${age}s old, limit ${maxage}s) and $npend action(s) are queued. approve() panics on a stale price: refresh before approving. near call $WALLET refresh_price '{}' --accountId <any>"
              else
                ok "price \$$usd/NEAR, ${age}s old (past the ${maxage}s window, but nothing is queued and execute() refreshes itself)"
              fi
            fi ;;
esac
r=$(view "$REGISTRY" get_owner)
case "$r" in
  __ERR__*) if throttled "$r"; then warn "$REGISTRY get_owner: the RPC throttled us, not a deployment fault"; else fail "$REGISTRY get_owner: ${r#__ERR__}"; fi ;;
  *)        ok "registry owner is $r" ;;
esac

step "what a judge opens"
for u in https://boundwallet.vercel.app \
         https://boundwallet-app.vercel.app \
         https://github.com/blocknbull/bound-wallet \
         https://x.com/boundwallet/status/2120088007449747638; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 25 "$u")
  if [ "$code" = 200 ]; then ok "$code $u"; else fail "$code $u"; fi
done

step "result"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m%d failed\033[0m, %d warnings\n' "$FAIL" "$WARN"; exit 1
fi
printf '\033[32mall checks passed\033[0m, %d warnings\n' "$WARN"
