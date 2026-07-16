# Source compatibility (pull ingest)

What kinds of live sources the broadcaster can pull and re-share, and how to diagnose one that
won't play. This is about the **input** side — a `pull` input (`http(s)`, `rtsp`, `rtmp`, `srt`,
`udp`) with `transcode.encoder = "copy"` (re-mux, no re-encode — the cheap, common case for FAST /
OTT channels). For per-channel resource cost see [Scaling & capacity](scaling.md).

## What works out of the box

- **Plain HLS** (`.m3u8` → `.ts` segments), H.264 + AAC. This covers the vast majority of FAST /
  OTT origins — Akamai, CloudFront, EdgeNext, Dacast, Univision, and most CDN-fronted channels.
  A master playlist with multiple bitrate variants is fine; ffmpeg picks one.
- **`copy` needs a deliverable codec.** Re-mux only works if the source is already **H.264** video.
  If a source is HEVC/AV1 or otherwise won't `copy`, set a transcoding `encoder` (e.g. `libx264`) —
  but that's **CPU-bound** (see [Scaling](scaling.md)), so prefer sources you can copy.
- **SCTE-35 / ID3 data streams** in the source (ad markers, timed metadata) are harmless — the
  re-mux maps one video + one audio and drops the data streams.

## SSAI / FAST channels (non-`.ts` segment URLs)

Some FAST providers use **server-side ad insertion (SSAI)**: the media playlist points at
ad-stitched segment URLs that **don't end in `.ts`** (they carry beacon/tracking query strings).
By default ffmpeg's HLS demuxer refuses them:

```
URL ... is not in allowed_segment_extensions
parse_playlist error Invalid data found when processing input
```

The broadcaster sends **`-allowed_extensions ALL`** on every `http(s)` `.m3u8` pull so these
playlists are accepted. It only *relaxes* a filter, so plain `.ts` feeds are unaffected.

!!! warning "Some SSAI origins still won't ingest — and it's not fixable from here"
    Accepting the extension is necessary but not always sufficient. Certain SSAI origins then serve
    **empty segments to a server-side / datacenter pull** (an anti-scrape / session / geo control):
    ```
    [hls] Empty segment ...
    Output file #0 does not contain any stream
    ```
    That's a **source-side** block — no broadcaster setting works around it. Observed on some
    Amagi *DistroTV* endpoints (`playouts.now.amagi.tv`, `tsv2.amagi.tv/linear/…`). **Don't
    over-generalize by provider:** other feeds on the *same* CDN are fine — e.g. Amagi's *Vizio*
    endpoints (`*-vizio.amagi.tv`) are ordinary `.ts` HLS and ingest without issue. It's the
    ad-stitching endpoint that matters, not the hostname.

## Diagnosing a source that won't play

If a channel shows `ffmpegUp: false` / high `watchdog.restarts`, probe the URL directly with the
same options the broadcaster uses and read ffmpeg's own error:

```bash
# in the broadcaster container (or any box with ffmpeg):
ffmpeg -allowed_extensions ALL -i '<SOURCE_URL>' -t 4 -c:v copy -c:a aac -f mpegts -y /dev/null
```

Read the tail:

| ffmpeg says | Meaning | Fix |
|---|---|---|
| `Stream #… Video: h264` then writes output | source is fine | it should ingest — check network/geo from the host |
| `not in allowed_segment_extensions` | SSAI non-`.ts` segments | already handled (`-allowed_extensions ALL`) |
| `Empty segment` / `does not contain any stream` | source refuses server-side pulls | **source-side; pick another feed** |
| `Server returned 403/404` | geo-block or dead URL | pick another feed / check region |
| `Video: hevc` / codec won't copy | not H.264 | use a transcoding `encoder` instead of `copy` |

> Tip: always pass `-y` when writing to `/dev/null`, or ffmpeg stops at an
> "already exists, overwrite?" prompt and looks like a failure when the source is actually fine.
