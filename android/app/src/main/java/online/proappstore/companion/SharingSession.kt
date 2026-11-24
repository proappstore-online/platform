package online.proappstore.companion

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * One app's collection session (ADR-020): started by a tap in the companion, ended by Stop, [LocationPolicy.STATIONARY_TIMEOUT_MS]
 * without movement, [LocationPolicy.MAX_SESSION_MS], or the end of its grant or permission. Local to the phone, like pause before it.
 */
data class Session(val appId: String, val startedAt: Long, val lastMovedAt: Long)

/** An automatic end. `detail` is the `session_ended` row's detail. */
enum class EndReason(val detail: String) { STATIONARY("stationary"), MAX_LENGTH("max") }

/** The session rules. Pure, so they are unit-tested off-device. */
object SharingSessions {
    /** The automatic end due at `now`, or null while the session may run. The 12-hour cap wins over the stationary end. */
    fun endReason(s: Session, now: Long): EndReason? = when {
        now - s.startedAt >= LocationPolicy.MAX_SESSION_MS -> EndReason.MAX_LENGTH
        now - s.lastMovedAt >= LocationPolicy.STATIONARY_TIMEOUT_MS -> EndReason.STATIONARY
        else -> null
    }

    /**
     * Whether `fix` is movement: it would be emitted for distance by [LocationPolicy.shouldEmit] (#639). The first point and
     * a heartbeat are not movement, nor is a fix whose Doppler `speed` is under [LocationPolicy.STATIONARY_SPEED].
     */
    fun moved(last: TrackPoint?, fix: TrackPoint, speed: Float?): Boolean {
        if (last == null || (speed != null && speed < LocationPolicy.STATIONARY_SPEED)) return false
        return LocationPolicy.distanceMeters(last.lat, last.lng, fix.lat, fix.lng) >= LocationPolicy.emitThreshold(last, fix)
    }

    /**
     * Whether `appId` keeps its session when one of its capabilities is turned off: it still has another enabled one (#668,
     * the twin of iOS #677). Turning a capability off never starts or resumes another, and never stops one that is left.
     */
    fun keepsSession(appId: String, apps: List<ConnectedApp>, entries: List<NativeEntry>, blocked: Set<String>): Boolean =
        apps.any { it.id == appId && it.grantId != null && it.id !in blocked } ||
            entries.any { it.appId == appId && it.capability != NativeEntry.LOCATION && it.grantId != null && it.key !in blocked }

    /** "With Run · 42 min": the apps sharing now, and how long the oldest session has run. */
    fun summary(names: List<String>, startedAt: Long, now: Long): String = "With ${names.distinct().joinToString()} · ${Format.duration(now - startedAt)}"

    private val LINK = Regex("^proappstore://native/apps/([A-Za-z0-9_-]{1,64})/?$")
    /** The app a `proappstore://native/apps/<appId>` link names, or null. A link only selects an app (ADR-020 §2, ADR-018 §9). */
    fun linkedApp(uri: String?): String? = uri?.let { LINK.matchEntire(it)?.groupValues?.get(1) }

    fun encode(sessions: List<Session>): String = JSONArray(sessions.map { JSONObject().put("appId", it.appId).put("startedAt", it.startedAt).put("lastMovedAt", it.lastMovedAt) }).toString()
    fun decode(json: String?): List<Session> {
        val array = JSONArray(json ?: "[]")
        return (0 until array.length()).map { i -> array.getJSONObject(i).let { Session(it.getString("appId"), it.getLong("startedAt"), it.getLong("lastMovedAt")) } }
    }

    /** The prefs Pause all (`paused`) and per-app pause (`pausedApps`, #626) used. Retired by ADR-020 §9. */
    private val RETIRED = listOf("paused", "pausedApps")

    /** First run after sessions: drops both pause prefs. No session is created; the user starts each one. */
    fun migrate(prefs: SharedPreferences) {
        if (RETIRED.none(prefs::contains)) return
        val edit = prefs.edit()
        RETIRED.forEach { edit.remove(it) }
        check(edit.commit())
    }
}
