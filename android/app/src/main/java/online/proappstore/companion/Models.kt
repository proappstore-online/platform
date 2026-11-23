package online.proappstore.companion

data class ConnectedApp(
    val id: String, val name: String, val purpose: String, val disclosure: String,
    val version: String, val grantId: String?, val consentAt: Long = 0,
)
/** One reviewed (app, capability) entry from `GET /native/me` `capabilities` (ADR-018 §7); `apps` stays location's. Ported from iOS Models.swift. */
data class NativeEntry(
    val appId: String, val appName: String, val capability: String, val name: String, val purpose: String, val disclosure: String,
    val version: String, val grantId: String?, val consentAt: Long = 0,
) {
    /** The on-phone `blocked` key: the bare app id for location, as before #634, else `app/capability`. */
    val key: String get() = if (capability == LOCATION) appId else "$appId/$capability"
    companion object { const val LOCATION = "location.background" }
}
data class TrackPoint(val id: String, val at: Long, val lat: Double, val lng: Double, val accuracy: Float, val grants: List<String>)

/** One shared point from the on-device history. `sentAt` null = still waiting to upload. */
data class TrackSample(val at: Long, val lat: Double, val lng: Double, val accuracy: Double, val sentAt: Long?)

/** One row of the on-device sharing record (#621). `appId` null = device-wide. `detail` is a short code, never coordinates or response bodies. */
data class ShareEvent(val id: Long, val at: Long, val appId: String?, val kind: Kind, val detail: String) {
    enum class Kind(val raw: String) {
        ENABLED("enabled"), DISABLED("disabled"), PAUSED("paused"), RESUMED("resumed"),
        PAUSED_ALL("paused_all"), RESUMED_ALL("resumed_all"), STOPPED("stopped"),
        GRANT_LOST("grant_lost"), HISTORY_CLEARED("history_cleared"),
        // Activity log only (#624).
        SYNC_FAILED("sync_failed"), SYNC_RECOVERED("sync_recovered"), UPLOAD_REJECTED("upload_rejected"), QUOTA("quota"),
        PERMISSION("permission"), QUEUE_FULL("queue_full"), GRANT_RESTORED("grant_restored"),
        /** The device connection expired or was revoked (#652); `detail` "renew" when the user reconnected early. */
        EXPIRED("expired"),
        /**
         * Heart rate (#634). `HEART_RATE` detail: enabled, disabled, sensor_chosen, connected, lost, forgotten.
         * `HEART_RATE_PROBLEM` detail: queue_full, partial_ack, or a rejected upload's status. `BLUETOOTH` detail: off, on,
         * unauthorized. Sessions ignore all three: location sessions stay location's.
         */
        HEART_RATE("heart_rate"), HEART_RATE_PROBLEM("heart_rate_problem"), BLUETOOTH("bluetooth");
        companion object { fun of(raw: String): Kind? = entries.firstOrNull { it.raw == raw } }
    }
}

/** The device connection's lifetime (#652). Pure, so the rules are unit-tested. */
object DeviceConnection {
    /** Only a 401 means the credential expired or was revoked. Network errors, 429 and 5xx never do. */
    fun expired(e: Throwable): Boolean = e is ApiFailure && e.status == 401
    private const val DAY_MS = 24L * 60 * 60 * 1000
    /** The days left when `device.expiresAt` is under 7 days away, else null. */
    fun expiresInDays(expiresAt: Long, now: Long): Int? {
        val left = expiresAt - now
        if (expiresAt <= 0 || left <= 0 || left >= 7 * DAY_MS) return null
        return ((left + DAY_MS - 1) / DAY_MS).toInt()
    }
}

object LocationPolicy {
    const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    const val MAX_QUEUE = 60_000
    /** On-device sharing history (#621): kept 30 days, capped at about 20-30 MB worst case. */
    const val HISTORY_MS = 30L * 24 * 60 * 60 * 1000
    const val HISTORY_MAX_POINTS = 200_000
    fun valid(point: TrackPoint, now: Long): Boolean = point.at in (now - 15_000)..(now + 2_000) &&
        point.lat.isFinite() && point.lat in -90.0..90.0 && point.lng.isFinite() && point.lng in -180.0..180.0 &&
        point.accuracy.isFinite() && point.accuracy in 0f..100f && point.grants.isNotEmpty()
    fun recipients(apps: List<ConnectedApp>, blocked: Set<String>, at: Long): List<String> = apps
        .filter { it.id !in blocked && it.grantId != null && at >= it.consentAt }.mapNotNull { it.grantId }

    // #639: indoor GPS jitter must not become a track. 16 minutes at home once uploaded 39 points and a 366 m scribble.
    const val EMIT_MIN_METERS = 10.0
    /** A stationary phone still emits this often, so apps see "still here". */
    const val HEARTBEAT_MS = 5L * 60 * 1000
    /** A Doppler speed below this, reported with a speed accuracy, counts as stationary. */
    const val STATIONARY_SPEED = 0.3f
    /** How often the collector refreshes grants when it has nothing to upload or revoke. */
    const val IDLE_SYNC_MS = 5L * 60 * 1000

    /**
     * Whether a valid fix becomes a queued point. The first fix and a heartbeat always do. Otherwise a fix with a valid
     * Doppler `speed` under [STATIONARY_SPEED] never does, and one must be at least `max(10 m, both accuracies)` from
     * the last emitted point, so jitter inside the accuracy circle is dropped. `speed` is null when the fix has none.
     */
    fun shouldEmit(last: TrackPoint?, fix: TrackPoint, speed: Float?): Boolean {
        if (last == null || fix.at - last.at >= HEARTBEAT_MS) return true
        if (speed != null && speed < STATIONARY_SPEED) return false
        return distanceMeters(last.lat, last.lng, fix.lat, fix.lng) >= maxOf(EMIT_MIN_METERS, last.accuracy.toDouble(), fix.accuracy.toDouble())
    }

    /** Great-circle distance (haversine, mean Earth radius). */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val dLat = Math.toRadians(lat2 - lat1); val dLng = Math.toRadians(lng2 - lng1)
        val a = Math.sin(dLat / 2).let { it * it } + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLng / 2).let { it * it }
        return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a.coerceAtMost(1.0)))
    }

    /** The collector syncs when there is something to upload or revoke; otherwise only to refresh grants every [IDLE_SYNC_MS]. */
    fun syncDue(queued: Int, revoking: Boolean, lastSync: Long, now: Long): Boolean = queued > 0 || revoking || now - lastSync >= IDLE_SYNC_MS
}
