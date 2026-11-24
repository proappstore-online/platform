package online.proappstore.companion

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** #660: the diagnostics snapshot's whitelist and size, the heart-rate code, and the send and delete flow. */
class DiagnosticsTest {
    private val now = 1_800_000_000_000L
    private val device = DiagnosticsDevice("Android 16 (API 36)", "whenInUse", true, "on", "allowed",
        batteryOptimized = true, powerSave = false, locationServices = true, collecting = true, heartRateConnected = true)
    private val hr = NativeEntry("run", "Run", HeartRate.CAPABILITY, "Heart rate", "p", "d", "v1", "g-hr")

    private fun input(activity: List<ActivityRow> = emptyList(), sessionEnds: List<ActivityRow> = emptyList(), lastSyncError: String = "") = DiagnosticsInput(
        now, "1.4.0", "57", device, listOf(hr), setOf("ski", "run/heart_rate.ble"), false,
        listOf(Session("run", now - 600_000, now - 60_000)), heartRateSensor = true, queue = 12, heartRateQueue = 340,
        lastSync = now - 15_000, lastSyncAttempt = now - 15_000, lastSyncError = lastSyncError,
        heartRateLastUpload = 0, heartRateSyncError = "", sessionEnds = sessionEnds, activity = activity)

    private fun keys(value: Any?, out: MutableSet<String> = mutableSetOf()): Set<String> {
        when (value) {
            is JSONObject -> value.keys().forEach { key -> out.add(key); keys(value.get(key), out) }
            is JSONArray -> for (i in 0 until value.length()) keys(value.get(i), out)
        }
        return out
    }

    @Test fun snapshotHasNoSamplesOrCoordinates() {
        val events = listOf(ActivityRow(now - 1_000, "run", "sync_failed", "0 Unable to resolve host"),
            ActivityRow(now - 2_000, "run", "session_ended", "stationary"))
        val json = Diagnostics.build(input(events, events.drop(1)))
        val names = keys(json)
        listOf("lat", "lng", "bpm", "points", "samples").forEach { assertFalse(it, it in names) }
        assertFalse(Regex("-?\\d{1,3}\\.\\d{4,}").containsMatchIn(json.toString()))
        assertEquals(1, json.getInt("v"))
        assertEquals("android", json.getJSONObject("app").getString("platform"))
        assertEquals("allowed", json.getJSONObject("permissions").getString("bluetooth"))
        assertEquals("collecting", json.getJSONObject("sensors").getString("location"))
        assertEquals(JSONObject.NULL, json.getJSONObject("sync").getJSONObject("heartRate").get("lastUploadAt"))
        assertEquals(listOf("run/heart_rate.ble", "ski"), json.getJSONObject("collection").getJSONArray("pendingRevocations").let { a -> (0 until a.length()).map { a.getString(it) } })
    }

    @Test fun twoHundredMaximalEventsStayUnderTheCapAndKeepTheNewest() {
        val appId = "a" + "b".repeat(57)
        val ascii = Diagnostics.build(input((0 until 200).map { ActivityRow(now - it * 1_000L, appId, "k".repeat(32), "\"".repeat(120)) }))
        assertTrue(ascii.toString().toByteArray(Charsets.UTF_8).size <= Diagnostics.MAX_BYTES)
        assertEquals(now, ascii.getJSONArray("activity").getJSONObject(0).getLong("at"))
        // Two-byte characters push 200 events past the cap.
        val events = (0 until 200).map { ActivityRow(now - it * 1_000L, appId, "k".repeat(32), "é".repeat(120)) }
        val json = Diagnostics.build(input(events, lastSyncError = "x".repeat(500)))
        assertTrue(json.toString().toByteArray(Charsets.UTF_8).size <= Diagnostics.MAX_BYTES)
        val activity = json.getJSONArray("activity")
        assertTrue("some events fit", activity.length() > 0)
        assertTrue("the cap dropped some", activity.length() < 200)
        (0 until activity.length()).forEach { assertEquals(now - it * 1_000L, activity.getJSONObject(it).getLong("at")) }
        assertEquals(120, json.getJSONObject("sync").getString("lastError").length)
    }

    @Test fun eventsOlderThanSevenDaysAreLeftOut() {
        val json = Diagnostics.build(input(listOf(ActivityRow(now - 1, null, "quota", "429"), ActivityRow(now - Diagnostics.WINDOW_MS - 1, null, "quota", "429"))))
        assertEquals(1, json.getJSONArray("activity").length())
    }

    @Test fun lastEndedPicksTheLatestPerApp() {
        val rows = listOf(
            ActivityRow(100, "run", "session_ended", "user"), ActivityRow(300, "run", "session_ended", "stationary"),
            ActivityRow(200, "run", "session_ended", "max"), ActivityRow(150, "ski", "session_ended", "grant"),
            ActivityRow(400, "ski", "session_ended", "Not A Code"))
        assertEquals(listOf(ActivityRow(300, "run", "session_ended", "stationary"), ActivityRow(150, "ski", "session_ended", "grant")), Diagnostics.lastEnded(rows))
    }

    @Test fun heartRateStateTable() {
        fun state(entries: List<NativeEntry> = listOf(hr), blocked: Set<String> = emptySet(), expired: Boolean = false, sessions: Set<String> = setOf("run"),
                  sensor: Boolean = true, bluetooth: String = "on", queued: Int = 0, connected: Boolean = true) =
            Diagnostics.heartRateState(entries, blocked, expired, sessions, sensor, bluetooth, queued, connected)
        assertEquals("off", state(entries = emptyList()))
        assertEquals("off", state(entries = listOf(hr.copy(grantId = null))))
        assertEquals("off", state(blocked = setOf(hr.key)))
        assertEquals("off", state(expired = true))
        assertEquals("no_session", state(sessions = emptySet()))
        assertEquals("no_sensor", state(sensor = false))
        assertEquals("bluetooth_denied", state(bluetooth = "unauthorized"))
        assertEquals("bluetooth_off", state(bluetooth = "off"))
        assertEquals("queue_full", state(queued = HeartRatePolicy.MAX_QUEUE))
        assertEquals("not_connected", state(connected = false))
        assertEquals("connected", state())
    }

    @Test fun bluetoothPermissionVocabulary() {
        fun bt(raw: String, sensor: Boolean) = Diagnostics.build(input().copy(device = device.copy(bluetooth = raw), heartRateSensor = sensor))
            .getJSONObject("permissions").getString("bluetooth")
        assertEquals("off", bt("off", true))
        assertEquals("denied", bt("unauthorized", true))
        assertEquals("notDetermined", bt("unauthorized", false))
    }

    @Test fun fingerprintIgnoresQueueAndSyncTimes() {
        val a = Diagnostics.build(input())
        val b = Diagnostics.build(input().copy(now = now + 5, queue = 99, lastSync = now, lastSyncAttempt = now, heartRateLastUpload = now))
        assertEquals(Diagnostics.fingerprint(a), Diagnostics.fingerprint(b))
        assertNotEquals(Diagnostics.fingerprint(a), Diagnostics.fingerprint(Diagnostics.build(input(lastSyncError = "429"))))
    }

    /** The repository's persisted state, plus the sync error fields the flow must never touch. */
    private class Store(override var diagnosticsEnabled: Boolean = true) : DiagnosticsStore {
        override var diagnosticsSentAt = 0L
        override var diagnosticsFingerprint = ""
        override var diagnosticsDeletePending = false
        var lastSnapshot = ""
        var lastSyncError = ""
        var message = ""
        override fun diagnosticsSent(at: Long, fingerprint: String, snapshot: String) { diagnosticsSentAt = at; diagnosticsFingerprint = fingerprint; lastSnapshot = snapshot }
        fun turnOff() { diagnosticsEnabled = false; diagnosticsDeletePending = true }
    }
    private class Server(var fail: Exception? = null) {
        val calls = mutableListOf<String>()
        val request: (String, String, JSONObject?) -> Unit = { method, path, body ->
            calls += "$method $path"
            if (method == "PUT") assertTrue(body!!.has("snapshot"))
            fail?.let { throw it }
        }
    }

    @Test fun sendsOnceThenThrottles() {
        val store = Store(); val server = Server()
        var error = ""
        val build = { Diagnostics.build(input(lastSyncError = error)) }
        Diagnostics.sendIfDue(store, now, build, server.request)
        assertEquals(listOf("PUT /native/diagnostics"), server.calls)
        assertEquals(build().toString().let { JSONObject(it).getJSONObject("app").toString() }, JSONObject(store.lastSnapshot).getJSONObject("app").toString())
        Diagnostics.sendIfDue(store, now + 30_000, build, server.request)
        Diagnostics.sendIfDue(store, now + 90_000, build, server.request)
        assertEquals("no change, no send", 1, server.calls.size)
        error = "429"
        Diagnostics.sendIfDue(store, now + 30_000, build, server.request)
        assertEquals("a change waits 60 s", 1, server.calls.size)
        Diagnostics.sendIfDue(store, now + 61_000, build, server.request)
        assertEquals(2, server.calls.size)
        Diagnostics.sendIfDue(store, now + 61_000 + Diagnostics.REFRESH_MS, build, server.request)
        assertEquals("15 minutes regardless", 3, server.calls.size)
    }

    @Test fun offSendsNothing() {
        val store = Store(diagnosticsEnabled = false); val server = Server()
        Diagnostics.sendIfDue(store, now, { Diagnostics.build(input()) }, server.request)
        assertTrue(server.calls.isEmpty())
    }

    @Test fun turningOffDeletesFirstAndKeepsTheFlagUntilA2xx() {
        val store = Store(); store.turnOff()
        val server = Server(fail = IOException("offline"))
        Diagnostics.deleteIfPending(store, server.request)
        assertEquals(listOf("DELETE /native/diagnostics"), server.calls)
        assertTrue("network error keeps the flag", store.diagnosticsDeletePending)
        server.fail = null
        Diagnostics.deleteIfPending(store, server.request)
        assertFalse(store.diagnosticsDeletePending)
        Diagnostics.deleteIfPending(store, server.request)
        assertEquals("nothing pending, nothing sent", 2, server.calls.size)
    }

    @Test fun aServerErrorThrowsNothingAndTouchesNoSyncState() {
        val store = Store(); val server = Server(fail = ApiFailure(500, "boom"))
        Diagnostics.sendIfDue(store, now, { Diagnostics.build(input()) }, server.request)
        assertEquals(1, server.calls.size)
        assertEquals(0L, store.diagnosticsSentAt)
        assertEquals("", store.lastSnapshot)
        assertEquals("", store.lastSyncError); assertEquals("", store.message)
        // Not recorded as sent, so the next sync tries again.
        server.fail = null
        Diagnostics.sendIfDue(store, now + 1, { Diagnostics.build(input()) }, server.request)
        assertEquals(2, server.calls.size)
    }

    @Test fun aBuildFailureSendsNothing() {
        val store = Store(); val server = Server()
        Diagnostics.sendIfDue(store, now, { throw IllegalStateException("storage") }, server.request)
        assertTrue(server.calls.isEmpty())
    }

    @Test fun aRevokedCredentialStillTakesTheExpiryPath() {
        val store = Store(); store.turnOff()
        val server = Server(fail = ApiFailure(401, "expired"))
        assertThrows(ApiFailure::class.java) { Diagnostics.deleteIfPending(store, server.request) }
        assertThrows(ApiFailure::class.java) { Diagnostics.sendIfDue(Store(), now, { Diagnostics.build(input()) }, server.request) }
    }
}
