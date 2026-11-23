package online.proappstore.companion

data class ConnectedApp(
    val id: String, val name: String, val purpose: String, val disclosure: String,
    val version: String, val grantId: String?, val consentAt: Long = 0,
)
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
        PERMISSION("permission"), QUEUE_FULL("queue_full"), GRANT_RESTORED("grant_restored");
        companion object { fun of(raw: String): Kind? = entries.firstOrNull { it.raw == raw } }
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
}
