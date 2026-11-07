#!/usr/bin/env bash
# Cuts recordings/*.mp4 into one reel with the brand intro, section cards and outro.
#
#   ./scripts/reel/build-reel.sh   ->  recordings/bound-reel.mp4
#
# Expects recordings/dashboard.mp4, attack.mp4 and swarm.mp4, which come from
# the tapes in scripts/tapes/ and from a screen capture of the dashboard.
# Title cards are rendered from scripts/reel/cards/*.html by headless Chrome, so
# editing the copy means editing the HTML, not this file.
set -euo pipefail
cd "$(dirname "$0")/../.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT=recordings/bound-reel.mp4
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/seg" recordings

[ -x "$CHROME" ] || { echo "no Chrome at $CHROME (set CHROME=)" >&2; exit 1; }
for f in dashboard attack swarm; do
  [ -f "recordings/$f.mp4" ] || { echo "missing recordings/$f.mp4" >&2; exit 1; }
done

enc() { ffmpeg -v error -y "$@" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 -an; }

# 1. Cards. The spiral is referenced from brand/, so Chrome needs local file access.
for c in intro t1 t2 t3 outro; do
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
card intro 4.2; card t1 1.7; card t2 1.7; card t3 1.7; card outro 5.0

# 2. Footage. The dashboard keeps four beats and drops the navigation between
#    them; cut points come from its own screen changes, so re-check them with
#    `ffmpeg -i recordings/dashboard.mp4 -vf "select='gt(scene,0.02)',showinfo"`
#    after any re-record.
enc -i recordings/dashboard.mp4 -filter_complex \
  "[0:v]trim=1.2:4.7,setpts=PTS-STARTPTS[a];\
   [0:v]trim=8.0:13.4,setpts=PTS-STARTPTS[b];\
   [0:v]trim=14.0:16.2,setpts=PTS-STARTPTS[c];\
   [0:v]trim=17.6:24.1,setpts=PTS-STARTPTS[d];\
   [a][b][c][d]concat=n=4:v=1:a=0,fps=30,format=yuv420p[v]" -map "[v]" "$WORK/seg/dash.mp4"
enc -i recordings/attack.mp4 -vf "fps=30,format=yuv420p" "$WORK/seg/attack.mp4"
enc -i recordings/swarm.mp4 -vf "setpts=PTS/2.4,fps=30,format=yuv420p" "$WORK/seg/swarm.mp4"

# 3. Dissolve them together. Offsets are derived from the real durations, so
#    changing any segment length does not break the chain.
python3 - "$WORK" "$OUT" <<'PY' > "$WORK/assemble.sh"
import subprocess, sys
work, out = sys.argv[1], sys.argv[2]
segs = ["intro", "t1", "dash", "t2", "attack", "t3", "swarm", "outro"]
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
parts.append(f"[{prev}]fade=t=in:st=0:d=0.6,fade=t=out:st={total - 0.8:.3f}:d=0.8,format=yuv420p[v]")
inputs = " ".join(f'-i "{work}/seg/{n}.mp4"' for n in segs)
print(f'ffmpeg -v error -y {inputs} -filter_complex "{";".join(parts)}" -map "[v]" '
      f'-c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart -an "{out}"')
print(f"{total:.2f}", file=sys.stderr)
PY
sh "$WORK/assemble.sh"

echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")s)"
echo "No audio track: add voiceover and music in the edit."
