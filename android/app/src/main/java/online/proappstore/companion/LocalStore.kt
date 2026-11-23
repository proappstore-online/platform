package online.proappstore.companion

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * Private queue and settings. Version 2 adds the on-device sharing history (#621, ported from iOS LocalStore.swift):
 * `share_events` (when sharing was enabled, paused or turned off, and the activity log's problems) and `share_points`
 * (a 30-day copy of what was shared with each app). Both are in the same backup-excluded database as the queue and
 * never leave the phone.
 */
class LocalStore(context: Context) : SQLiteOpenHelper(context, "pas-native.db", null, 2) {
    private val prefs = context.getSharedPreferences("native-settings", Context.MODE_PRIVATE)
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE points(id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execSQL("CREATE INDEX points_at ON points(at)")
        createHistory(db)
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) { if (old < 2) createHistory(db) }
    private fun createHistory(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS share_events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, app_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_events_app_at ON share_events(app_id, at)")
        db.execSQL("CREATE TABLE IF NOT EXISTS share_points(app_id TEXT NOT NULL, point_id TEXT NOT NULL, at INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL NOT NULL, sent_at INTEGER, PRIMARY KEY(app_id, point_id))")
        db.execSQL("CREATE INDEX IF NOT EXISTS share_points_app_at ON share_points(app_id, at)")
    }

    /** Pause all. A change is recorded as `paused_all` / `resumed_all`; a forced stop goes through [stop]. */
    var paused: Boolean
        get() = prefs.getBoolean("paused", true)
        @Synchronized set(value) {
            if (value != paused) record(if (value) ShareEvent.Kind.PAUSED_ALL else ShareEvent.Kind.RESUMED_ALL)
            check(prefs.edit().putBoolean("paused", value).commit())
        }
    /** Pause all forced by the system, recorded as `stopped` with `reason` (unlock_failed, signed_out, storage_failed). */
    @Synchronized fun stop(reason: String) {
        if (!paused) record(ShareEvent.Kind.STOPPED, detail = reason)
        check(prefs.edit().putBoolean("paused", true).commit())
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
    /** Records `expired` once and remembers `userId`, so pairing that account again keeps the history. */
    @Synchronized fun markExpired(userId: String, detail: String = "") {
        if (!expired) record(ShareEvent.Kind.EXPIRED, detail = detail)
        check(prefs.edit().putString("expiredUser", userId).commit())
    }
    @Synchronized fun blocked(): Set<String> = prefs.getStringSet("blocked", emptySet())!!.toSet()
    @Synchronized fun block(appId: String) {
        val wasBlocked = appId in blocked()
        val next = blocked() + appId
        // A disabled app is not "paused": re-enabling it starts sharing.
        check(prefs.edit().putStringSet("blocked", next).putStringSet("pausedApps", pausedApps() - appId).commit())
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
    @Synchronized fun unblock(appId: String) { check(prefs.edit().putStringSet("blocked", blocked() - appId).commit()) }
    /** Apps the user paused on this phone. A local recipient filter only: the grant, consent and platform copy are untouched, and resuming needs no new disclosure. */
    @Synchronized fun pausedApps(): Set<String> = prefs.getStringSet("pausedApps", emptySet())!!.toSet()
    /** Never rewrites the queue: points recorded before the pause were authorized when taken and still upload. */
    @Synchronized fun pause(appId: String) {
        if (appId in pausedApps()) return
        record(ShareEvent.Kind.PAUSED, appId)
        check(prefs.edit().putStringSet("pausedApps", pausedApps() + appId).commit())
    }
    @Synchronized fun resume(appId: String) {
        if (appId !in pausedApps()) return
        record(ShareEvent.Kind.RESUMED, appId)
        check(prefs.edit().putStringSet("pausedApps", pausedApps() - appId).commit())
    }
    /** Apps that must not receive new fixes: revoked, or paused by the user. */
    @Synchronized fun excluded(): Set<String> = blocked() + pausedApps()
    @Synchronized fun apps(): List<ConnectedApp> = parseApps(JSONArray(prefs.getString("apps", "[]")))
    /**
     * The `apps` array of `GET /native/me`, stored as received. A held grant that the server dropped or replaced
     * (publisher change, disclosure revision, app-account deletion) is recorded as `grant_lost`.
     */
    @Synchronized fun saveApps(apps: JSONArray) {
        val incoming = parseApps(apps)
        val previous = apps()
        val blocked = blocked()
        transaction {
            for (old in previous) {
                if (old.grantId == null || old.id in blocked) continue
                val grant = incoming.find { it.id == old.id }?.grantId
                if (grant != old.grantId) record(ShareEvent.Kind.GRANT_LOST, old.id, if (grant == null) "revoked" else "replaced")
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
    @Synchronized fun enqueue(point: TrackPoint) {
        val apps = apps()
        val allowed = LocationPolicy.recipients(apps, excluded(), point.at).toSet()
        val retained = point.copy(grants = point.grants.filter { it in allowed })
        if (paused || expired || retained.grants.isEmpty()) return
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
        // Keep the newest event of each (app, kind) before the cutoff, so state at the window start is known.
        db.execSQL("DELETE FROM share_events WHERE at < ? AND id NOT IN (SELECT MAX(id) FROM share_events WHERE at < ? GROUP BY app_id, kind)", arrayOf<Any>(cutoff, cutoff))
    }
    @Synchronized fun count(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM points", null).use { it.moveToFirst(); it.getInt(0) }
    /** Disconnect, or pairing a different account: everything. */
    @Synchronized fun clear() {
        transaction { db -> listOf("points", "share_events", "share_points").forEach { db.delete(it, null, null) } }
        check(prefs.edit().clear().commit())
    }
    /**
     * Pairing the same account after an expiry (#652): the queue and the settings, which hold the old device's grants,
     * go; the sharing history and activity log stay. Queued points carry grants the new device will never hold.
     */
    @Synchronized fun clearForReconnect() {
        transaction { db ->
            db.delete("points", null, null)
            db.delete("share_points", "sent_at IS NULL", null) // never shared, and now never will be
        }
        check(prefs.edit().clear().commit())
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
        db.delete("share_events", null, null); db.delete("share_points", null, null)
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
        val blocked = blocked(); val paused = pausedApps()
        val granted = apps().filter { it.grantId != null && it.id !in blocked }
        granted.forEach { record(ShareEvent.Kind.ENABLED, it.id, detail, if (consentTime) minOf(it.consentAt, now) else now) }
        granted.filter { it.id in paused }.forEach { record(ShareEvent.Kind.PAUSED, it.id, detail, now) }
        if (this.paused) record(ShareEvent.Kind.PAUSED_ALL, detail = detail, at = now)
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
