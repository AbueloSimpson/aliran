// Byte-safe line splitter for the worklet IPC stream. IPC delivers arbitrary
// chunks; a chunk boundary can land inside a UTF-8 sequence, so accumulation and
// splitting happen on BYTES and only complete lines are decoded. Pure Kotlin —
// unit-tested on the JVM.
package aliran.kit

import java.io.ByteArrayOutputStream

internal class LineAccumulator(private val onLine: (String) -> Unit) {
    private var buf = ByteArrayOutputStream()

    fun feed(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset) {
        buf.write(bytes, offset, length)
        var data = buf.toByteArray()
        var start = 0
        while (true) {
            val nl = data.indexOf('\n'.code.toByte(), start)
            if (nl < 0) break
            if (nl > start) onLine(String(data, start, nl - start, Charsets.UTF_8))
            start = nl + 1
        }
        if (start > 0) {
            buf = ByteArrayOutputStream()
            if (start < data.size) buf.write(data, start, data.size - start)
        }
    }

    private fun ByteArray.indexOf(byte: Byte, from: Int): Int {
        for (i in from until size) if (this[i] == byte) return i
        return -1
    }
}
