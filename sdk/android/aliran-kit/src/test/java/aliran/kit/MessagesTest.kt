package aliran.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagesTest {
    @Test fun `ready parses`() {
        assertTrue(BackendMessage.parse("""{"type":"ready"}""") is BackendMessage.Ready)
    }

    @Test fun `streams parse with catalog fields`() {
        val m = BackendMessage.parse(
            """{"type":"streams","streams":[{"id":"news","title":"News 24","category":["Featured"],"isLive":true,"order":1,"featured":true,"type":"live"}]}"""
        ) as BackendMessage.Streams
        assertEquals(1, m.streams.size)
        val s = m.streams[0]
        assertEquals("news", s.id)
        assertEquals("News 24", s.title)
        assertEquals(listOf("Featured"), s.category)
        assertEquals(true, s.isLive)
        assertEquals(1, s.order)
        assertEquals(true, s.featured)
    }

    @Test fun `port carries url source streamId recordType`() {
        val m = BackendMessage.parse(
            """{"type":"port","port":8781,"url":"http://127.0.0.1:8781/index.m3u8","source":"p2p","streamId":"news","recordType":"vod","durationSec":12.5}"""
        ) as BackendMessage.Port
        assertEquals(8781, m.port)
        assertEquals("p2p", m.source)
        assertEquals("news", m.streamId)
        assertEquals("vod", m.recordType)
        assertEquals(12.5, m.durationSec!!, 0.0)
    }

    @Test fun `redirect port has no port number`() {
        val m = BackendMessage.parse(
            """{"type":"port","url":"https://cdn.example.com/x.m3u8","source":"cdn","streamId":"promo"}"""
        ) as BackendMessage.Port
        assertNull(m.port)
        assertEquals("cdn", m.source)
    }

    @Test fun `prefs with creds and favorites`() {
        val m = BackendMessage.parse(
            """{"type":"prefs","creds":{"username":"u","password":"p"},"favorites":["a","b"]}"""
        ) as BackendMessage.Prefs
        assertEquals("u", m.username)
        assertEquals(listOf("a", "b"), m.favorites)
    }

    @Test fun `prefs with null creds`() {
        val m = BackendMessage.parse("""{"type":"prefs","creds":null,"favorites":[]}""") as BackendMessage.Prefs
        assertNull(m.username)
    }

    @Test fun `unknown types pass through as Raw`() {
        val m = BackendMessage.parse("""{"type":"zap-prefetch","enabled":true}""")
        assertTrue(m is BackendMessage.Raw)
    }

    @Test fun `garbage and blanks are ignored`() {
        assertNull(BackendMessage.parse(""))
        assertNull(BackendMessage.parse("not json"))
    }
}
