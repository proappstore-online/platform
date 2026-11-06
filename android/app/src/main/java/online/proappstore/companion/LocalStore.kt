package online.proappstore.companion

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

class LocalStore(context: Context) : SQLiteOpenHelper(context, "pas-native.db", null, 1) {
    private val prefs = context.getSharedPreferences("native-settings", Context.MODE_PRIVATE)
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE points(id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execSQL("CREATE INDEX points_at ON points(at)")
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) = Unit
    var paused: Boolean
        get() = prefs.getBoolean("paused", true)
        set(value) { check(prefs.edit().putBoolean("paused", value).commit()) }
    var lastSync: Long
        get() = prefs.getLong("lastSync", 0)
        set(value) { prefs.edit().putLong("lastSync", value).apply() }
    var message: String
        get() = prefs.getString("message", "") ?: ""
        set(value) { prefs.edit().putString("message", value).apply() }
    var userName: String
        get() = prefs.getString("userName", "") ?: ""
        set(value) { prefs.edit().putString("userName", value).apply() }
    @Synchronized fun blocked(): Set<String> = prefs.getStringSet("blocked", emptySet())!!.toSet()
    @Synchronized fun block(appId: String) {
        val next = blocked() + appId
        check(prefs.edit().putStringSet("blocked", next).commit())
        // Discard only this recipient. Other enabled apps retain their own queued copy.
        val revoked = apps().find { it.id == appId }?.grantId ?: return
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (p in pending(LocationPolicy.MAX_QUEUE)) {
                if (revoked !in p.grants) continue
                val keep = p.copy(grants = p.grants.filter { it != revoked })
                if (keep.grants.isEmpty()) db.delete("points", "id = ?", arrayOf(p.id))
                else db.update("points", ContentValues().apply { put("payload", keep.json().toString()) }, "id = ?", arrayOf(p.id))
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    @Synchronized fun unblock(appId: String) { check(prefs.edit().putStringSet("blocked", blocked() - appId).commit()) }
    @Synchronized fun apps(): List<ConnectedApp> {
        val array = JSONArray(prefs.getString("apps", "[]"))
        return (0 until array.length()).map { i ->
            val a = array.getJSONObject(i); val g = a.optJSONObject("grant")
            ConnectedApp(a.getString("id"), a.getString("name"), a.getString("purpose"), a.getString("disclosure"), a.getString("version"), g?.getString("id"), g?.getLong("consent_at") ?: 0)
        }
    }
    @Synchronized fun saveApps(apps: JSONArray) { check(prefs.edit().putString("apps", apps.toString()).commit()) }
    @Synchronized fun enqueue(point: TrackPoint) {
        val allowed = LocationPolicy.recipients(apps(), blocked(), point.at).toSet()
        val retained = point.copy(grants = point.grants.filter { it in allowed })
        if (paused || retained.grants.isEmpty()) return
        check(count() < LocationPolicy.MAX_QUEUE) { "Device storage queue is full. Connect to upload before resuming." }
        writableDatabase.insertOrThrow("points", null, ContentValues().apply {
            put("id", retained.id); put("at", retained.at); put("payload", retained.json().toString())
        })
    }
    @Synchronized fun pending(limit: Int = 100): List<TrackPoint> = readableDatabase.rawQuery("SELECT payload FROM points ORDER BY at, id LIMIT ?", arrayOf(limit.toString())).use { cursor ->
        buildList { while (cursor.moveToNext()) add(pointFrom(JSONObject(cursor.getString(0)))) }
    }
    @Synchronized fun acknowledge(ids: List<String>) {
        val db = writableDatabase; db.beginTransaction()
        try { ids.forEach { db.delete("points", "id = ?", arrayOf(it)) }; db.setTransactionSuccessful() } finally { db.endTransaction() }
    }
    @Synchronized fun expire(now: Long) { writableDatabase.delete("points", "at < ?", arrayOf((now - LocationPolicy.RETENTION_MS).toString())) }
    @Synchronized fun count(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM points", null).use { it.moveToFirst(); it.getInt(0) }
    @Synchronized fun clear() { writableDatabase.delete("points", null, null); check(prefs.edit().clear().commit()) }
}

internal fun TrackPoint.json() = JSONObject().put("id", id).put("at", at).put("lat", lat).put("lng", lng).put("accuracy", accuracy.toDouble()).put("grants", JSONArray(grants))
private fun pointFrom(p: JSONObject): TrackPoint {
    val grants = p.getJSONArray("grants")
    return TrackPoint(p.getString("id"), p.getLong("at"), p.getDouble("lat"), p.getDouble("lng"), p.getDouble("accuracy").toFloat(), (0 until grants.length()).map { grants.getString(it) })
}
