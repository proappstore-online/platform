package online.proappstore.companion

data class ConnectedApp(
    val id: String, val name: String, val purpose: String, val disclosure: String,
    val version: String, val grantId: String?, val consentAt: Long = 0,
)
data class TrackPoint(val id: String, val at: Long, val lat: Double, val lng: Double, val accuracy: Float, val grants: List<String>)

object LocationPolicy {
    const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    const val MAX_QUEUE = 60_000
    fun valid(point: TrackPoint, now: Long): Boolean = point.at in (now - 15_000)..(now + 2_000) &&
        point.lat.isFinite() && point.lat in -90.0..90.0 && point.lng.isFinite() && point.lng in -180.0..180.0 &&
        point.accuracy.isFinite() && point.accuracy in 0f..100f && point.grants.isNotEmpty()
    fun recipients(apps: List<ConnectedApp>, blocked: Set<String>, at: Long): List<String> = apps
        .filter { it.id !in blocked && it.grantId != null && at >= it.consentAt }.mapNotNull { it.grantId }
}
