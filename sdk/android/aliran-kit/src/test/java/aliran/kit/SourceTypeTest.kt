package aliran.kit

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors the RN sourceType() cases (sdk/react-native/src/AliranVideo.tsx):
// hasContainerExtension == false is the "force m3u8" branch there.
class SourceTypeTest {
    @Test fun `extension-less redirect url needs the hint`() {
        // The Samsung TV Plus KR class — 177 channels failed on inference (2026-08-13).
        assertFalse(hasContainerExtension("https://jmp2.uk/stvp-kr290011"))
    }

    @Test fun `m3u8 url is self-describing`() {
        assertTrue(hasContainerExtension("https://cdn.example.com/live/master.m3u8"))
    }

    @Test fun `mpd url is left alone so DASH still opens DASH`() {
        assertTrue(hasContainerExtension("https://cdn.example.com/live/manifest.mpd"))
    }

    @Test fun `the localhost server url is left alone`() {
        assertTrue(hasContainerExtension("http://127.0.0.1:8781/index.m3u8"))
    }

    @Test fun `extension check is case-insensitive`() {
        assertTrue(hasContainerExtension("https://cdn.example.com/LIVE/MASTER.M3U8"))
    }

    @Test fun `a dot in the query string is not an extension`() {
        assertFalse(hasContainerExtension("https://jmp2.uk/stvp-kr290011?token=abc.def"))
    }

    @Test fun `a dot in the fragment is not an extension`() {
        assertFalse(hasContainerExtension("https://jmp2.uk/stvp-kr290011#frag.m3u8"))
    }

    @Test fun `query and fragment are stripped in either order`() {
        assertTrue(hasContainerExtension("https://x/y.m3u8?a=1#b"))
        assertTrue(hasContainerExtension("https://x/y.m3u8#b?a=1"))
    }

    @Test fun `only the LAST path segment counts`() {
        assertFalse(hasContainerExtension("https://cdn.example.com/vod.d/stream"))
    }

    @Test fun `an over-long tail is not an extension`() {
        // 1-5 chars is a container extension; longer is just a dotted name.
        assertFalse(hasContainerExtension("https://x/show.episode"))
    }

    @Test fun `a bare trailing dot is not an extension`() {
        assertFalse(hasContainerExtension("https://x/stream."))
    }

    @Test fun `single-char extensions still count`() {
        assertTrue(hasContainerExtension("https://x/stream.m"))
    }
}
