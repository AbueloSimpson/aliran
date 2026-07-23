package aliran.kit

import org.junit.Assert.assertEquals
import org.junit.Test

class LineAccumulatorTest {
    private fun collect(vararg chunks: ByteArray): List<String> {
        val out = mutableListOf<String>()
        val acc = LineAccumulator { out.add(it) }
        chunks.forEach { acc.feed(it) }
        return out
    }

    @Test fun `single line`() {
        assertEquals(listOf("""{"type":"ready"}"""), collect("""{"type":"ready"}""".toByteArray() + '\n'.code.toByte()))
    }

    @Test fun `line split across chunks`() {
        assertEquals(listOf("hello world"), collect("hello ".toByteArray(), "world\n".toByteArray()))
    }

    @Test fun `multiple lines in one chunk plus a trailing partial`() {
        assertEquals(listOf("a", "b"), collect("a\nb\npartial".toByteArray()))
    }

    @Test fun `partial completes later`() {
        assertEquals(listOf("a", "partial-done"), collect("a\npartial".toByteArray(), "-done\n".toByteArray()))
    }

    @Test fun `multibyte utf8 split at a chunk boundary`() {
        val text = "café-🎥"
        val bytes = "$text\n".toByteArray(Charsets.UTF_8)
        // split INSIDE the emoji's 4-byte sequence
        val cut = bytes.size - 3
        assertEquals(listOf(text), collect(bytes.copyOfRange(0, cut), bytes.copyOfRange(cut, bytes.size)))
    }

    @Test fun `blank lines are skipped`() {
        assertEquals(listOf("x"), collect("\n\nx\n".toByteArray()))
    }
}
