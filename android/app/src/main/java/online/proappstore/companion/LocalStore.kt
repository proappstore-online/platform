package online.proappstore.companion

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * Private queue and settings. Version 2 adds the on-device sharing history (#621, ported from iOS LocalStore.swift):
 * `share_events` (when sharing was enabled, started, stopped or turned off, and the activity log's problems) and `share_points`
 * (a 30-day copy of what was shared with each app). Both are in the same backup-excluded database as the queue and
 * never leave the phone. Version 3 adds Run's strap heart rate (#634): its queue `hr` and its 30-day history `share_hr`.
 */
class LocalStore(context: Context) : SQLiteOpenHelper(context, "pas-native.db", null, 3), DiagnosticsStore {
    private val prefs = context.getSharedPreferences("native-settings", Context.MODE_PRIVATE).also(SharingSessions::migrate)
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE points(id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execSQL("CREATE INDEX points_at ON points(at)")
        createHistory(db)
        createHeartRate(db)
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) { if (old < 2) createHistory(db); if (old < 3) createHeartRate(db) }
    private fun createHeartRate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS hr(id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execSQL("CREATE INDEX IF NOT EXISTS hr_at ON hr(at)")
        db.execSQL("CREATE TABLE IF NOT EXISTS share_hr(app_id TEXT NOT NULL, sample_id TEXT NOT NULL, at INTEGER NOT NULL, bpm INTEGER NOT NULL, sent_at INTEGER, PRIMARY KEY(app_id, sample_id))")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_hr_app_at ON share_hr(app_id, at)")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_hr_sample ON share_hr(sample_id)")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_hr_at ON share_hr(at)")
    }
    private fun createHistory(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS share_events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, app_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_events_app_at ON share_events(app_id, at)")
        db.execSQL("CREATE TABLE IF NOT EXISTS share_points(app_id TEXT NOT NULL, point_id TEXT NOT NULL, at INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL NOT NULL, sent_at INTEGER, PRIMARY KEY(app_id, point_id))")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_points_app_at ON share_points(app_id, at)")
    }

    // Collection sessions (ADR-020), replacing Pause all and per-app pause (#626). Local to the phone, never reported.

    /** The running sessions, at most one per app. */
    @Synchronized fun sessions(): List<Session> = SharingSessions.decode(prefs.getString("sessions", null))
    @Synchronized fun sessionIds(): Set<String> = sessions().mapTo(mutableSetOf()) { it.appId }
    private fun saveSessions(sessions: List<Session>) { check(prefs.edit().putString("sessions", SharingSessions.encode(sessions)).commit()) }
    /** Only from a tap in the companion (ADR-020 §2). A running session is left as it is. */
    @Synchronized fun startSession(appId: String, now: Long = System.currentTimeMillis()) {
        if (appId in sessionIds()) return
        transaction { record(ShareEvent.Kind.SESSION_STARTED, appId, at = now); saveSessions(sessions() + Session(appId, now, now)) }
    }
    /** Ends `appId`'s session, recorded as `session_ended` with `detail`. Never touches its grant, consent or queue. */
    @Synchronized fun endSession(appId: String, detail: String, now: Long = System.currentTimeMillis()) {
        val sessions = sessions()
        if (sessions.none { it.appId == appId }) return
        transaction { record(ShareEvent.Kind.SESSION_ENDED, appId, detail, now); saveSessions(sessions.filter { it.appId != appId }) }
    }
    @Synchronized fun endAllSessions(detail: String, now: Long = System.currentTimeMillis()) { sessionIds().forEach { endSession(it, detail, now) } }
    /** Movement at `now` restarts every session's stationary clock. Written at most once a minute: the clock's unit is 30 minutes. */
    @Synchronized fun moved(now: Long) {
        val sessions = sessions()
        if (sessions.none { now - it.lastMovedAt >= 60_000 }) return
        saveSessions(sessions.map { it.copy(lastMovedAt = maxOf(it.lastMovedAt, now)) })
    }
    /**
     * Opening the companion after the OS stopped the collector (ADR-020 §7): sessions past [LocationPolicy.MAX_SESSION_MS] end,
     * the rest resume with their stationary clock restarted.
     */
    @Synchronized fun resumeSessions(now: Long = System.currentTimeMillis()) {
        sessions().filter { SharingSessions.endReason(it.copy(lastMovedAt = now), now) == EndReason.MAX_LENGTH }.forEach { endSession(it.appId, EndReason.MAX_LENGTH.detail, now) }
        val left = sessions()
        if (left.isNotEmpty()) saveSessions(left.map { it.copy(lastMovedAt = now) })
    }
    /** A forced stop, recorded as `stopped` with `reason` (unlock_failed, storage_failed): every session ends. */
    @Synchronized fun stop(reason: String) {
        if (sessions().isEmpty()) return
        transaction { record(ShareEvent.Kind.STOPPED, detail = reason); saveSessions(emptyList()) }
    }
    var lastSync: Long
        get() = prefs.getLong("lastSync", 0)
        set(value) { prefs.edit().putLong("lastSync", value).apply() }
    /** When the last sync was tried, and its failure text (`""` after a success). `message` stays as it is. */
    var lastSyncAttempt: Long
        get() = prefs.getLong("lastSyncAttempt", 0)
        set(value) { prefs.edit().putLong("lastSyncAttempt", value).apply() }
    var lastSyncError: String
        get() = prefs.getString("lastSyncError", "") ?: ""
        set(value) { prefs.edit().putString("lastSyncError", value).apply() }
    var message: String
        get() = prefs.getString("message", "") ?: ""
        set(value) { prefs.edit().putString("message", value).apply() }
    var userName: String
        get() = prefs.getString("userName", "") ?: ""
        set(value) { prefs.edit().putString("userName", value).apply() }
    /** The last seen location permission, so only a change is logged. Empty until first seen. */
    var permissionState: String
        get() = prefs.getString("permission", "") ?: ""
        set(value) { prefs.edit().putString("permission", value).apply() }
    /** `device.expiresAt` from `GET /native/me`, 0 until known. */
    var deviceExpiresAt: Long
        get() = prefs.getLong("deviceExpiresAt", 0)
        set(value) { prefs.edit().putLong("deviceExpiresAt", value).apply() }
    /**
     * The account whose device connection expired or was revoked (#652), null while connected. Survives relaunch;
     * only pairing or [clear] resets it.
     */
    val expiredUser: String? get() = prefs.getString("expiredUser", null)
    val expired: Boolean get() = expiredUser != null
    /** Records `expired` once and remembers `userId`, so pairing that account again keeps the history. Every session ends. */
    @Synchronized fun markExpired(userId: String, detail: String = "") {
        endAllSessions("grant")
        if (!expired) record(ShareEvent.Kind.EXPIRED, detail = detail)
        check(prefs.edit().putString("expiredUser", userId).commit())
    }
    /** Disabled on this phone, keyed by [NativeEntry.key]: a bare app id is location, `app/capability` another one. */
    @Synchronized fun blocked(): Set<String> = prefs.getStringSet("blocked", emptySet())!!.toSet()
    /**
     * `key` is a [NativeEntry.key]. Disabling one capability never touches another's grant or queue. The app's session ends
     * only when it has no enabled capability left (#668, the twin of iOS #677): turning off Run's location leaves a running
     * session's heart rate alone, and never starts or resumes heart rate for a stopped Run.
     */
    @Synchronized fun block(key: String) {
        blockCapability(key)
        val appId = key.substringBefore('/')
        if (!SharingSessions.keepsSession(appId, apps(), entries(), blocked())) endSession(appId, "grant")
    }
    private fun blockCapability(key: String) {
        if ('/' in key) return blockEntry(key)
        val appId = key
        val wasBlocked = appId in blocked()
        check(prefs.edit().putStringSet("blocked", blocked() + appId).commit())
        val revoked = apps().find { it.id == appId }?.grantId
        transaction { db ->
            if (!wasBlocked) record(ShareEvent.Kind.DISABLED, appId)
            // Never shared, and now never will be.
            db.delete("share_points", "app_id = ? AND sent_at IS NULL", arrayOf(appId))
            // Discard only this recipient. Other enabled apps retain their own queued copy.
            if (revoked != null) for (p in pending(LocationPolicy.MAX_QUEUE)) {
                if (revoked !in p.grants) continue
                val keep = p.copy(grants = p.grants.filter { it != revoked })
                if (keep.grants.isEmpty()) db.delete("points", "id = ?", arrayOf(p.id))
                else db.update("points", ContentValues().apply { put("payload", keep.json().toString()) }, "id = ?", arrayOf(p.id))
            }
        }
    }
    /** A non-location capability: drops its grant from the heart-rate queue. The sharing timeline records nothing here. */
    private fun blockEntry(key: String) {
        val entry = entries().find { it.key == key }
        val wasBlocked = key in blocked()
        check(prefs.edit().putStringSet("blocked", blocked() + key).commit())
        transaction { db ->
            if (entry == null) return@transaction
            if (!wasBlocked) record(ShareEvent.Kind.HEART_RATE, entry.appId, "disabled")
            db.delete("share_hr", "app_id = ? AND sent_at IS NULL", arrayOf(entry.appId))
            val revoked = entry.grantId ?: return@transaction
            for (s in pendingHeartRate(HeartRatePolicy.MAX_QUEUE)) {
                if (revoked !in s.grants) continue
                val keep = s.copy(grants = s.grants.filter { it != revoked })
                if (keep.grants.isEmpty()) db.delete("hr", "id = ?", arrayOf(s.id))
                else db.update("hr", ContentValues().apply { put("payload", keep.json().toString()) }, "id = ?", arrayOf(s.id))
            }
        }
    }
    @Synchronized fun unblock(key: String) { check(prefs.edit().putStringSet("blocked", blocked() - key).commit()) }
    @Synchronized fun apps(): List<ConnectedApp> = parseApps(JSONArray(prefs.getString("apps", "[]")))
    /**
     * The `apps` array of `GET /native/me`, stored as received. A held grant that the server dropped or replaced
     * (publisher change, disclosure revision, app-account deletion) is recorded as `grant_lost`, and ends its session.
     */
    @Synchronized fun saveApps(apps: JSONArray) {
        val incoming = parseApps(apps)
        val previous = apps()
        val blocked = blocked()
        transaction {
            for (old in previous) {
                if (old.grantId == null || old.id in blocked) continue
                val grant = incoming.find { it.id == old.id }?.grantId
                if (grant == old.grantId) continue
                record(ShareEvent.Kind.GRANT_LOST, old.id, if (grant == null) "revoked" else "replaced")
                endSession(old.id, "grant")
            }
            // A grant back after `grant_lost`, for example after re-consent on another path.
            for (new in incoming) {
                if (new.grantId == null || new.id in blocked || previous.find { it.id == new.id }?.grantId != null) continue
                val last = readableDatabase.rawQuery(
                    "SELECT kind FROM share_events WHERE app_id = ? AND kind IN ('enabled', 'disabled', 'grant_lost', 'grant_restored') ORDER BY at DESC, id DESC LIMIT 1",
                    arrayOf(new.id)).use { if (it.moveToFirst()) it.getString(0) else null }
                if (last == ShareEvent.Kind.GRANT_LOST.raw) record(ShareEvent.Kind.GRANT_RESTORED, new.id)
            }
            check(prefs.edit().putString("apps", apps.toString()).commit())
        }
    }
    /** The `capabilities` array of `GET /native/me`, stored as received. */
    @Synchronized fun entries(): List<NativeEntry> = parseEntries(JSONArray(prefs.getString("entries", "[]")))
    @Synchronized fun saveEntries(entries: JSONArray) { check(prefs.edit().putString("entries", entries.toString()).commit()) }
    /** The chosen heart-rate sensor's Bluetooth address. On this phone only; never uploaded. */
    var heartRateSensor: String?
        get() = prefs.getString("hrSensor", null)?.takeIf { it.isNotBlank() }
        set(value) { check(prefs.edit().putString("hrSensor", value ?: "").commit()) }
    /** When the server last acknowledged heart-rate samples, 0 until then. */
    var heartRateLastUpload: Long
        get() = prefs.getLong("hrLastUpload", 0)
        set(value) { prefs.edit().putLong("hrLastUpload", value).apply() }
    /** The last heart-rate upload's failure text, "" after it succeeded: the heart-rate stream's sync health. */
    var heartRateSyncError: String
        get() = prefs.getString("hrSyncError", "") ?: ""
        set(value) { prefs.edit().putString("hrSyncError", value).apply() }
    /** The last seen Bluetooth state (`on`, `off`, `unauthorized`), so only a change is logged. Empty until first seen. */
    var bluetoothState: String
        get() = prefs.getString("bluetooth", "") ?: ""
        set(value) { prefs.edit().putString("bluetooth", value).apply() }

    // Diagnostics (#660): the user's choice survives [clear]; the other four keys do not.

    override val diagnosticsEnabled: Boolean get() = prefs.getBoolean("diagnosticsEnabled", true)
    override val diagnosticsSentAt: Long get() = prefs.getLong("diagnosticsSentAt", 0)
    override val diagnosticsFingerprint: String get() = prefs.getString("diagnosticsFingerprint", "") ?: ""
    override var diagnosticsDeletePending: Boolean
        get() = prefs.getBoolean("diagnosticsDeletePending", false)
        set(value) { check(prefs.edit().putBoolean("diagnosticsDeletePending", value).commit()) }
    /** The exact snapshot JSON last sent, "" until then. */
    val diagnosticsLastSnapshot: String get() = prefs.getString("diagnosticsLastSnapshot", "") ?: ""
    override fun diagnosticsSent(at: Long, fingerprint: String, snapshot: String) {
        check(prefs.edit().putLong("diagnosticsSentAt", at).putString("diagnosticsFingerprint", fingerprint).putString("diagnosticsLastSnapshot", snapshot).commit())
    }
    /** Off: stop, and delete the server copy on the next sync, durably. On: the next sync sends at once. */
    @Synchronized fun setDiagnostics(enabled: Boolean) {
        val edit = prefs.edit().putBoolean("diagnosticsEnabled", enabled).putBoolean("diagnosticsDeletePending", !enabled)
        if (enabled) edit.remove("diagnosticsSentAt")
        check(edit.commit())
    }
    /** The activity log since `since`, newest first, raw kinds included. Never reads points or heart-rate samples. */
    @Synchronized fun activity(since: Long, limit: Int = Diagnostics.MAX_EVENTS): List<ActivityRow> = readableDatabase.rawQuery(
        "SELECT at, app_id, kind, detail FROM share_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?", arrayOf(since.toString(), limit.toString())).use { it.rows() }
    /** Every `session_ended` row; [Diagnostics.lastEnded] keeps each app's latest. */
    @Synchronized fun sessionEnds(): List<ActivityRow> = readableDatabase.rawQuery(
        "SELECT at, app_id, kind, detail FROM share_events WHERE kind = ?", arrayOf(ShareEvent.Kind.SESSION_ENDED.raw)).use { it.rows() }
    private fun Cursor.rows(): List<ActivityRow> = buildList {
        while (moveToNext()) add(ActivityRow(getLong(0), if (isNull(1)) null else getString(1), getString(2), getString(3)))
    }
    /** Every setting except the user's diagnostics choice. */
    private fun clearSettings() { check(prefs.edit().clear().putBoolean("diagnosticsEnabled", diagnosticsEnabled).commit()) }

    // Heart-rate queue (#634)

    /** Re-filters recipients against current consent and sessions before insert. */
    @Synchronized fun enqueueHeartRate(sample: HeartRateSample) {
        val entries = entries()
        val allowed = HeartRatePolicy.recipients(entries, blocked(), sessionIds(), sample.at).toSet()
        val retained = sample.copy(grants = sample.grants.filter { it in allowed })
        if (expired || retained.grants.isEmpty()) return
        if (heartRateCount() >= HeartRatePolicy.MAX_QUEUE) {
            runCatching { record(ShareEvent.Kind.HEART_RATE_PROBLEM, detail = "queue_full") }
            throw HeartRateQueueFull()
        }
        transaction { db ->
            db.insertOrThrow("hr", null, ContentValues().apply { put("id", retained.id); put("at", retained.at); put("payload", retained.json().toString()) })
            for (e in entries) {
                if (e.capability != HeartRate.CAPABILITY || e.grantId == null || e.grantId !in retained.grants) continue
                db.insertWithOnConflict("share_hr", null, ContentValues().apply {
                    put("app_id", e.appId); put("sample_id", retained.id); put("at", retained.at); put("bpm", retained.bpm)
                }, SQLiteDatabase.CONFLICT_IGNORE)
            }
        }
    }
    @Synchronized fun pendingHeartRate(limit: Int = 300): List<HeartRateSample> = readableDatabase.rawQuery("SELECT payload FROM hr ORDER BY at, id LIMIT ?", arrayOf(limit.toString())).use { c ->
        buildList { while (c.moveToNext()) add(sampleFrom(JSONObject(c.getString(0)))) }
    }
    /** Includes samples the server discarded for a revoked recipient. */
    @Synchronized fun acknowledgeHeartRate(ids: List<String>, now: Long = System.currentTimeMillis()) {
        transaction { db ->
            ids.forEach {
                db.delete("hr", "id = ?", arrayOf(it))
                db.execSQL("UPDATE share_hr SET sent_at = ? WHERE sample_id = ? AND sent_at IS NULL", arrayOf<Any>(now, it))
            }
        }
        heartRateLastUpload = now
    }
    @Synchronized fun heartRateCount(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM hr", null).use { it.moveToFirst(); it.getInt(0) }
    /** This app's heart-rate samples in `[from, to]`, oldest first, from the on-device history. */
    @Synchronized fun heartRate(appId: String, from: Long, to: Long): List<HeartRatePoint> = readableDatabase.rawQuery(
        "SELECT at, bpm FROM share_hr WHERE app_id = ? AND at BETWEEN ? AND ? ORDER BY at", arrayOf(appId, from.toString(), to.toString())).use { c ->
        buildList { while (c.moveToNext()) add(HeartRatePoint(c.getLong(0), c.getInt(1))) }
    }
    /** The newest heart-rate sample recorded for this app, or null. */
    @Synchronized fun lastHeartRate(appId: String): HeartRatePoint? = readableDatabase.rawQuery(
        "SELECT at, bpm FROM share_hr WHERE app_id = ? ORDER BY at DESC LIMIT 1", arrayOf(appId)).use { if (it.moveToFirst()) HeartRatePoint(it.getLong(0), it.getInt(1)) else null }

    @Synchronized fun enqueue(point: TrackPoint) {
        val apps = apps()
        val allowed = LocationPolicy.recipients(apps, blocked(), sessionIds(), point.at).toSet()
        val retained = point.copy(grants = point.grants.filter { it in allowed })
        if (expired || retained.grants.isEmpty()) return
        if (count() >= LocationPolicy.MAX_QUEUE) {
            runCatching { record(ShareEvent.Kind.QUEUE_FULL) }
            error("Device storage queue is full. Connect to upload before resuming.")
        }
        transaction { db ->
            db.insertOrThrow("points", null, ContentValues().apply {
                put("id", retained.id); put("at", retained.at); put("payload", retained.json().toString())
            })
            // History is keyed by app id: grant ids change with every new consent.
            for (app in apps) {
                if (app.grantId == null || app.grantId !in retained.grants) continue
                db.insertWithOnConflict("share_points", null, ContentValues().apply {
                    put("app_id", app.id); put("point_id", retained.id); put("at", retained.at)
                    put("lat", retained.lat); put("lng", retained.lng); put("accuracy", retained.accuracy.toDouble())
                }, SQLiteDatabase.CONFLICT_IGNORE)
            }
        }
    }
    @Synchronized fun pending(limit: Int = 100): List<TrackPoint> = readableDatabase.rawQuery("SELECT payload FROM points ORDER BY at, id LIMIT ?", arrayOf(limit.toString())).use { cursor ->
        buildList { while (cursor.moveToNext()) add(pointFrom(JSONObject(cursor.getString(0)))) }
    }
    /** `sent_at` means the server acknowledged it, which includes points it discarded for a revoked recipient. */
    @Synchronized fun acknowledge(ids: List<String>, now: Long = System.currentTimeMillis()) = transaction { db ->
        ids.forEach {
            db.delete("points", "id = ?", arrayOf(it))
            db.execSQL("UPDATE share_points SET sent_at = ? WHERE point_id = ? AND sent_at IS NULL", arrayOf<Any>(now, it))
        }
    }
    @Synchronized fun expire(now: Long) = transaction { db ->
        val cutoff = now - LocationPolicy.HISTORY_MS
        db.delete("points", "at < ?", arrayOf((now - LocationPolicy.RETENTION_MS).toString()))
        db.delete("share_points", "sent_at IS NULL AND at < ?", arrayOf((now - LocationPolicy.RETENTION_MS).toString())) // its queue copy just expired
        db.delete("share_points", "at < ?", arrayOf(cutoff.toString()))
        db.execSQL("DELETE FROM share_points WHERE rowid IN (SELECT rowid FROM share_points ORDER BY at DESC LIMIT -1 OFFSET ?)", arrayOf<Any>(LocationPolicy.HISTORY_MAX_POINTS))
        db.delete("hr", "at < ?", arrayOf((now - LocationPolicy.RETENTION_MS).toString()))
        db.delete("share_hr", "sent_at IS NULL AND at < ?", arrayOf((now - LocationPolicy.RETENTION_MS).toString()))
        db.delete("share_hr", "at < ?", arrayOf(cutoff.toString()))
        db.execSQL("DELETE FROM share_hr WHERE rowid IN (SELECT rowid FROM share_hr ORDER BY at DESC LIMIT -1 OFFSET ?)", arrayOf<Any>(HeartRatePolicy.HISTORY_MAX_SAMPLES))
        // Keep the newest event of each (app, kind) before the cutoff, so state at the window start is known.
        db.execSQL("DELETE FROM share_events WHERE at < ? AND id NOT IN (SELECT MAX(id) FROM share_events WHERE at < ? GROUP BY app_id, kind)", arrayOf<Any>(cutoff, cutoff))
    }
    @Synchronized fun count(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM points", null).use { it.moveToFirst(); it.getInt(0) }
    /** Disconnect, or pairing a different account: everything. */
    @Synchronized fun clear() {
        transaction { db -> listOf("points", "hr", "share_events", "share_points", "share_hr").forEach { db.delete(it, null, null) } }
        clearSettings()
    }
    /**
     * Pairing the same account after an expiry (#652): the queue and the settings, which hold the old device's grants,
     * go; the sharing history and activity log stay. Queued points carry grants the new device will never hold.
     */
    @Synchronized fun clearForReconnect() {
        transaction { db ->
            db.delete("points", null, null); db.delete("hr", null, null)
            db.delete("share_points", "sent_at IS NULL", null) // never shared, and now never will be
            db.delete("share_hr", "sent_at IS NULL", null)
        }
        clearSettings()
    }

    // Sharing history (#621) and activity log (#624)

    /** `detail` is cut to 120 characters: a short code or the server's `error` text, never a body or coordinates. */
    @Synchronized fun record(kind: ShareEvent.Kind, appId: String? = null, detail: String = "", at: Long = System.currentTimeMillis()) {
        writableDatabase.insertOrThrow("share_events", null, ContentValues().apply {
            put("at", at); put("app_id", appId); put("kind", kind.raw); put("detail", detail.take(120))
        })
    }
    /** Records `sync_failed` once per run of identical failures (an offline walk retries often). Returns whether it was recorded. */
    @Synchronized fun syncFailed(detail: String): Boolean {
        val failures = prefs.getInt("syncFailures", 0)
        val new = failures == 0 || prefs.getString("lastSyncFailure", "") != detail.take(120)
        if (new) record(ShareEvent.Kind.SYNC_FAILED, detail = detail)
        check(prefs.edit().putInt("syncFailures", failures + 1).putString("lastSyncFailure", detail.take(120)).commit())
        return new
    }
    /** Ends a failure run with `sync_recovered`. */
    @Synchronized fun syncSucceeded() {
        val failures = prefs.getInt("syncFailures", 0)
        if (failures == 0) return
        record(ShareEvent.Kind.SYNC_RECOVERED, detail = "after $failures attempt${if (failures == 1) "" else "s"}")
        check(prefs.edit().putInt("syncFailures", 0).putString("lastSyncFailure", "").commit())
    }
    /** Oldest first. Kinds this build does not know are skipped. */
    @Synchronized fun events(): List<ShareEvent> = readableDatabase.rawQuery("SELECT id, at, app_id, kind, detail FROM share_events ORDER BY at, id", null).use { c ->
        buildList {
            while (c.moveToNext()) {
                val kind = ShareEvent.Kind.of(c.getString(3)) ?: continue
                add(ShareEvent(c.getLong(0), c.getLong(1), if (c.isNull(2)) null else c.getString(2), kind, c.getString(4)))
            }
        }
    }
    /** When the server last acknowledged a point for this app, or null. */
    @Synchronized fun lastUpload(appId: String): Long? = readableDatabase.rawQuery("SELECT MAX(sent_at) FROM share_points WHERE app_id = ?", arrayOf(appId))
        .use { if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null }
    /** This app's points still waiting to upload. */
    @Synchronized fun pendingCount(appId: String): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM share_points WHERE app_id = ? AND sent_at IS NULL", arrayOf(appId))
        .use { it.moveToFirst(); it.getInt(0) }
    /** This app's shared points in `[from, to]`, oldest first. */
    @Synchronized fun track(appId: String, from: Long, to: Long): List<TrackSample> = readableDatabase.rawQuery(
        "SELECT at, lat, lng, accuracy, sent_at FROM share_points WHERE app_id = ? AND at BETWEEN ? AND ? ORDER BY at", arrayOf(appId, from.toString(), to.toString())).use { c ->
        buildList { while (c.moveToNext()) add(TrackSample(c.getLong(0), c.getDouble(1), c.getDouble(2), c.getDouble(3), if (c.isNull(4)) null else c.getLong(4))) }
    }
    /**
     * Deletes the history, keeps the queue (pending uploads still go), and re-seeds the current state at `now`.
     * `history_cleared` comes first: it ends open sessions, and the seeded `enabled` rows then start new ones.
     */
    @Synchronized fun clearHistory(now: Long = System.currentTimeMillis()) = transaction { db ->
        db.delete("share_events", null, null); db.delete("share_points", null, null); db.delete("share_hr", null, null)
        record(ShareEvent.Kind.HISTORY_CLEARED, at = now)
        seed(now, consentTime = false, detail = "")
    }
    /** Upgrade path: a phone with grants but no history gets sessions that start at each grant's consent time. */
    @Synchronized fun seedIfEmpty(now: Long = System.currentTimeMillis()) {
        val empty = readableDatabase.rawQuery("SELECT COUNT(*) FROM share_events", null).use { it.moveToFirst(); it.getLong(0) == 0L }
        if (empty) transaction { seed(now, consentTime = true, detail = "seeded") }
    }
    private fun seed(now: Long, consentTime: Boolean, detail: String) {
        if (expired) return // the expired device's grants share nothing
        val blocked = blocked(); val sessions = sessionIds()
        val granted = apps().filter { it.grantId != null && it.id !in blocked }
        granted.forEach { record(ShareEvent.Kind.ENABLED, it.id, detail, if (consentTime) minOf(it.consentAt, now) else now) }
        granted.filter { it.id in sessions }.forEach { record(ShareEvent.Kind.SESSION_STARTED, it.id, detail, now) }
    }
    private fun <T> transaction(body: (SQLiteDatabase) -> T): T {
        val db = writableDatabase
        db.beginTransaction()
        try { return body(db).also { db.setTransactionSuccessful() } } finally { db.endTransaction() }
    }
}

private fun parseApps(array: JSONArray): List<ConnectedApp> = (0 until array.length()).map { i ->
    val a = array.getJSONObject(i); val g = a.optJSONObject("grant")
    ConnectedApp(a.getString("id"), a.getString("name"), a.getString("purpose"), a.getString("disclosure"), a.getString("version"), g?.getString("id"), g?.getLong("consent_at") ?: 0)
}
internal fun TrackPoint.json() = JSONObject().put("id", id).put("at", at).put("lat", lat).put("lng", lng).put("accuracy", accuracy.toDouble()).put("grants", JSONArray(grants))
private fun pointFrom(p: JSONObject): TrackPoint {
    val grants = p.getJSONArray("grants")
    return TrackPoint(p.getString("id"), p.getLong("at"), p.getDouble("lat"), p.getDouble("lng"), p.getDouble("accuracy").toFloat(), (0 until grants.length()).map { grants.getString(it) })
}
private fun parseEntries(array: JSONArray): List<NativeEntry> = (0 until array.length()).map { i ->
    val e = array.getJSONObject(i); val g = e.optJSONObject("grant")
    NativeEntry(e.getString("appId"), e.getString("appName"), e.getString("capability"), e.getString("name"), e.getString("purpose"),
        e.getString("disclosure"), e.getString("version"), g?.getString("id"), g?.getLong("consent_at") ?: 0)
}
internal fun HeartRateSample.json() = JSONObject().put("id", id).put("at", at).put("bpm", bpm).put("grants", JSONArray(grants))
private fun sampleFrom(p: JSONObject): HeartRateSample {
    val grants = p.getJSONArray("grants")
    return HeartRateSample(p.getString("id"), p.getLong("at"), p.getInt("bpm"), (0 until grants.length()).map { grants.getString(it) })
}
/** [LocalStore.enqueueHeartRate] at [HeartRatePolicy.MAX_QUEUE]. */
class HeartRateQueueFull : IllegalStateException("Heart rate stopped: its upload queue is full. Connect to the internet so ProAppStore can send waiting readings.")
