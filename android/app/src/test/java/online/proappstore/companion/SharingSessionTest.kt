package online.proappstore.companion

import android.content.SharedPreferences
import org.junit.Assert.*
import org.junit.Test

/** ADR-020's collection sessions (#668): the end rules, movement, recipients, the pause migration and the twin of iOS #677. */
class SharingSessionTest {
    private val min = 60_000L
    private val hour = 60 * min

    @Test fun stationaryEndsAtThirtyMinutesNotBefore() {
        val s = Session("run", startedAt = 0, lastMovedAt = 10 * min)
        assertNull(SharingSessions.endReason(s, 10 * min + 29 * min + 59_000))
        assertEquals(EndReason.STATIONARY, SharingSessions.endReason(s, 10 * min + 30 * min))
    }

    @Test fun noFixAtAllCountsAsNoMovement() {
        assertEquals(EndReason.STATIONARY, SharingSessions.endReason(Session("run", 0, 0), 30 * min))
    }

    @Test fun maxLengthEndsAtTwelveHoursEvenWhileMoving() {
        assertNull(SharingSessions.endReason(Session("run", 0, 12 * hour - 1), 12 * hour - 1))
        assertEquals(EndReason.MAX_LENGTH, SharingSessions.endReason(Session("run", 0, 12 * hour), 12 * hour))
        assertEquals("max", EndReason.MAX_LENGTH.detail)
        assertEquals("stationary", EndReason.STATIONARY.detail)
    }

    private fun p(at: Long, lat: Double, accuracy: Float = 5f) = TrackPoint("$at", at, lat, 151.0, accuracy, listOf("g"))
    // 0.001 degrees of latitude is about 111 m.
    @Test fun movedIsFalseForTheFirstPointAHeartbeatAndSlowDoppler() {
        assertFalse("first point", SharingSessions.moved(null, p(0, -33.0), null))
        val heartbeat = p(LocationPolicy.HEARTBEAT_MS, -33.0)
        assertTrue("a heartbeat is emitted", LocationPolicy.shouldEmit(p(0, -33.0), heartbeat, null))
        assertFalse("but is not movement", SharingSessions.moved(p(0, -33.0), heartbeat, null))
        assertFalse("Doppler says still", SharingSessions.moved(p(0, -33.0), p(10_000, -33.001), 0.1f))
        assertFalse("jitter inside the accuracy circle", SharingSessions.moved(p(0, -33.0, 150f), p(10_000, -33.001), null))
    }

    @Test fun movedIsTrueForADistanceMove() {
        assertTrue(SharingSessions.moved(p(0, -33.0), p(10_000, -33.001), null))
        assertTrue(SharingSessions.moved(p(0, -33.0), p(10_000, -33.001), 3f))
        assertTrue("a heartbeat that also moved", SharingSessions.moved(p(0, -33.0), p(LocationPolicy.HEARTBEAT_MS, -33.001), null))
    }

    private val run = ConnectedApp("run", "Run", "Runs", "D", "1", "run-g")
    private val ski = ConnectedApp("ski", "Ski", "Routes", "D", "1", "ski-g")
    private val runHr = NativeEntry("run", "Run", HeartRate.CAPABILITY, "Heart rate", "p", "d", "1", "run-hr")
    private val runLoc = NativeEntry("run", "Run", NativeEntry.LOCATION, "Location", "p", "d", "1", "run-g")

    @Test fun recipientsExcludeAppsWithoutASession() {
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(run, ski), emptySet(), emptySet(), 10))
        assertEquals(listOf("ski-g"), LocationPolicy.recipients(listOf(run, ski), emptySet(), setOf("ski"), 10))
        assertEquals("a disabled app with a session still receives nothing", emptyList<String>(), LocationPolicy.recipients(listOf(run, ski), setOf("ski"), setOf("ski"), 10))
        assertEquals("no session, no heart rate", emptyList<String>(), HeartRatePolicy.recipients(listOf(runHr), emptySet(), emptySet(), 10))
        assertEquals(listOf("run-hr"), HeartRatePolicy.recipients(listOf(runHr), emptySet(), setOf("run"), 10))
    }

    /** #668 comment finding 1, the twin of iOS #677: turning off Run's location keeps Run's running session for heart rate. */
    @Test fun blockingLocationLeavesAnHrSessionsRecipientsIntact() {
        val blocked = setOf("run")
        assertTrue(SharingSessions.keepsSession("run", listOf(run), listOf(runLoc, runHr), blocked))
        val sessions = setOf("run")
        assertEquals(listOf("run-hr"), HeartRatePolicy.recipients(listOf(runLoc, runHr), blocked, sessions, 10))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(run), blocked, sessions, 10))
    }

    /** ...and turning it off never starts or resumes heart rate for a stopped Run: recipients need a session, which only Start creates. */
    @Test fun blockingLocationNeverResumesAStoppedAppsHeartRate() {
        assertEquals(emptyList<String>(), HeartRatePolicy.recipients(listOf(runLoc, runHr), setOf("run"), emptySet(), 10))
    }

    /** Ending the session stops both streams. */
    @Test fun endingTheSessionStopsLocationAndHeartRate() {
        assertEquals(listOf("run-g"), LocationPolicy.recipients(listOf(run), emptySet(), setOf("run"), 10))
        assertEquals(listOf("run-hr"), HeartRatePolicy.recipients(listOf(runHr), emptySet(), setOf("run"), 10))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(run), emptySet(), emptySet(), 10))
        assertEquals(emptyList<String>(), HeartRatePolicy.recipients(listOf(runHr), emptySet(), emptySet(), 10))
    }

    @Test fun theSessionEndsOnlyWhenNoCapabilityIsLeft() {
        assertFalse("location-only Ski", SharingSessions.keepsSession("ski", listOf(ski), emptyList(), setOf("ski")))
        assertTrue("heart rate off, location on", SharingSessions.keepsSession("run", listOf(run), listOf(runLoc, runHr), setOf("run/heart_rate.ble")))
        assertFalse("both off", SharingSessions.keepsSession("run", listOf(run), listOf(runLoc, runHr), setOf("run", "run/heart_rate.ble")))
        assertFalse("location off, no heart-rate grant", SharingSessions.keepsSession("run", listOf(run), listOf(runLoc, runHr.copy(grantId = null)), setOf("run")))
        assertFalse("location's grant gone on the server", SharingSessions.keepsSession("ski", listOf(ski.copy(grantId = null)), emptyList(), emptySet()))
    }

    /** In-memory SharedPreferences: enough of the interface for [SharingSessions.migrate]. */
    private class Prefs(val values: MutableMap<String, Any?>) : SharedPreferences {
        override fun contains(key: String) = key in values
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            val removed = mutableSetOf<String>()
            override fun remove(key: String) = apply { removed += key }
            override fun commit(): Boolean { removed.forEach { values.remove(it) }; return true }
            override fun apply() { commit() }
            override fun putString(key: String, value: String?) = this
            override fun putStringSet(key: String, values: MutableSet<String>?) = this
            override fun putInt(key: String, value: Int) = this
            override fun putLong(key: String, value: Long) = this
            override fun putFloat(key: String, value: Float) = this
            override fun putBoolean(key: String, value: Boolean) = this
            override fun clear() = this
        }
        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String, defValue: String?) = values[key] as String? ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?) = defValues
        override fun getInt(key: String, defValue: Int) = defValue
        override fun getLong(key: String, defValue: Long) = defValue
        override fun getFloat(key: String, defValue: Float) = defValue
        override fun getBoolean(key: String, defValue: Boolean) = defValue
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    }

    @Test fun theMigrationDropsPausedAndPausedAppsAndCreatesNoSession() {
        val prefs = Prefs(mutableMapOf("paused" to false, "pausedApps" to setOf("run"), "blocked" to setOf("ski"), "apps" to "[]"))
        SharingSessions.migrate(prefs)
        assertEquals(setOf("blocked", "apps"), prefs.values.keys)
        assertEquals(emptyList<Session>(), SharingSessions.decode(prefs.getString("sessions", null)))
        SharingSessions.migrate(prefs) // idempotent
        assertEquals(setOf("blocked", "apps"), prefs.values.keys)
    }

    @Test fun sessionsRoundTrip() {
        val sessions = listOf(Session("run", 1, 2), Session("ski", 3, 4))
        assertEquals(sessions, SharingSessions.decode(SharingSessions.encode(sessions)))
        assertEquals(emptyList<Session>(), SharingSessions.decode(null))
    }

    @Test fun theNotificationNamesTheAppsAndTheTime() {
        assertEquals("With Run · 42 min", SharingSessions.summary(listOf("Run"), 0, 42 * min))
        assertEquals("With Run, Ski · 1 h 5 min", SharingSessions.summary(listOf("Run", "Ski", "Run"), 0, 65 * min))
        assertEquals("ProAppStore is sharing your location", CollectorTypes.notificationTitle(CollectorTypes(location = true, connectedDevice = false)))
        assertEquals("ProAppStore is sharing your location and heart rate", CollectorTypes.notificationTitle(CollectorTypes(location = true, connectedDevice = true)))
        assertEquals("ProAppStore is sharing your heart rate", CollectorTypes.notificationTitle(CollectorTypes(location = false, connectedDevice = true)))
    }

    /** A link only names an app; anything else is ignored. */
    @Test fun deepLinkParsing() {
        assertEquals("run", SharingSessions.linkedApp("proappstore://native/apps/run"))
        assertEquals("ride-share_2", SharingSessions.linkedApp("proappstore://native/apps/ride-share_2/"))
        listOf(null, "proappstore://native", "proappstore://native/apps/", "proappstore://native/apps/run/start", "https://native/apps/run",
            "proappstore://native/apps/run?start=1", "proappstore://other/apps/run").forEach { assertNull(it, SharingSessions.linkedApp(it)) }
    }

    @Test fun sessionEventsHaveSentencesAndRoundTrip() {
        fun sentence(detail: String) = ActivityText.sentence(ShareEvent(1, 0, "run", ShareEvent.Kind.SESSION_ENDED, detail), "Run")
        assertEquals("Started sharing with Run", ActivityText.sentence(ShareEvent(1, 0, "run", ShareEvent.Kind.SESSION_STARTED, ""), "Run"))
        assertEquals("Stopped sharing with Run", sentence("user"))
        assertEquals("Stopped sharing with Run: no movement for 30 minutes", sentence("stationary"))
        assertEquals("Stopped sharing with Run: 12 hours reached", sentence("max"))
        assertEquals("Stopped sharing with Run from the notification", sentence("notification"))
        assertEquals(ShareEvent.Kind.SESSION_ENDED, ShareEvent.Kind.of("session_ended"))
        assertEquals("old rows still decode", ShareEvent.Kind.PAUSED, ShareEvent.Kind.of("paused"))
    }
}
