# Shared by build-short.sh and build-demo.sh. Source it from the repo root,
# after WORK (a scratch directory) is set.
#
# Cards are scripts/reel/motion/*.html. Their motion is CSS that render.mjs
# steps frame by frame, and their wording is motion/copy.js.

mkdir -p "$WORK/seg" "$WORK/f"

enc() { ffmpeg -v error -y "$@" -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -r 30 -an; }

# The cards are soft glows on near-black, eight or so grey levels spread over
# hundreds of pixels, which an encoder turns into visible rings. A little
# static luma grain breaks the rings up and costs almost nothing to encode
# because it does not change between frames.
GRAIN="noise=c0s=6:c0f=u"

# card <segment> <file.html[?query]> <seconds>
card() {
  node scripts/reel/render.mjs "scripts/reel/motion/$2" "$WORK/f/$1" "$3"
  enc -framerate 30 -i "$WORK/f/$1/%04d.png" -vf "format=yuv420p,$GRAIN" "$WORK/seg/$1.mp4"
}

# live <segment> <number> <beat>:<start>:<seconds> ...
#
# The owner's dashboard on the mainnet wallet, one screen per beat. The
# recording is a phone-width column in the middle of a 1920 frame, so it is
# cropped to that column and set into the bezel live.html draws at 1236,81
# (544x918), corners rounded to match. <beat> names a caption in copy.js,
# <start> is where that screen begins in recordings/dashboard.mp4, and
# <seconds> is how long the caption and the screen stay up. Screens dissolve
# into each other over 0.4s centred on the boundary.
#
# The recording changes screen at 5.0, 7.6, 13.6 and 17.1, and the Activity tab
# only lights up at about 19.6. Re-check after any re-record with
# `ffmpeg -i recordings/dashboard.mp4 -vf "select='gt(scene,0.02)',showinfo"`.
live() {
  local seg=$1 num=$2 total beats filter
  shift 2
  { read -r total; read -r beats; read -r filter; } < <(python3 - "$@" <<'PY'
import sys
X = 0.4
beats = [(b, float(s), float(l)) for b, s, l in (a.split(":") for a in sys.argv[1:])]
n = len(beats)
print(f"{sum(l for *_, l in beats):g}")
print(",".join(f"{b}:{l:g}" for b, _, l in beats))
f = ["[1:v]fps=30,crop=640:1080:640:0,scale=544:918:flags=lanczos,split=%d%s"
     % (n, "".join(f"[s{i}]" for i in range(n)))]
prev, merged = None, 0.0
for i, (_, start, secs) in enumerate(beats):
    # Every screen but the first and last gives up half a dissolve at each end.
    length = secs + (0 if n == 1 else X / 2 if i in (0, n - 1) else X)
    f.append(f"[s{i}]trim={start:g}:{start + length:g},setpts=PTS-STARTPTS[c{i}]")
    if prev is None:
        prev, merged = "c0", length
    else:
        f.append(f"[{prev}][c{i}]xfade=transition=fade:duration={X}:offset={merged - X:g}[m{i}]")
        prev, merged = f"m{i}", merged + length - X
f.append(f"[{prev}]format=gbrp[d];[2:v]format=gray[k];[d][k]alphamerge[screen]")
print(";".join(f))
PY
)
  node scripts/reel/render.mjs "scripts/reel/motion/live.html?n=$num&beats=$beats" "$WORK/f/$seg" "$total"
  ffmpeg -v error -y -f lavfi -i color=black:s=544x918 -frames:v 1 -vf \
    "format=gray,geq=lum='255*clip(34.5-hypot(max(abs(X-271.5)-238,0),max(abs(Y-458.5)-425,0)),0,1)'" \
    "$WORK/mask.png"
  enc -framerate 30 -i "$WORK/f/$seg/%04d.png" -i recordings/dashboard.mp4 -i "$WORK/mask.png" \
    -filter_complex "$filter;[0:v][screen]overlay=1236:81:format=auto,trim=0:$total,format=yuv420p,$GRAIN[v]" \
    -map "[v]" "$WORK/seg/$seg.mp4"
}

# assemble <out.mp4> <segment> ...
#
# Dissolves the segments together. Offsets come from the real durations, so
# changing any segment's length does not break the chain. There is no fade in:
# the intro's first frame is the poster a player shows before it starts.
# Also writes <out>-x.mp4 with a silent audio track, because X's web composer
# stalls forever on an MP4 that has none. Same video bitstream.
assemble() {
  local out=$1
  shift
  python3 - "$WORK" "$out" "$@" <<'PY' > "$WORK/assemble.sh"
import subprocess, sys
work, out, segs = sys.argv[1], sys.argv[2], sys.argv[3:]
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
parts.append(f"[{prev}]fade=t=out:st={total - 0.7:.3f}:d=0.7,format=yuv420p[v]")
inputs = " ".join(f'-i "{work}/seg/{n}.mp4"' for n in segs)
print(f'ffmpeg -v error -y {inputs} -filter_complex "{";".join(parts)}" -map "[v]" '
      f'-c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart -an "{out}"')
PY
  sh "$WORK/assemble.sh"
  ffmpeg -v error -y -i "$out" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
    -c:v copy -c:a aac -b:a 128k -shortest -movflags +faststart "${out%.mp4}-x.mp4"
  echo "wrote $out ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")s)"
  echo "wrote ${out%.mp4}-x.mp4 (same video, silent audio track, for uploading to X)"
}

need() { # recordings this cut is made from
  local f
  for f in "$@"; do
    [ -f "recordings/$f.mp4" ] || { echo "missing recordings/$f.mp4" >&2; exit 1; }
  done
}
