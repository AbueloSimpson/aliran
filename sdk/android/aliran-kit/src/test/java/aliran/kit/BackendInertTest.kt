// The silent-degradation contract: on a device below the engine floor (plain-JVM
// unit tests report SDK_INT 0, conveniently below 29) the backend must be fully
// inert — the engine host is never constructed, nothing throws, nothing queues.
package aliran.kit

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackendInertTest {
    @After fun reset() { AliranBackend.supportedOverride = null }

    @Test fun `isSupported is false below the floor`() {
        assertFalse(AliranBackend.isSupported())
    }

    @Test fun `supported override works both ways`() {
        AliranBackend.supportedOverride = true
        assertTrue(AliranBackend.isSupported())
        AliranBackend.supportedOverride = false
        assertFalse(AliranBackend.isSupported())
    }

    @Test fun `every method is a silent no-op and the host is never touched`() {
        var hostTouched = false
        val b = AliranBackend { hostTouched = true; throw AssertionError("host constructed on unsupported device") }
        b.play("queued-before-start") // pre-start sends must not throw either
        b.startWith(StartOptions()) { throw AssertionError("bundle asset touched on unsupported device") }
        b.connect("ab".repeat(32))
        b.login("viewer", "pw")
        b.play("news")
        b.reconnect()
        b.requestPrefs()
        b.saveCredentials("viewer", "pw")
        b.clearCredentials()
        b.toggleFavorite("news")
        b.setNetworkProfile(expensive = true, cellular = true)
        assertFalse(hostTouched)
        assertEquals(emptyList<Stream>(), b.streams)
        assertTrue(b.url == null)
    }
}
