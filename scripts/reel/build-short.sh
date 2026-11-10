#!/usr/bin/env bash
# A ~35 second cut for a post, from the same recordings as the full demo.
#
#   ./scripts/reel/build-short.sh   ->  recordings/bound-short.mp4
#                                       recordings/bound-short-x.mp4
#
# One argument, told twice: a function-call key does not cap value, and the
# contract does. Cards come from scripts/reel/cards/, so edit the copy there.
set -euo pipefail
cd "$(dirname "$0")/../.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT=recordings/bound-short.mp4
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/seg" recordings

[ -x "$CHROME" ] || { echo "no Chrome at $CHROME (set CHROME=)" >&2; exit 1; }
for f in keys attack; do
  [ -f "recordings/$f.mp4" ] || { echo "missing recordings/$f.mp4" >&2; exit 1; }
done

enc() { ffmpeg -v error -y "$@" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 -an; }

# 1. Cards. The spiral is referenced from brand/, so Chrome needs local files.
for c in intro short-keys short-attack outro; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size=1920,1080 \
    --screenshot="$WORK/$c.png" "file://$PWD/scripts/reel/cards/$c.html" >/dev/null 2>&1
done

# A slow push stops a still card from reading as a freeze.
card() {
  enc -loop 1 -framerate 30 -i "$WORK/$1.png" -t "$2" \
    -vf "zoompan=z='min(1+0.0006*on,1.07)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,format=yuv420p" \
    "$WORK/seg/$1.mp4"
}
card intro 3.0; card short-keys 1.8; card short-attack 1.8; card outro 4.0

# 2. Footage. keys ends on the frame carrying the point, so it holds a beat
#    rather than cutting on the last line of output.
enc -i recordings/keys.mp4 \
  -vf "tpad=stop_mode=clone:stop_duration=2.0,fps=30,format=yuv420p" "$WORK/seg/keys.mp4"
enc -i recordings/attack.mp4 \
  -vf "tpad=stop_mode=clone:stop_duration=1.2,fps=30,format=yuv420p" "$WORK/seg/attack.mp4"

# 3. Dissolve. Offsets come from the real durations, so changing a segment
#    length does not break the chain.
python3 - "$WORK" "$OUT" <<'PY' > "$WORK/assemble.sh"
import subprocess, sys
work, out = sys.argv[1], sys.argv[2]
segs = ["intro", "short-keys", "keys", "short-attack", "attack", "outro"]
dur = lambda n: float(subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
     f"{work}/seg/{n}.mp4"], capture_output=True, text=True).stdout.strip())
D, T = [dur(n) for n in segs], 0.5
parts, prev, off = [], "0:v", 0.0
for i in range(1, len(segs)):
    off += D[i - 1] - T
    parts.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={T}:offset={off:.3f}[x{i}]")
    prev = f"x{i}"
total = sum(D) - T * (len(segs) - 1)
parts.append(f"[{prev}]fade=t=in:st=0:d=0.5,fade=t=out:st={total - 0.7:.3f}:d=0.7,format=yuv420p[v]")
inputs = " ".join(f'-i "{work}/seg/{n}.mp4"' for n in segs)
print(f'ffmpeg -v error -y {inputs} -filter_complex "{";".join(parts)}" -map "[v]" '
      f'-c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart -an "{out}"')
PY
sh "$WORK/assemble.sh"

# 4. X's web composer stalls forever on an MP4 with no audio track, so the
#    upload copy gets a silent one. Same video bitstream.
ffmpeg -v error -y -i "$OUT" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -c:v copy -c:a aac -b:a 128k -shortest -movflags +faststart "${OUT%.mp4}-x.mp4"

echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s)"
echo "wrote ${OUT%.mp4}-x.mp4 (same video, silent audio track, for uploading to X)"
