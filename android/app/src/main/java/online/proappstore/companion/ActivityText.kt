package online.proappstore.companion

/** Plain sentences for the activity log. Pure; ported from iOS ActivityText.swift. */
object ActivityText {
    enum class Category { SHARING, PROBLEM }

    fun category(kind: ShareEvent.Kind): Category = when (kind) {
        ShareEvent.Kind.ENABLED, ShareEvent.Kind.DISABLED, ShareEvent.Kind.PAUSED, ShareEvent.Kind.RESUMED, ShareEvent.Kind.PAUSED_ALL,
        ShareEvent.Kind.RESUMED_ALL, ShareEvent.Kind.GRANT_LOST, ShareEvent.Kind.GRANT_RESTORED, ShareEvent.Kind.HISTORY_CLEARED, ShareEvent.Kind.HEART_RATE -> Category.SHARING
        ShareEvent.Kind.STOPPED, ShareEvent.Kind.SYNC_FAILED, ShareEvent.Kind.SYNC_RECOVERED, ShareEvent.Kind.UPLOAD_REJECTED,
        ShareEvent.Kind.QUOTA, ShareEvent.Kind.PERMISSION, ShareEvent.Kind.QUEUE_FULL, ShareEvent.Kind.EXPIRED,
        ShareEvent.Kind.HEART_RATE_PROBLEM, ShareEvent.Kind.BLUETOOTH -> Category.PROBLEM
    }

    private val permissionNames = mapOf("denied" to "Not allowed", "approximate" to "Approximate only", "whenInUse" to "While using the app", "always" to "All the time")

    /** `appName` is the app's display name, or null for device-wide events. */
    fun sentence(event: ShareEvent, appName: String?): String {
        val app = appName ?: event.appId ?: "App"
        return when (event.kind) {
            ShareEvent.Kind.ENABLED -> "$app sharing turned on"
            ShareEvent.Kind.DISABLED -> "$app sharing turned off"
            ShareEvent.Kind.PAUSED -> "$app paused by you"
            ShareEvent.Kind.RESUMED -> "$app resumed by you"
            ShareEvent.Kind.PAUSED_ALL -> "All sharing paused by you"
            ShareEvent.Kind.RESUMED_ALL -> "All sharing resumed"
            ShareEvent.Kind.STOPPED -> "Sharing stopped: " + (mapOf(
                "signed_out" to "this phone was signed out", "storage_failed" to "location could not be saved on this phone",
                "unlock_failed" to "the device connection could not be unlocked")[event.detail] ?: event.detail)
            ShareEvent.Kind.GRANT_LOST -> if (event.detail == "replaced") "$app access replaced by ProAppStore (the app changed owner or its disclosure)"
                else "$app access revoked by ProAppStore (the app changed owner or its disclosure)"
            ShareEvent.Kind.GRANT_RESTORED -> "$app access restored"
            ShareEvent.Kind.HISTORY_CLEARED -> "History cleared"
            ShareEvent.Kind.SYNC_FAILED -> {
                // detail = "<status> <server error text>", status 0 = network; or a local failure's text.
                val parts = event.detail.split(" ", limit = 2)
                val status = parts.first().toIntOrNull()
                when {
                    status == null -> "Upload failed: ${event.detail}"
                    status == 0 -> "Upload failed (offline)"
                    else -> "Upload failed: ${parts.getOrNull(1)?.takeIf { it.isNotBlank() } ?: "error"} ($status)"
                }
            }
            ShareEvent.Kind.SYNC_RECOVERED -> "Uploads working again ${event.detail}".trim()
            ShareEvent.Kind.UPLOAD_REJECTED -> if (event.detail == "partial_ack") "Upload not fully acknowledged: the copy on this phone was kept"
                else "Upload rejected by ProAppStore (${event.detail})"
            ShareEvent.Kind.QUOTA -> "Upload limit reached (429)"
            ShareEvent.Kind.PERMISSION -> {
                val sides = event.detail.split("→")
                when {
                    sides.size == 2 && sides[1] == "approximate" -> "Precise location turned off: recording stopped"
                    sides.size == 2 && sides[0] == "approximate" && sides[1] != "denied" -> "Precise location turned on"
                    else -> "Location permission changed: " + sides.joinToString(" → ") { permissionNames[it] ?: it }
                }
            }
            ShareEvent.Kind.QUEUE_FULL -> "Storage queue full: recording stopped until uploads catch up"
            ShareEvent.Kind.EXPIRED -> if (event.detail == "renew") "Reconnecting to ProAppStore: sharing stopped until you re-enable apps"
                else "Connection to ProAppStore expired: sharing stopped"
            ShareEvent.Kind.HEART_RATE -> when (event.detail) {
                "enabled" -> "$app heart rate turned on"
                "disabled" -> "$app heart rate turned off"
                "sensor_chosen" -> "Heart-rate sensor chosen"
                "connected" -> "Heart-rate sensor connected"
                "lost" -> "Heart-rate sensor disconnected or out of range"
                "forgotten" -> "Heart-rate sensor forgotten"
                else -> "Heart rate: ${event.detail}"
            }
            ShareEvent.Kind.HEART_RATE_PROBLEM -> when (event.detail) {
                "queue_full" -> "Heart-rate queue full: heart rate stopped until uploads catch up"
                "partial_ack" -> "Heart-rate upload not fully acknowledged: the copy on this phone was kept"
                else -> "Heart-rate upload rejected by ProAppStore (${event.detail})"
            }
            ShareEvent.Kind.BLUETOOTH -> when (event.detail) {
                "off" -> "Bluetooth turned off: heart rate stopped"
                "on" -> "Bluetooth turned on"
                "unauthorized" -> "Bluetooth permission denied: heart rate stopped"
                else -> "Bluetooth: ${event.detail}"
            }
        }
    }
}
