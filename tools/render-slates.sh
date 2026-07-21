#!/usr/bin/env bash
# Render the pre-rendered "offline slate" media library.
#
# WHY A FILE AND NOT LIVE-GENERATED BARS: a slated channel is remuxed with `-c copy`
# (input kind `file`, transcode `copy`), so it costs ~0 CPU and works on `copy` channels
# that have no encoder configured at all. Live drawtext would force a re-encode — roughly
# 0.5-1 core per slated channel, which across a 69-channel fleet is the whole box — plus a
# runtime font dependency inside the broadcaster image.
#
# WHY A LIBRARY AND NOT ONE FILE: slate segments are appended to the SAME index.m3u8 as the
# channel's pre-failure segments (`-hls_flags append_list`). A codec or resolution change
# mid-playlist, with no EXT-X-DISCONTINUITY, is what actually breaks players — so the slate
# has to match the dead channel's detected profile on codec first, resolution second.
# Measured fleet distribution (68 live channels, 2026-07-21) is in docs/kb/offline-slate.md.
#
# TIMING — the numbers below are chosen so the loop point is EXACT, not approximate:
#   fps 30/1 (not 30000/1001)  -> 24 s is exactly 720 video frames
#   AAC 1024 samples @ 48 kHz  -> 24 s is exactly 1125 audio frames
#   GOP 2 s                    -> exactly 12 GOPs, keyframe at t=0,2,...,22
# Any multiple of 8 s satisfies the video+audio condition; 24 s sits mid-range of the
# 10-30 s the feature wants. A duration that split an AAC frame would leave a few ms of
# audio short at every wrap — an audible tick once per loop, forever.
#
# GOP MUST divide hls.time (prod = 2 s) or the HLS muxer cannot start a segment on an IDR.
# -force_key_frames is used rather than -g so this holds regardless of encoder.
#
# `-af aresample=async=1:first_pts=1024` is NOT cosmetic — do not drop it. The AAC encoder
# emits a priming frame, which without this lands 21.33 ms BEFORE the first video frame.
# -stream_loop advances each iteration by max(stream_end) - min(stream_start), so that
# priming frame makes the loop period 24.021333 s instead of 24.000 s — and since the HLS
# segment grid is anchored to the loop, every wrap shifts the grid another 21 ms, forever
# (~38 s of accumulated skew over a 12 h outage). first_pts=1024 aligns the audio start
# exactly onto the video start, giving an exact 24.000 s period and a grid that stays
# locked. Verify with: ffprobe -show_entries stream=start_time,duration -> both streams
# must read start_time=0.066667, duration=24.000000.
#
# Usage:  ./tools/render-slates.sh [OUTDIR]
# Env:    SLATE_TONE=none|beep|cont   (default none — see docs/kb/offline-slate.md)
#         SLATE_FONT=<path to ttf>
set -euo pipefail

OUTDIR="${1:-./slate}"
TONE="${SLATE_TONE:-none}"

# Font is auto-detected so this script runs UNCHANGED both on a dev box and inside the
# broadcaster image (which ships DejaVu + a drawtext-capable ffmpeg). That matters: it is
# what lets the slates be rendered at image build time by the very ffmpeg that will later
# loop them, instead of being built on a dev box and copied in. Note the `C\:` escaping —
# drawtext parses `:` as its own option separator, so a Windows drive letter must be escaped.
if [ -n "${SLATE_FONT:-}" ]; then
  FONT="$SLATE_FONT"
elif [ -f /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf ]; then
  FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
elif [ -f /c/Windows/Fonts/arialbd.ttf ]; then
  FONT='C\:/Windows/Fonts/arialbd.ttf'
else
  echo "no font found; set SLATE_FONT=/path/to/font.ttf" >&2; exit 1
fi

DUR=24        # seconds — see TIMING above
FPS=30        # exact 30/1
GOP=2         # seconds; must divide hls.time

MSG1='SOURCE OFFLINE'
MSG2='PLEASE STAND BY'

mkdir -p "$OUTDIR"

# Generic message only: one file is shared by many channels, so nothing channel-specific
# may be baked in. Every position is precomputed off the frame height (rather than left as
# an ffmpeg expression) so 720p and 1080p are pixel-proportional and nothing depends on how
# a given filter resolves a bare `h` — drawbox reads `h` as the BOX height, drawtext reads
# it as the FRAME height, and mixing the two silently puts the band in the wrong place.
overlay () {
  local h=$1
  local band_y=$(( h * 38 / 100 ))
  local band_h=$(( h * 24 / 100 ))
  local f1=$(( h * 100 / 1000 ))  # headline
  local y1=$(( h * 410 / 1000 ))
  local f2=$(( h * 45 / 1000 ))   # sub-line
  local y2=$(( h * 545 / 1000 ))
  printf '%s' \
    "drawbox=x=0:y=${band_y}:w=iw:h=${band_h}:color=black@0.9:t=fill," \
    "drawtext=fontfile='${FONT}':text='${MSG1}':fontcolor=white:fontsize=${f1}:x=(w-text_w)/2:y=${y1}," \
    "drawtext=fontfile='${FONT}':text='${MSG2}':fontcolor=0xC8C8C8:fontsize=${f2}:x=(w-text_w)/2:y=${y2}"
}

# Silence is the shipped default. A continuous 1 kHz tone is genuinely hostile over an
# outage that can last hours; the on-screen text already carries the message. `beep` is the
# middle option — it proves the audio path is alive without the torture. Whichever is
# chosen, real AAC frames are always muxed (never a missing audio PID), so a player that
# waits for audio before presenting video does not stall on a slated channel.
audio_input () {
  case "$TONE" in
    none) echo "anullsrc=r=48000:cl=stereo" ;;
    cont) echo "sine=frequency=1000:sample_rate=48000,volume=-24dB,aformat=channel_layouts=stereo" ;;
    beep) echo "sine=frequency=1000:sample_rate=48000,volume=-20dB*lt(mod(t\\,4)\\,0.25):eval=frame,aformat=channel_layouts=stereo" ;;
    *) echo "unknown SLATE_TONE: $TONE" >&2; exit 1 ;;
  esac
}

render () {
  local name=$1 w=$2 h=$3 vcodec=$4
  local out="$OUTDIR/$name"
  local venc=()
  case "$vcodec" in
    h264) venc=(-c:v libx264 -profile:v high -preset slow -crf 20 -pix_fmt yuv420p) ;;
    hevc) venc=(-c:v libx265 -profile:v main -preset slow -crf 22 -pix_fmt yuv420p -x265-params log-level=error) ;;
  esac

  echo "--> $name"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "smptehdbars=size=${w}x${h}:rate=${FPS}" \
    -f lavfi -i "$(audio_input)" \
    -vf "$(overlay "$h")" \
    -map 0:v -map 1:a \
    "${venc[@]}" \
    -force_key_frames "expr:gte(t,n_forced*${GOP})" \
    -c:a aac -ar 48000 -ac 2 -b:a 128k -af "aresample=async=1:first_pts=1024" \
    -t "$DUR" -muxdelay 0 -muxpreload 0 \
    -f mpegts "$out"
}

# Coverage is codec-first, resolution-second: those are the two a player cannot absorb
# mid-playlist. fps and profile deliberately do NOT vary — a decoder reconfigures across
# those at an IDR without a visible break, so varying them would multiply the library for
# no gain. The 720p HEVC entry is NOT cosmetic: 6 live channels are HEVC 1280x720 and
# without it they would have to slate on a codec or a resolution mismatch.
render slate-720p-h264-aac.ts  1280  720 h264   # 41 channels
render slate-1080p-h264-aac.ts 1920 1080 h264   #  5 channels
render slate-1080p-hevc-aac.ts 1920 1080 hevc   #  9 channels
render slate-720p-hevc-aac.ts  1280  720 hevc   #  6 channels

echo
echo "rendered into $OUTDIR (tone=$TONE)"
ls -la "$OUTDIR"
