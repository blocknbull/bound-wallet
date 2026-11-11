#!/usr/bin/env bash
# Cuts recordings/*.mp4 into the submission demo: five sections, brand intro and outro.
#
#   ./scripts/reel/build-demo.sh   ->  recordings/bound-demo.mp4
#                                      recordings/bound-demo-x.mp4
#
# Every frame of footage is real. The sections are, in order: what a
# function-call key does not limit (keys), the owner's policy on the live
# mainnet wallet (dashboard), an agent paying an x402 challenge under a policy
# (x402), a compromised agent being denied and tripwired (attack), and a swarm
# whose blast radius stops at one wallet (swarm). The terminal sections ran on
# testnet. Wording is scripts/reel/motion/copy.js.
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
. scripts/reel/lib.sh
need keys dashboard x402 attack swarm

card intro    intro.html               3.4
card c-key    "section.html?c=key&n=01"    2.4
card c-pay    "section.html?c=pay&n=03"    2.6
card c-attack "section.html?c=attack&n=04" 2.4
card c-swarm  "section.html?c=swarm&n=05"  2.4
card outro    outro.html               4.6

# keys and x402 end on the frame that carries the point, so each holds it a
# beat rather than cutting on the last line of output.
enc -i recordings/keys.mp4 \
  -vf "tpad=stop_mode=clone:stop_duration=2.2,fps=30,format=yuv420p" "$WORK/seg/keys.mp4"
enc -i recordings/x402.mp4 \
  -vf "setpts=PTS/1.15,tpad=stop_mode=clone:stop_duration=1.8,fps=30,format=yuv420p" "$WORK/seg/x402.mp4"
enc -i recordings/attack.mp4 -vf "fps=30,format=yuv420p" "$WORK/seg/attack.mp4"
enc -i recordings/swarm.mp4 -vf "setpts=PTS/2.4,fps=30,format=yuv420p" "$WORK/seg/swarm.mp4"

live live 02 switch:1.2:3.4 limits:8.0:4.4 asks:13.9:2.7 log:20.0:4.3

assemble recordings/bound-demo.mp4 \
  intro c-key keys live c-pay x402 c-attack attack c-swarm swarm outro
