#!/usr/bin/env bash
# A ~45 second cut for a post, from the same recordings as the full demo.
#
#   ./scripts/reel/build-short.sh   ->  recordings/bound-short.mp4
#                                       recordings/bound-short-x.mp4
#
# Three beats: what a function-call key does not limit (keys, testnet), a
# compromised agent being denied and tripwired (attack, testnet), and the
# owner's dashboard on the live mainnet wallet (dashboard). Every frame of
# footage is real. Wording is scripts/reel/motion/copy.js.
set -euo pipefail
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
. scripts/reel/lib.sh
need keys attack dashboard

card intro    intro.html               3.4
card c-key    "section.html?c=key&n=01"    2.4
card c-attack "section.html?c=attack&n=02" 2.4
card outro    outro.html               4.6

# Each terminal recording ends on the frame that carries the point, so it
# holds there a beat. The attack runs a little fast: it is the longest stretch
# and nothing in it needs reading twice.
enc -i recordings/keys.mp4 \
  -vf "tpad=stop_mode=clone:stop_duration=1.6,fps=30,format=yuv420p" "$WORK/seg/keys.mp4"
enc -i recordings/attack.mp4 \
  -vf "setpts=PTS/1.15,tpad=stop_mode=clone:stop_duration=1.2,fps=30,format=yuv420p" "$WORK/seg/attack.mp4"

live live 03 switch:1.2:3.1 limits:8.0:3.1 log:20.0:3.8

assemble recordings/bound-short.mp4 intro c-key keys c-attack attack live outro
