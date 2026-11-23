package online.proappstore.companion

import android.Manifest
import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationManager
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationListenerCompat
import kotlinx.coroutines.*
import java.util.UUID

class LocationService : Service(), LocationListenerCompat {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val graph get() = application as PasApplication
    private val manager by lazy { getSystemService(LocationManager::class.java) }
    private var started = false
    private var lastFixAt = 0L
    /** The last fix that became a queued point (#639), and when the collector last synced. */
    private var lastEmitted: TrackPoint? = null
    private var lastSyncAt = 0L
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Location sharing", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == PAUSE) { graph.local.paused = true; stopSelf(); return START_NOT_STICKY }
        notePermission(this, graph.local)
        if (!allowed(this) || !graph.repository.collecting()) { stopSelf(); return START_NOT_STICKY }
        try {
            startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (_: IllegalStateException) {
            // Android 12+ refuses a foreground start from the background (ForegroundServiceStartNotAllowedException),
            // which is what a START_STICKY restart after the process was killed is. Opening ProAppStore starts it again.
            graph.local.message = "Android stopped location sharing in the background. Open ProAppStore to resume."
            stopSelf(); return START_NOT_STICKY
        }
        if (!started) {
            started = true; running = true
            try {
                // Native Android API; no WebView timers, Google account or Play Services dependency.
                for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                    // No distance filter: LocationPolicy.shouldEmit decides, and needs fixes while still for the heartbeat.
                    if (manager.allProviders.contains(provider)) manager.requestLocationUpdates(provider, 10_000L, 0f, this, Looper.getMainLooper())
                }
            } catch (_: SecurityException) { graph.local.message = "Location permission changed."; stopSelf(); return START_NOT_STICKY }
            scope.launch {
                while (isActive) {
                    notePermission(this@LocationService, graph.local)
                    if (!allowed(this@LocationService) || !graph.repository.collecting()) { stopSelf(); break }
                    // Battery: no request while there is nothing to upload or revoke, apart from a grant refresh.
                    val now = System.currentTimeMillis()
                    if (LocationPolicy.syncDue(graph.local.count(), graph.local.blocked().isNotEmpty(), lastSyncAt, now)) {
                        lastSyncAt = now
                        try { graph.repository.sync() } catch (_: Exception) { /* durable queue is retried by WorkManager too */ }
                    }
                    getSystemService(NotificationManager::class.java).notify(1, notification())
                    delay(30_000)
                }
            }
        }
        return START_STICKY
    }
    override fun onLocationChanged(location: Location) {
        if (graph.local.paused || !allowed(this) || location.time <= lastFixAt) return
        val point = TrackPoint(UUID.randomUUID().toString(), location.time, location.latitude, location.longitude, location.accuracy,
            LocationPolicy.recipients(graph.local.apps(), graph.local.excluded(), location.time))
        if (!LocationPolicy.valid(point, System.currentTimeMillis())) return
        lastFixAt = point.at
        lastFix = LiveFix(point.at, point.lat, point.lng)
        val speed = location.takeIf { it.hasSpeed() && it.hasSpeedAccuracy() }?.speed
        if (!LocationPolicy.shouldEmit(lastEmitted, point, speed)) return
        lastEmitted = point
        scope.launch {
            try {
                // Re-evaluate consent after crossing onto the storage dispatcher.
                if (!graph.local.paused) {
                    val current = graph.repository.recipients().toSet()
                    val retained = point.copy(grants = point.grants.filter { it in current })
                    if (retained.grants.isNotEmpty()) graph.local.enqueue(retained)
                }
            } catch (_: Exception) {
                graph.local.stop("storage_failed"); graph.local.message = "Could not save location on this phone. Collection paused."; stopSelf()
            }
        }
    }
    override fun onProviderDisabled(provider: String) { graph.local.message = "Location is switched off. Waiting for a GPS signal." }
    override fun onDestroy() {
        manager.removeUpdates(this); scope.cancel(); running = false
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val pause = PendingIntent.getService(this, 1, Intent(this, LocationService::class.java).setAction(PAUSE), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val apps = graph.local.apps().filter { it.grantId != null && it.id !in graph.local.excluded() }.joinToString { it.name }
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_location).setContentTitle("ProAppStore location sharing")
            .setContentText(if (lastFixAt == 0L || System.currentTimeMillis() - lastFixAt > 30_000) "Waiting for GPS · $apps" else "Sharing with $apps")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(0, "Pause all", pause).build()
    }
    companion object {
        private const val CHANNEL = "pas-location"
        private const val PAUSE = "online.proappstore.PAUSE"
        @Volatile var running = false
            private set
        /** Time and place of the last accepted fix, in memory only: the map's live dot. Never a second location source. */
        @Volatile var lastFix: LiveFix? = null
            private set
        fun allowed(context: Context): Boolean = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            .all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
        /** The location access ProAppStore holds: `denied`, `approximate`, `whenInUse` (precise) or `always` (precise, all the time). */
        fun permissionState(context: Context): String {
            fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
            return when {
                !granted(Manifest.permission.ACCESS_FINE_LOCATION) -> if (granted(Manifest.permission.ACCESS_COARSE_LOCATION)) "approximate" else "denied"
                granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION) -> "always"
                else -> "whenInUse"
            }
        }
        /** Activity log: a permission change since the last look, never the first report. */
        fun notePermission(context: Context, local: LocalStore) {
            val now = permissionState(context)
            val old = local.permissionState
            if (old == now) return
            if (old.isNotEmpty()) runCatching { local.record(ShareEvent.Kind.PERMISSION, detail = "$old→$now") }
            local.permissionState = now
        }
        fun start(context: Context) { ContextCompat.startForegroundService(context, Intent(context, LocationService::class.java)) }
    }
}

/** The collector's last accepted fix. */
data class LiveFix(val at: Long, val lat: Double, val lng: Double)
