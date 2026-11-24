package online.proappstore.companion

import android.Manifest
import android.app.*
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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

/**
 * The one collector service: location, Run's strap heart rate (#634), or both. It runs in the foreground with only the
 * types whose permission is held and that have an app with a session ([CollectorTypes]), and re-checks them every 30 s.
 * It runs only while a session the user started in the visible app runs (ADR-020), and ends the sessions that are due.
 */
class LocationService : Service(), LocationListenerCompat {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val graph get() = application as PasApplication
    private val manager by lazy { getSystemService(LocationManager::class.java) }
    private var started = false
    private var lastFixAt = 0L
    /** The last fix that became a queued point (#639), and when the collector last synced. */
    private var lastEmitted: TrackPoint? = null
    private var lastSyncAt = 0L
    private var types = CollectorTypes(location = false, connectedDevice = false)
    private var listening = false
    private var gatt: HeartRateGatt? = null
    private val heartRatePolicy = HeartRatePolicy()
    /**
     * Bluetooth off and on again (#672): the 30 s check cannot see a toggle inside one window, and a `BluetoothGatt` from
     * before the restart never reconnects. Off drops the connection (logged as `lost`); on makes a fresh one. Main thread.
     */
    private val bluetoothState = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> { gatt?.close(); gatt = null; onSensor(false) }
                BluetoothAdapter.STATE_ON -> apply(types)
                else -> return
            }
            Bluetooth.note(this@LocationService, graph.local)
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            NotificationChannel(CHANNEL, "Location sharing", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(ENDED_CHANNEL, "Sharing ended", NotificationManager.IMPORTANCE_DEFAULT)))
        // A system broadcast still reaches a not-exported receiver.
        ContextCompat.registerReceiver(this, bluetoothState, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { graph.local.endAllSessions("notification"); stopSelf(); return START_NOT_STICKY }
        notePermission(this, graph.local); Bluetooth.note(this, graph.local)
        endSessions()
        val wanted = desired()
        if (!wanted.any) { stopSelf(); return START_NOT_STICKY }
        try {
            startForeground(1, notification(wanted), mask(wanted))
        } catch (_: RuntimeException) {
            // Android 12+ refuses a foreground start from the background (ForegroundServiceStartNotAllowedException),
            // which is what a START_STICKY restart after the process was killed is; Android 14 throws SecurityException for
            // a location type without while-in-use access. Opening ProAppStore resumes the session (ADR-020 §7).
            graph.local.message = "Android stopped sharing in the background. Open ProAppStore to resume."
            stopSelf(); return START_NOT_STICKY
        }
        if (!apply(wanted)) return START_NOT_STICKY
        active = true
        if (!started) {
            started = true
            scope.launch {
                while (isActive) {
                    delay(30_000)
                    notePermission(this@LocationService, graph.local); Bluetooth.note(this@LocationService, graph.local)
                    endSessions()
                    val next = desired()
                    if (!next.any) { stopSelf(); break }
                    val kept = next == types || withContext(Dispatchers.Main) {
                        // A permission revoked or a grant ended: keep running with the types that remain.
                        try { startForeground(1, notification(next), mask(next)) } catch (_: RuntimeException) { stopSelf(); return@withContext false }
                        apply(next)
                    }
                    if (!kept) break // stopping: never request GPS or open a GATT connection after stopSelf
                    // Battery: no request while there is nothing to upload or revoke, apart from a grant refresh.
                    val now = System.currentTimeMillis()
                    if (LocationPolicy.syncDue(graph.local.count() + graph.local.heartRateCount(), graph.local.blocked().isNotEmpty(), lastSyncAt, now)) {
                        lastSyncAt = now
                        // The durable queue is retried by WorkManager too. A Stop that cancelled this sync must not fall through
                        // to notify(): that would re-post the ongoing notification with no service behind it.
                        try { graph.repository.sync() } catch (e: Exception) { if (e is CancellationException) throw e }
                    }
                    ensureActive()
                    getSystemService(NotificationManager::class.java).notify(1, notification(types))
                }
            }
        }
        return START_STICKY
    }

    /**
     * Ends the sessions that are due (ADR-020 §3): precise permission withdrawn, or [SharingSessions.endReason]. An automatic
     * end posts its own notification (§4).
     */
    private fun endSessions() {
        val local = graph.local
        val now = System.currentTimeMillis()
        if (!allowed(this)) { local.endAllSessions("permission", now); return }
        for (session in local.sessions()) {
            val reason = SharingSessions.endReason(session, now) ?: continue
            local.endSession(session.appId, reason.detail, now)
            notifyEnded(session.appId, reason)
        }
    }

    /** "Stopped sharing with Run: no movement for 30 minutes". Tapping opens the companion; it restarts nothing. */
    private fun notifyEnded(appId: String, reason: EndReason) {
        val name = graph.local.apps().find { it.id == appId }?.name ?: appId
        val why = when (reason) { EndReason.STATIONARY -> "no movement for 30 minutes"; EndReason.MAX_LENGTH -> "12 hours reached" }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        // Its own tag and id: stopForeground(STOP_FOREGROUND_REMOVE) removes only notification 1.
        runCatching {
            getSystemService(NotificationManager::class.java).notify(appId, ENDED_ID, NotificationCompat.Builder(this, ENDED_CHANNEL)
                .setSmallIcon(R.drawable.ic_location).setContentTitle("Stopped sharing with $name: $why")
                .setContentText("Open ProAppStore and tap Start to share again.").setContentIntent(open).setAutoCancel(true).build())
        }
    }

    /** The types to run now. Heart rate wanted without Bluetooth permission says so: location carries on. */
    private fun desired(): CollectorTypes {
        val heartRate = graph.repository.collectingHeartRate()
        val bluetooth = Bluetooth.permitted(this)
        if (heartRate && !bluetooth) graph.local.message = "Bluetooth permission is off, so heart rate stopped. Location sharing continues."
        return CollectorTypes.select(allowed(this), graph.repository.collecting(), bluetooth, heartRate)
    }

    private fun mask(t: CollectorTypes): Int = (if (t.location) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0) or
        (if (t.connectedDevice) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0)

    /** Starts or stops each collector to match `t`. False when it had to stop the service. */
    private fun apply(t: CollectorTypes): Boolean {
        types = t; running = t.location
        if (t.location && !listening) try {
            // Native Android API; no WebView timers, Google account or Play Services dependency.
            for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                // No distance filter: LocationPolicy.shouldEmit decides, and needs fixes while still for the heartbeat.
                if (manager.allProviders.contains(provider)) manager.requestLocationUpdates(provider, 10_000L, 0f, this, Looper.getMainLooper())
            }
            listening = true
        } catch (_: SecurityException) { graph.local.message = "Location permission changed."; stopSelf(); return false }
        if (!t.location && listening) { manager.removeUpdates(this); listening = false }
        // Bluetooth off keeps the connected-device type (its permission is unchanged): only the connection waits (#672).
        val address = graph.local.heartRateSensor
        val wanted = t.connectedDevice && address != null
        val on = Bluetooth.on(this)
        fun link() = HeartRateLink.next(wanted, on, gatt?.opened == true, gatt?.address == address)
        if (link() == HeartRateLink.CLOSE) { gatt?.close(); gatt = null; heartRateConnected = false }
        if (link() == HeartRateLink.CONNECT && address != null) {
            gatt?.close() // a wrapper that never opened
            gatt = HeartRateGatt(this, address, ::onHeartRate, ::onSensor).also { it.connect() }
        }
        return true
    }

    private fun onSensor(connected: Boolean) {
        val was = heartRateConnected
        heartRateConnected = connected
        if (connected && !was) runCatching { graph.local.record(ShareEvent.Kind.HEART_RATE, detail = "connected") }
        // Lost while still wanted (out of range, strap off); autoConnect brings it back.
        if (!connected && was && types.connectedDevice) runCatching { graph.local.record(ShareEvent.Kind.HEART_RATE, detail = "lost") }
    }

    private fun onHeartRate(data: ByteArray) {
        val now = System.currentTimeMillis()
        val reading = HeartRateMeasurement.parse(data) ?: return
        synchronized(heartRatePolicy) { if (!heartRatePolicy.accept(reading.contact, now)) return }
        lastBpm = reading.bpm; lastReadingAt = now
        scope.launch {
            try {
                graph.local.enqueueHeartRate(HeartRateSample(UUID.randomUUID().toString(), now, reading.bpm, graph.repository.heartRateRecipients()))
            } catch (e: Exception) {
                // Stops visibly: collectingHeartRate() is false at the cap, so the next check drops the type.
                graph.local.message = if (e is HeartRateQueueFull) e.message!! else "Could not save heart rate on this phone."
            }
        }
    }
    override fun onLocationChanged(location: Location) {
        if (!allowed(this) || location.time <= lastFixAt) return
        val point = TrackPoint(UUID.randomUUID().toString(), location.time, location.latitude, location.longitude, location.accuracy,
            LocationPolicy.recipients(graph.local.apps(), graph.local.blocked(), graph.local.sessionIds(), location.time))
        if (!LocationPolicy.valid(point, System.currentTimeMillis())) return
        lastFixAt = point.at
        lastFix = LiveFix(point.at, point.lat, point.lng)
        val speed = location.takeIf { it.hasSpeed() && it.hasSpeedAccuracy() }?.speed
        if (!LocationPolicy.shouldEmit(lastEmitted, point, speed)) return
        val moved = SharingSessions.moved(lastEmitted, point, speed)
        lastEmitted = point
        scope.launch {
            try {
                // ADR-020: an emitted point that moved restarts the sessions' stationary clock.
                if (moved) graph.local.moved(System.currentTimeMillis())
                // Re-evaluate consent and sessions after crossing onto the storage dispatcher.
                val current = graph.repository.recipients().toSet()
                val retained = point.copy(grants = point.grants.filter { it in current })
                if (retained.grants.isNotEmpty()) graph.local.enqueue(retained)
            } catch (_: Exception) {
                graph.local.stop("storage_failed"); graph.local.message = "Could not save location on this phone. Sharing stopped."; stopSelf()
            }
        }
    }
    override fun onProviderDisabled(provider: String) { graph.local.message = "Location is switched off. Waiting for a GPS signal." }
    override fun onDestroy() {
        unregisterReceiver(bluetoothState)
        manager.removeUpdates(this); gatt?.close(); gatt = null; scope.cancel(); running = false; active = false; heartRateConnected = false
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
    private fun notification(t: CollectorTypes): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, LocationService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val sessions = graph.local.sessions()
        val names = sessions.map { s -> graph.local.apps().find { it.id == s.appId }?.name ?: s.appId }
        val now = System.currentTimeMillis()
        val text = SharingSessions.summary(names, sessions.minOfOrNull { it.startedAt } ?: now, now)
        val waiting = t.location && (lastFixAt == 0L || now - lastFixAt > 30_000)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_location).setContentTitle(CollectorTypes.notificationTitle(t))
            .setContentText(if (waiting) "Waiting for GPS · $text" else text)
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).addAction(0, "Stop", stop).build()
    }
    companion object {
        private const val CHANNEL = "pas-location"
        /** ADR-020 §4: automatic ends, at default importance so the user sees them. */
        private const val ENDED_CHANNEL = "pas-sharing-ended"
        private const val ENDED_ID = 2
        /** The notification's single action: ends every session (detail `notification`). */
        private const val STOP = "online.proappstore.STOP"
        /** Location is being recorded. */
        @Volatile var running = false
            private set
        /** The service is in the foreground. False after the OS killed it, so opening the companion resumes sessions (ADR-020 §7). */
        @Volatile var active = false
            private set
        /** Run's strap (#634): connected, and its last accepted reading. In memory only. */
        @Volatile var heartRateConnected = false
            private set
        @Volatile var lastBpm: Int? = null
            private set
        @Volatile var lastReadingAt = 0L
            private set
        /** Time and place of the last accepted fix, in memory only: the map's live dot. Never a second location source. */
        @Volatile var lastFix: LiveFix? = null
            private set
        /**
         * Precise location. A session always starts with the app visible, so its foreground service keeps while-in-use access
         * with the phone locked: no background location permission (ADR-020 §8).
         */
        fun allowed(context: Context): Boolean = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        /** The location access ProAppStore holds: `denied`, `approximate` or `whenInUse` (precise, the satisfied state). */
        fun permissionState(context: Context): String {
            fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
            return when {
                granted(Manifest.permission.ACCESS_FINE_LOCATION) -> "whenInUse"
                granted(Manifest.permission.ACCESS_COARSE_LOCATION) -> "approximate"
                else -> "denied"
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
        /** Whether the service has anything to run: location with its permission, or heart rate with Bluetooth's. */
        fun wanted(context: Context, repository: CompanionRepository): Boolean =
            (allowed(context) && repository.collecting()) || (Bluetooth.permitted(context) && repository.collectingHeartRate())
    }
}

/** The collector's last accepted fix. */
data class LiveFix(val at: Long, val lat: Double, val lng: Double)
