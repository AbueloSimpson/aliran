#!/bin/sh
# Verify a hardware-encode host BEFORE putting channels on it.
#
#   deploy/gpu/verify-gpu.sh            # probe ffmpeg directly
#   deploy/gpu/verify-gpu.sh --api      # also ask a running broadcaster's capability probe
#
# Why this exists: a build LISTS encoders it cannot run. `ffmpeg -encoders | grep nvenc`
# succeeds on a host with no NVIDIA card at all, and `-hwaccel cuda` does not fail loudly —
# ffmpeg silently substitutes the software decoder and the error surfaces later, at the
# filter graph. So every check below actually encodes or decodes something.
#
# Exit 0 = this host can run the GPU path. Exit 1 = it cannot; the output says why.
set -u

PASS=0
FAIL=0
ok ()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; PASS=$((PASS+1)); }
bad ()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
note () { printf '  --    %s\n' "$1"; }
head_ () { printf '\n\033[1m%s\033[0m\n' "$1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

head_ "1. tools"
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3)" || bad "ffmpeg not on PATH"
command -v ffprobe >/dev/null 2>&1 && ok "ffprobe present" || bad "ffprobe not on PATH"
if command -v nvidia-smi >/dev/null 2>&1; then
  ok "nvidia-smi present"
  nvidia-smi --query-gpu=index,name,driver_version,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/        /'
else
  note "nvidia-smi absent — fine for VAAPI/QSV hosts, but then NVENC will not work"
fi

head_ "2. encoders that ACTUALLY encode (not just listed)"
for enc in h264_nvenc hevc_nvenc; do
  if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " $enc "; then
    note "$enc not in this ffmpeg build"
    continue
  fi
  if ffmpeg -nostdin -v error -f lavfi -i testsrc2=size=320x180:rate=30 -frames:v 8 \
       -c:v "$enc" -f null - </dev/null 2>"$TMP/e"; then
    ok "$enc encodes"
  else
    bad "$enc is LISTED but fails: $(head -1 "$TMP/e" 2>/dev/null)"
  fi
done
for enc in libx264 libx265; do
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " $enc " \
    && ok "$enc available (software fallback)" \
    || note "$enc not in this build"
done

head_ "3. the FULL GPU chain: decode -> scale -> encode, all on the card"
# Two steps, because lavfi cannot exercise a decoder: make a real elementary stream first,
# then decode THAT with -hwaccel cuda and push the GPU frames through scale_cuda into nvenc.
# This is the check that catches a host where CUVID is missing, because such a host fails at
# the FILTER, not at the decoder.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " h264_nvenc "; then
  if ffmpeg -nostdin -v error -y -f lavfi -i testsrc2=size=640x360:rate=30 -frames:v 30 \
       -c:v libx264 -preset ultrafast -pix_fmt yuv420p -f h264 "$TMP/s.h264" </dev/null 2>"$TMP/e"; then
    if ffmpeg -nostdin -v error -hwaccel cuda -hwaccel_output_format cuda -i "$TMP/s.h264" \
         -vf scale_cuda=-2:180 -c:v h264_nvenc -frames:v 10 -f null - </dev/null 2>"$TMP/e"; then
      ok "cuda decode + scale_cuda + nvenc works end to end"
    else
      bad "GPU decode chain FAILS: $(head -1 "$TMP/e" 2>/dev/null)"
      note "encode-only still works; set transcode.hwDecode=false and expect ~8x the CPU"
    fi
  else
    bad "could not build the probe sample: $(head -1 "$TMP/e" 2>/dev/null)"
  fi
fi

head_ "4. segmenting correctly (the trap that looks like it works)"
# NVENC ignores -force_key_frames without -forced-idr, so the HLS muxer finds no keyframe to
# cut on and emits ONE enormous segment instead of many: the live window never rolls and a
# late joiner has nothing to start from. The broadcaster sets -forced-idr; this proves the
# host honours it.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " h264_nvenc "; then
  mkdir -p "$TMP/hls"
  ffmpeg -nostdin -v error -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 8 \
    -c:v h264_nvenc -preset p2 -tune ll -forced-idr 1 -pix_fmt yuv420p \
    -force_key_frames 'expr:gte(t,n_forced*2)' -f hls -hls_time 2 -hls_list_size 6 \
    -hls_segment_filename "$TMP/hls/seg%d.ts" "$TMP/hls/i.m3u8" </dev/null 2>"$TMP/e"
  N=$(ls "$TMP/hls"/seg*.ts 2>/dev/null | wc -l)
  if [ "${N:-0}" -ge 3 ]; then
    ok "8 s of input produced $N segments (keyframes are being forced)"
  else
    bad "only ${N:-0} segment(s) from 8 s — forced IDR is not working on this host"
  fi
fi

head_ "5. HEVC output tagging"
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " hevc_nvenc "; then
  ffmpeg -nostdin -hide_banner -v warning -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 3 \
    -c:v hevc_nvenc -tag:v hvc1 -pix_fmt yuv420p -f mpegts "$TMP/h.ts" </dev/null 2>"$TMP/e"
  if grep -qi "not hvc1" "$TMP/e" 2>/dev/null; then
    bad "ffmpeg still wants -tag:v hvc1 — HEVC in HLS may not play on some clients"
  else
    ok "hevc_nvenc output tags cleanly as hvc1"
  fi
  note "⚠ clients: MSE rejects HEVC-in-mpegts; playback needs hls.js to transmux to fMP4"
fi

head_ "6. memory cap sanity"
CAP=${FFMPEG_MAX_RSS_MB:-150}
TCAP=${FFMPEG_MAX_RSS_TRANSCODE_MB:-900}
if [ "$CAP" = "0" ]; then
  note "FFMPEG_MAX_RSS_MB=0 — the recycle guard is disabled entirely"
elif [ "$TCAP" -ge 600 ] 2>/dev/null; then
  ok "transcode RSS ceiling ${TCAP} MB (measured need: 233 MB GPU decode, 439 MB CPU decode)"
else
  bad "FFMPEG_MAX_RSS_TRANSCODE_MB=${TCAP} is too low — channels will recycle every ~30 s"
fi

if [ "${1:-}" = "--api" ]; then
  head_ "7. a RUNNING broadcaster's own probe"
  PORT=${CONTROL_PORT:-3310}
  if [ -z "${CONTROL_USER:-}" ] || [ -z "${CONTROL_PASS:-}" ]; then
    note "set CONTROL_USER and CONTROL_PASS to query http://127.0.0.1:$PORT/api/capabilities"
  else
    T=$(curl -fsS -m 10 -X POST "http://127.0.0.1:$PORT/api/login" -H 'content-type: application/json' \
        -d "{\"username\":\"$CONTROL_USER\",\"password\":\"$CONTROL_PASS\"}" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    if [ -n "$T" ]; then
      curl -fsS -m 10 "http://127.0.0.1:$PORT/api/capabilities" -H "authorization: Bearer $T" \
        | sed 's/,"/,\n  "/g' | grep -iE 'nvenc|libx26|hwDecode|cuda|gpus|verified' | sed 's/^/        /'
      ok "capability probe reachable"
    else
      bad "could not log in to the control API on port $PORT"
    fi
  fi
fi

printf '\n\033[1m%s\033[0m\n' "result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
