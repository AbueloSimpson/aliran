// SourceType — the container hint a redirect url needs when it does not name its
// own (port of the RN SDK's sourceType(); sdk/react-native/src/AliranVideo.tsx is
// the reference and carries the full incident notes). The short form: with no MIME
// type ExoPlayer infers the container from the url's LAST PATH SEGMENT
// (Util.inferContentType), and an EXTENSION-LESS one falls through to
// ProgressiveMediaSource, which feeds an HLS text playlist to the mp4/mkv
// extractors and dies with UnrecognizedInputFormatException.
//
// The localhost server always serves index.m3u8, so this only ever bites REDIRECT
// channels — operator urls under no obligation to describe themselves. Every
// Samsung TV Plus KR channel arrives as https://jmp2.uk/stvp-<id> with no
// extension at all, and all 177 of them failed this way in the RN app
// (2026-08-13); the wire was fine the whole time (Content-Type:
// application/x-mpegURL), the container was just decided before the request.
//
// A url that DOES name its container is left alone (no MIME override), so a .mpd
// redirect still opens DASH instead of being forced to HLS.
package aliran.kit

private val CONTAINER_EXTENSION = Regex("""\.[a-zA-Z0-9]{1,5}$""")

/** Does `url`'s last path segment (query/fragment stripped) name its container
 *  with a 1-5 char extension? False means the player must be told the container
 *  is HLS (AliranPlayerView forces APPLICATION_M3U8) — inference would guess
 *  progressive and fail before the request is even made. */
fun hasContainerExtension(url: String): Boolean {
    val path = url.substringBefore('?').substringBefore('#')
    val segment = path.substringAfterLast('/')
    return CONTAINER_EXTENSION.containsMatchIn(segment)
}
