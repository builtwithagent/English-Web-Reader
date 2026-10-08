#!/usr/bin/env bash
#
# Turn a screen recording into the GIF shown at the top of the README.
#
# Two passes on purpose: a single-pass GIF picks its 256 colours from the whole
# clip at once, so the reading view's flat panels come out muddy and the
# translated text banded. Generating the palette first and applying it second
# keeps panel edges and type clean.
#
# GIF size is governed almost entirely by how much of the frame moves. Measured
# on a 6-second clip of the two-column reading view at 1400x820:
#
#   held still (how streaming translation actually looks)     0.20 MB
#   same clip scrolling                                         8.99 MB
#
# So: hold the camera still. Scroll rarely, slowly, and briefly. Only after
# cutting the movement is it worth spending quality on resolution and fps.
# Every step down in the parameters below costs roughly a proportional share.
#
# Usage:
#   bash scripts/make-demo-gif.sh <input.mp4> [output.gif] [width] [fps] [colors] [crop_top]
#
# Defaults: docs/demo.gif, 900px wide, 10fps, 128 colours, no cropping.
#
# Record at 30fps and a browser-sized window, then let this downscale. Capture
# one browser window, never the whole desktop. `crop_top` shaves the browser's
# tab strip and address bar off the top; measure it in the recording's own
# pixels.

set -euo pipefail

IN="${1:-}"
if [ -z "$IN" ] || [ ! -f "$IN" ]; then
  echo "usage: bash scripts/make-demo-gif.sh <input.mp4> [output.gif] [width] [fps] [colors] [crop_top]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${2:-$ROOT/docs/demo.gif}"
WIDTH="${3:-900}"
FPS="${4:-10}"
COLORS="${5:-128}"
CROP="${6:-0}"

# The README renders the GIF at roughly 880px wide, so 900px of source is about
# 1:1 and anything past it is bytes nobody will ever see.
if [ "$WIDTH" -lt 400 ] || [ "$FPS" -lt 5 ] || [ "$COLORS" -lt 32 ] || [ "$CROP" -lt 0 ]; then
  echo "refusing: width/fps/colors below the usable floor" >&2
  exit 1
fi

# ffmpeg: an explicit FFMPEG wins, then whatever is on PATH, then the static
# build that ships inside imageio-ffmpeg (pip install imageio-ffmpeg).
if [ -n "${FFMPEG:-}" ]; then
  :
elif command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG=ffmpeg
else
  FFMPEG="$(ls -1 "$HOME"/.workbuddy/binaries/python/envs/*/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-*.exe 2>/dev/null | head -1 || true)"
fi
if [ -z "${FFMPEG:-}" ] || { [ "$FFMPEG" != ffmpeg ] && [ ! -x "$FFMPEG" ]; }; then
  echo "ffmpeg not found. Set FFMPEG=/path/to/ffmpeg, or run: pip install imageio-ffmpeg" >&2
  exit 1
fi

# Probe the source first, so a mis-recorded clip shows up before the encode.
probe="$("$FFMPEG" -hide_banner -i "$IN" 2>&1 || true)"
duration="$(printf '%s\n' "$probe" | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | head -1)"
frame="$(printf '%s\n' "$probe" | sed -n 's/.*Video:.*, \([0-9]\{2,\}x[0-9]\{2,\}\).*/\1/p' | head -1)"
src_fps="$(printf '%s\n' "$probe" | sed -n 's/.*Video:.*, \([0-9.]*\) fps.*/\1/p' | head -1)"

echo "in      : $IN"
echo "duration: ${duration:-unknown}   $frame   ${src_fps:-?} fps"

mkdir -p "$(dirname "$OUT")"

filter=""
if [ "$CROP" -gt 0 ]; then
  filter="crop=iw:ih-${CROP}:0:${CROP},"
fi
filter="${filter}fps=${FPS},scale=${WIDTH}:-2:flags=lanczos"
filter="$filter,split[a][b];[a]palettegen=max_colors=${COLORS}:stats_mode=diff[p]"
filter="$filter;[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"

"$FFMPEG" -y -hide_banner -loglevel error -stats \
  -i "$IN" -vf "$filter" -loop 0 "$OUT"

bytes="$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")"
mb="$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b / 1048576 }')"

echo
echo "out     : $OUT"
echo "size    : ${mb} MB  (${WIDTH}px, ${FPS}fps, ${COLORS} colours${CROP:+, ${CROP}px cropped off the top})"

if [ "$(awk -v m="$mb" 'BEGIN { print (m > 8) ? 1 : 0 }')" = 1 ]; then
  echo
  echo "Over 8 MB. Fixing the movement beats squeezing the encoder, so try in order:"
  echo "  1. re-record, holding still and scrolling less"
  echo "  2. cut the dead time at the head and tail of the clip"
  echo "  3. crop the browser chrome:  ... \"$OUT\" 900 10 128 <pixels>"
  echo "  4. only then drop quality:   ... \"$OUT\" 800 8 96"
fi
