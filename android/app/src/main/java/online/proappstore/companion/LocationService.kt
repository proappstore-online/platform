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
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "Location sharing", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == PAUSE) { graph.local.paused = true; stopSelf(); return START_NOT_STICKY }
        if (!allowed(this) || graph.repository.token() == null || graph.local.paused || recipients().isEmpty()) {
            stopSelf(); return START_NOT_STICKY
        }
        startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        if (!started) {
            started = true; running = true
            try {
                // Native Android API; no WebView timers, Google account or Play Services dependency.
                for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                    if (manager.allProviders.contains(provider)) manager.requestLocationUpdates(provider, 10_000L, 5f, this, Looper.getMainLooper())
                }
            } catch (_: SecurityException) { graph.local.message = "Location permission changed."; stopSelf(); return START_NOT_STICKY }
            scope.launch {
                while (isActive) {
                    if (!allowed(this@LocationService) || graph.local.paused || recipients().isEmpty() || graph.repository.token() == null) { stopSelf(); break }
                    try { graph.repository.sync() } catch (_: Exception) { /* durable queue is retried by WorkManager too */ }
                    getSystemService(NotificationManager::class.java).notify(1, notification())
                    delay(30_000)
                }
            }
        }
        return START_STICKY
    }
    private fun recipients(): List<String> = LocationPolicy.recipients(graph.local.apps(), graph.local.blocked(), System.currentTimeMillis())
    override fun onLocationChanged(location: Location) {
        if (graph.local.paused || !allowed(this) || location.time <= lastFixAt) return
        val point = TrackPoint(UUID.randomUUID().toString(), location.time, location.latitude, location.longitude, location.accuracy,
            LocationPolicy.recipients(graph.local.apps(), graph.local.blocked(), location.time))
        if (!LocationPolicy.valid(point, System.currentTimeMillis())) return
        lastFixAt = point.at
        scope.launch {
            try {
                // Re-evaluate consent after crossing onto the storage dispatcher.
                if (!graph.local.paused) {
                    val current = recipients().toSet()
                    val retained = point.copy(grants = point.grants.filter { it in current })
                    if (retained.grants.isNotEmpty()) graph.local.enqueue(retained)
                }
            } catch (_: Exception) {
                graph.local.paused = true; graph.local.message = "Could not save location on this phone. Collection paused."; stopSelf()
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
        val apps = graph.local.apps().filter { it.grantId != null && it.id !in graph.local.blocked() }.joinToString { it.name }
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_location).setContentTitle("ProAppStore location sharing")
            .setContentText(if (lastFixAt == 0L || System.currentTimeMillis() - lastFixAt > 30_000) "Waiting for GPS · $apps" else "Sharing with $apps")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(0, "Pause all", pause).build()
    }
    companion object {
        private const val CHANNEL = "pas-location"
        private const val PAUSE = "online.proappstore.PAUSE"
        @Volatile var running = false
            private set
        fun allowed(context: Context): Boolean = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            .all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
        fun start(context: Context) { ContextCompat.startForegroundService(context, Intent(context, LocationService::class.java)) }
    }
}
