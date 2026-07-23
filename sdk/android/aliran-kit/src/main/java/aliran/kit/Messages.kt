// The engine's IPC message surface — the Kotlin twin of the BackendMessage union in
// sdk/react-native/src/backend.ts. One line of JSON per message, both directions
// (see client/backend/backend.mjs for the worklet side).
package aliran.kit

import org.json.JSONArray
import org.json.JSONObject

/** A catalog entry the viewer is entitled to (the engine's `streams` reply). */
data class Stream(
    val id: String,
    val title: String,
    val description: String? = null,
    val category: List<String> = emptyList(),
    val isLive: Boolean? = null,
    val poster: String? = null,
    val backdrop: String? = null,
    val logo: String? = null,
    /** Panel curation: rail sort key (lower first; null sorts last). */
    val order: Int? = null,
    val featured: Boolean = false,
    val epgUrl: String? = null,
    val epgId: String? = null,
    /** Record class (S8a): "vod" = on-demand title, "live"/null = live channel. */
    val type: String? = null,
    val durationSec: Double? = null,
    val status: String? = null
)

sealed class BackendMessage {
    /** Engine booted (worklet + swarm up). */
    object Ready : BackendMessage()
    data class Streams(val streams: List<Stream>) : BackendMessage()
    data class LoginError(val message: String) : BackendMessage()
    /** Reply to play(): what the shared localhost URL now serves. recordType "vod"
     *  means a finished library title (seek UI, no live self-heal). */
    data class Port(
        val port: Int?, val url: String?, val source: String?,
        val streamId: String?, val recordType: String?, val durationSec: Double?
    ) : BackendMessage()
    data class Status(val peers: Int?, val state: String?, val message: String?) : BackendMessage()
    data class Fallback(val streamId: String, val url: String, val reason: String) : BackendMessage()
    data class SourceChanged(val streamId: String, val source: String, val url: String) : BackendMessage()
    /** The active stream's feed rotated under the viewer — same localhost URL, new
     *  feed behind it; players must rebuild to flush the stale playlist. */
    data class FeedChanged(val streamId: String, val feedKey: String, val url: String) : BackendMessage()
    data class Prefs(
        val username: String?, val password: String?, val favorites: List<String>
    ) : BackendMessage()
    data class Error(val message: String) : BackendMessage()
    /** Anything this version doesn't model (zap-prefetch lifecycle, future types) —
     *  passed through so hosts can react without an SDK update. */
    data class Raw(val json: JSONObject) : BackendMessage()

    companion object {
        /** One IPC line → one message; null for blank/unparseable lines (ignored,
         *  matching the RN binding's tolerance). */
        fun parse(line: String): BackendMessage? {
            if (line.isBlank()) return null
            val o = try { JSONObject(line) } catch (_: Exception) { return null }
            return when (o.optString("type")) {
                "ready" -> Ready
                "streams" -> Streams(parseStreams(o.optJSONArray("streams")))
                "login-error" -> LoginError(o.optString("message"))
                "port" -> Port(
                    if (o.has("port") && !o.isNull("port")) o.optInt("port") else null,
                    o.optStringOrNull("url"),
                    o.optStringOrNull("source"),
                    o.optStringOrNull("streamId"),
                    o.optStringOrNull("recordType"),
                    if (o.has("durationSec") && !o.isNull("durationSec")) o.optDouble("durationSec") else null
                )
                "status" -> Status(
                    if (o.has("peers") && !o.isNull("peers")) o.optInt("peers") else null,
                    o.optStringOrNull("state"),
                    o.optStringOrNull("message")
                )
                "fallback" -> Fallback(o.optString("streamId"), o.optString("url"), o.optString("reason"))
                "source-changed" -> SourceChanged(o.optString("streamId"), o.optString("source"), o.optString("url"))
                "feed-changed" -> FeedChanged(o.optString("streamId"), o.optString("feedKey"), o.optString("url"))
                "prefs" -> {
                    val creds = o.optJSONObject("creds")
                    Prefs(
                        creds?.optStringOrNull("username"),
                        creds?.optStringOrNull("password"),
                        stringList(o.optJSONArray("favorites"))
                    )
                }
                "error" -> Error(o.optString("message"))
                else -> Raw(o)
            }
        }

        private fun parseStreams(arr: JSONArray?): List<Stream> {
            if (arr == null) return emptyList()
            val out = ArrayList<Stream>(arr.length())
            for (i in 0 until arr.length()) {
                val s = arr.optJSONObject(i) ?: continue
                out.add(
                    Stream(
                        id = s.optString("id"),
                        title = s.optString("title"),
                        description = s.optStringOrNull("description"),
                        category = stringList(s.optJSONArray("category")),
                        isLive = if (s.has("isLive") && !s.isNull("isLive")) s.optBoolean("isLive") else null,
                        poster = s.optStringOrNull("poster"),
                        backdrop = s.optStringOrNull("backdrop"),
                        logo = s.optStringOrNull("logo"),
                        order = if (s.has("order") && !s.isNull("order")) s.optInt("order") else null,
                        featured = s.optBoolean("featured", false),
                        epgUrl = s.optStringOrNull("epgUrl"),
                        epgId = s.optStringOrNull("epgId"),
                        type = s.optStringOrNull("type"),
                        durationSec = if (s.has("durationSec") && !s.isNull("durationSec")) s.optDouble("durationSec") else null,
                        status = s.optStringOrNull("status")
                    )
                )
            }
            return out
        }

        private fun stringList(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            return (0 until arr.length()).mapNotNull { arr.optString(it, null) }
        }

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (has(key) && !isNull(key)) optString(key) else null
    }
}
