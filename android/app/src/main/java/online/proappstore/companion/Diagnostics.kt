package online.proappstore.companion

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The phone's state that lives behind a Context (#660), read by [PasApplication]. `location` is LocationService.permissionState,
 * `bluetooth` is Bluetooth.state (`on`, `off`, `unauthorized`), `collecting` is LocationService.running.
 */
data class DiagnosticsDevice(
    val os: String, val location: String, val precise: Boolean, val bluetooth: String, val notifications: String,
    val batteryOptimized: Boolean, val powerSave: Boolean, val locationServices: Boolean,
    val collecting: Boolean, val heartRateConnected: Boolean,
)

/** One `share_events` row with its raw kind, so kinds this build does not know are still reported. */
data class ActivityRow(val at: Long, val appId: String?, val kind: String, val detail: String)

/** Everything the snapshot is built from. Counts and states only: no queue payloads, points or heart-rate samples. */
data class DiagnosticsInput(
    val now: Long, val version: String, val build: String, val device: DiagnosticsDevice,
    val entries: List<NativeEntry>, val blocked: Set<String>, val expired: Boolean, val sessions: List<Session>,
    val heartRateSensor: Boolean, val queue: Int, val heartRateQueue: Int,
    val lastSync: Long, val lastSyncAttempt: Long, val lastSyncError: String,
    val heartRateLastUpload: Long, val heartRateSyncError: String,
    /** Every `session_ended` row; the builder keeps each app's latest. */
    val sessionEnds: List<ActivityRow>,
    /** The last 7 days of `share_events`, newest first, at most [Diagnostics.MAX_EVENTS]. */
    val activity: List<ActivityRow>,
)

/** The persisted diagnostics state. [LocalStore] keeps it in prefs; tests use a fake. */
interface DiagnosticsStore {
    val diagnosticsEnabled: Boolean
    val diagnosticsSentAt: Long
    val diagnosticsFingerprint: String
    var diagnosticsDeletePending: Boolean
    /** After a 2xx only: when, the fingerprint, and the exact snapshot JSON sent. */
    fun diagnosticsSent(at: Long, fingerprint: String, snapshot: String)
}

/**
 * Phone diagnostics (#660, ADR-019): a whitelisted snapshot of the companion's state, sent at the end of a sync. It never
 * contains a location, a heart-rate reading or a sensor identifier. Pure, so the rules are unit-tested.
 */
object Diagnostics {
    const val PATH = "/native/diagnostics"
    const val MAX_EVENTS = 200
    const val WINDOW_MS = 7L * 24 * 60 * 60 * 1000
    /** Under the server's 64 KB body cap with room for the `{"snapshot":…}` wrapper. */
    const val MAX_BYTES = 60_000
    const val REFRESH_MS = 15L * 60 * 1000
    const val CHANGE_MS = 60_000L
    private const val MAX_LIST = 50
    private val CODE = Regex("^[a-z_]{1,24}$")
    private val KIND = Regex("^[a-z_]{1,32}$")

    /** The heart-rate collector's state as one code, derived like the Heart rate line (SharingScreen heartRateState). */
    fun heartRateState(
        entries: List<NativeEntry>, blocked: Set<String>, expired: Boolean, sessions: Set<String>,
        sensor: Boolean, bluetooth: String, queued: Int, connected: Boolean,
    ): String {
        val enabled = entries.filter { it.capability == HeartRate.CAPABILITY && it.grantId != null && it.key !in blocked && !expired }
        return when {
            enabled.isEmpty() -> "off"
            enabled.none { it.appId in sessions } -> "no_session"
            !sensor -> "no_sensor"
            bluetooth == "unauthorized" -> "bluetooth_denied"
            bluetooth == "off" -> "bluetooth_off"
            queued >= HeartRatePolicy.MAX_QUEUE -> "queue_full"
            !connected -> "not_connected"
            else -> "connected"
        }
    }

    /** Each app's latest `session_ended`, newest first, skipping a reason the server would reject. */
    fun lastEnded(rows: List<ActivityRow>): List<ActivityRow> = rows.filter { it.appId != null && CODE.matches(it.detail) }
        .groupBy { it.appId }.values.map { group -> group.maxBy { it.at } }.sortedByDescending { it.at }.take(MAX_LIST)

    fun build(input: DiagnosticsInput): JSONObject {
        val d = input.device
        val bluetooth = when (d.bluetooth) {
            "on" -> "allowed"; "off" -> "off"
            else -> if (input.heartRateSensor) "denied" else "notDetermined"
        }
        val sessionIds = input.sessions.mapTo(mutableSetOf()) { it.appId }
        val snapshot = JSONObject()
            .put("v", 1).put("at", input.now)
            .put("app", JSONObject().put("platform", "android").put("version", input.version).put("build", input.build).put("os", d.os.take(40)))
            .put("permissions", JSONObject().put("location", d.location).put("precise", d.precise).put("bluetooth", bluetooth)
                .put("notifications", d.notifications).put("batteryOptimized", d.batteryOptimized).put("powerSave", d.powerSave)
                .put("locationServices", d.locationServices))
            .put("sensors", JSONObject()
                .put("location", when { d.collecting -> "collecting"; input.sessions.isEmpty() -> "idle"; else -> "stopped" })
                .put("heartRate", heartRateState(input.entries, input.blocked, input.expired, sessionIds, input.heartRateSensor,
                    d.bluetooth, input.heartRateQueue, d.heartRateConnected)))
            .put("queue", JSONObject().put("location", input.queue).put("heartRate", input.heartRateQueue))
            .put("sync", JSONObject().put("lastSuccessAt", input.lastSync.orNull()).put("lastAttemptAt", input.lastSyncAttempt.orNull())
                .put("lastError", input.lastSyncError.take(120))
                .put("heartRate", JSONObject().put("lastUploadAt", input.heartRateLastUpload.orNull()).put("lastError", input.heartRateSyncError.take(120))))
            .put("collection", JSONObject()
                .put("sessions", JSONArray(input.sessions.take(MAX_LIST).map {
                    JSONObject().put("appId", it.appId).put("startedAt", it.startedAt).put("lastMovedAt", it.lastMovedAt)
                }))
                .put("lastEnded", JSONArray(lastEnded(input.sessionEnds).map { JSONObject().put("appId", it.appId).put("at", it.at).put("reason", it.detail) }))
                .put("pendingRevocations", JSONArray(input.blocked.sorted().take(MAX_LIST))))
        val activity = JSONArray()
        snapshot.put("activity", activity)
        // Capped by bytes (#660 comment 3): newest first, so the oldest events are the ones dropped.
        var bytes = snapshot.toString().utf8()
        for (row in input.activity.filter { it.at >= input.now - WINDOW_MS && KIND.matches(it.kind) }.take(MAX_EVENTS)) {
            val event = JSONObject().put("at", row.at).put("appId", row.appId ?: JSONObject.NULL).put("kind", row.kind).put("detail", row.detail.take(120))
            val size = event.toString().utf8() + if (activity.length() > 0) 1 else 0
            if (bytes + size > MAX_BYTES) break
            activity.put(event); bytes += size
        }
        return snapshot
    }

    /** The snapshot without what changes on every sync: `at`, `queue`, and the sync times. Changing it allows a send after 60 s. */
    fun fingerprint(snapshot: JSONObject): String {
        val copy = JSONObject(snapshot.toString())
        copy.remove("at"); copy.remove("queue")
        copy.optJSONObject("sync")?.let { sync ->
            sync.remove("lastAttemptAt"); sync.remove("lastSuccessAt")
            sync.optJSONObject("heartRate")?.remove("lastUploadAt")
        }
        return MessageDigest.getInstance("SHA-256").digest(copy.toString().toByteArray()).joinToString("") { "%02x".format(it) }
    }

    /** Never sent, 15 minutes since the last send, or a changed fingerprint 60 s after it. */
    fun due(sentAt: Long, lastFingerprint: String, fingerprint: String, now: Long): Boolean =
        sentAt == 0L || now - sentAt >= REFRESH_MS || (fingerprint != lastFingerprint && now - sentAt >= CHANGE_MS)

    /**
     * First in a sync: the user turned diagnostics off, so the server copy goes. The flag clears only on a 2xx, so turning
     * off offline still deletes on the next connection. Best effort, except a 401, which `request` has already expired.
     */
    fun deleteIfPending(store: DiagnosticsStore, request: (String, String, JSONObject?) -> Unit) {
        if (!store.diagnosticsDeletePending) return
        try { request("DELETE", PATH, null); store.diagnosticsDeletePending = false } catch (e: Exception) { if (DeviceConnection.expired(e)) throw e }
    }

    /**
     * Last in a sync, after both uploads, whether they succeeded or not. Best effort: a failure here never reaches the sync's
     * error state and never throws, except a 401 (the device path's expiry).
     */
    fun sendIfDue(store: DiagnosticsStore, now: Long, build: () -> JSONObject?, request: (String, String, JSONObject?) -> Unit) {
        if (!store.diagnosticsEnabled) return
        val sentAt = store.diagnosticsSentAt
        if (sentAt != 0L && now - sentAt < CHANGE_MS) return // nothing could be due; skip reading the store
        val snapshot = try { build() } catch (_: Exception) { null } ?: return
        val fingerprint = fingerprint(snapshot)
        if (!due(sentAt, store.diagnosticsFingerprint, fingerprint, now)) return
        val json = snapshot.toString()
        try { request("PUT", PATH, JSONObject().put("snapshot", snapshot)) } catch (e: Exception) { if (DeviceConnection.expired(e)) throw e; return }
        store.diagnosticsSent(now, fingerprint, json)
    }

    private fun Long.orNull(): Any = if (this > 0) this else JSONObject.NULL
    private fun String.utf8(): Int = toByteArray(Charsets.UTF_8).size
}
