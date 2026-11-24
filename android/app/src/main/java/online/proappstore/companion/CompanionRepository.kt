package online.proappstore.companion

import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom

class CompanionRepository(val local: LocalStore, private val secure: SecureStore, private val api: PasApi) {
    private val operations = Mutex()
    fun token(): String? = try { secure.read().optString("token").takeIf { it.isNotBlank() } } catch (_: Exception) {
        local.stop("unlock_failed"); local.message = "The device connection could not be unlocked. Reconnect your account."; null
    }
    /** Grants that may receive a fix taken now: held, consented, not disabled on this phone, and with a session (ADR-020). */
    fun recipients(): List<String> = LocationPolicy.recipients(local.apps(), local.blocked(), local.sessionIds(), System.currentTimeMillis())
    /** Whether location collection should run, permissions aside: connected, and some app with a session would receive a fix. */
    fun collecting(): Boolean = token() != null && recipients().isNotEmpty()
    /** Heart-rate grants that may receive a reading taken now (#634): only apps with a session. */
    fun heartRateRecipients(): List<String> = HeartRatePolicy.recipients(local.entries(), local.blocked(), local.sessionIds(), System.currentTimeMillis())
    /** Whether the strap should be connected, permissions aside: connected account, a sensor, a grant with a session, queue room. */
    fun collectingHeartRate(): Boolean = token() != null && local.heartRateSensor != null &&
        heartRateRecipients().isNotEmpty() && local.heartRateCount() < HeartRatePolicy.MAX_QUEUE
    fun pairingCode(): String = try { secure.read().optString("pairId").take(8).uppercase() } catch (_: Exception) { "" }
    suspend fun startSignIn(): String = withContext(Dispatchers.IO) { operations.withLock {
        check(token() == null) { "Disconnect this account before connecting another." }
        val verifier = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val challenge = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()).joinToString("") { "%02x".format(it) }
        val result = api.request("POST", "/native/auth/start", body = JSONObject().put("challenge", challenge).put("label", "${Build.MANUFACTURER} ${Build.MODEL}".take(80)))
        secure.write(JSONObject().put("pairId", result.getString("id")).put("verifier", verifier))
        result.getString("authorizationUrl").also { check(it.startsWith("${PasApi.ORIGIN}/v1/native/auth/authorize?")) }
    } }
    suspend fun finishSignIn(): Boolean = withContext(Dispatchers.IO) { operations.withLock {
        val state = secure.read()
        if (!state.has("pairId")) return@withLock false
        val result = try {
            api.request("POST", "/native/auth/complete", body = JSONObject().put("id", state.getString("pairId")).put("verifier", state.getString("verifier")))
        } catch (e: ApiFailure) {
            // 403 expired or unknown, 409 already used: this pairing can never finish. Forget it, so the next open is a
            // plain Sign in instead of the same error and a dead pairing code.
            if (e.status == 403 || e.status == 409) secure.clear()
            throw e
        }
        if (result.optBoolean("pending")) return@withLock false
        val credential = result.getString("token")
        val me = api.request("GET", "/native/me", credential)
        val userId = me.getJSONObject("user").getString("id")
        // Pairing never adopts a previous installation/account's queue or grants. The same account after an expiry
        // keeps the on-device history (#652).
        if (local.expiredUser == userId) local.clearForReconnect() else local.clear()
        secure.write(JSONObject().put("token", credential).put("userId", userId))
        updateMe(me)
        true
    } }
    private fun updateMe(me: JSONObject) {
        check(me.getJSONObject("user").getString("id") == secure.read().getString("userId")) { "Account changed. Reconnect this device." }
        local.userName = me.getJSONObject("user").getString("name")
        local.deviceExpiresAt = me.optJSONObject("device")?.optLong("expiresAt") ?: 0
        local.saveApps(me.getJSONArray("apps"))
        local.saveEntries(me.optJSONArray("capabilities") ?: JSONArray())
    }
    suspend fun enable(app: ConnectedApp) = withContext(Dispatchers.IO) { operations.withLock {
        val credential = token() ?: error("Sign in first.")
        // Finish any queued revocation before granting a new epoch.
        if (app.id in local.blocked()) device("DELETE", "/native/apps/${app.id}/location", credential)
        device("PUT", "/native/apps/${app.id}/location", credential, JSONObject().put("version", app.version).put("enabled", true))
        updateMe(device("GET", "/native/me", credential))
        // Enabling grants; it never starts a session (ADR-020 §2). Start on the row does.
        local.unblock(app.id); local.record(ShareEvent.Kind.ENABLED, app.id); local.message = ""
    } }
    suspend fun disable(app: ConnectedApp) = withContext(Dispatchers.IO) {
        local.block(app.id) // Immediate, durable local stop even without network; recipient removed from the queue.
        sync()
    }
    /** A non-location capability (#634), through `/native/apps/:id/capabilities/:capability`. Location keeps its own path. */
    suspend fun enable(entry: NativeEntry) = withContext(Dispatchers.IO) { operations.withLock {
        val credential = token() ?: error("Sign in first.")
        val path = grantPath(entry.key)
        if (entry.key in local.blocked()) device("DELETE", path, credential)
        device("PUT", path, credential, JSONObject().put("version", entry.version).put("enabled", true))
        updateMe(device("GET", "/native/me", credential))
        local.unblock(entry.key); local.record(ShareEvent.Kind.HEART_RATE, entry.appId, "enabled"); local.message = ""
    } }
    suspend fun disable(entry: NativeEntry) = withContext(Dispatchers.IO) {
        local.block(entry.key)
        sync()
    }
    suspend fun disconnect() = withContext(Dispatchers.IO) { operations.withLock {
        local.endAllSessions("grant")
        token()?.let { credential ->
            try { api.request("DELETE", "/native/device", credential) } catch (e: ApiFailure) { if (e.status != 401) throw e }
        }
        local.clear(); secure.clear()
    } }
    suspend fun sync() = withContext(Dispatchers.IO) { operations.withLock {
        val credential = token() ?: return@withLock
        var uploading = false; var partial = false; var heartRateStage = false
        /** Up to 10 batches, stopping at an empty queue. Exact acknowledgement (#621): anything less keeps the device copy. */
        fun upload(path: String, key: String, next: () -> List<JSONObject>, ack: (List<String>) -> Unit) {
            for (round in 1..10) {
                val batch = next()
                if (batch.isEmpty()) break
                uploading = true
                val acknowledged = device("POST", path, credential, JSONObject().put(key, JSONArray(batch))).getJSONArray("acknowledged")
                val ids = (0 until acknowledged.length()).map { acknowledged.getString(it) }
                if (ids.toSet() != batch.map { it.getString("id") }.toSet()) { partial = true; error("Upload was not fully acknowledged. Device copy retained.") }
                ack(ids)
            }
        }
        try {
            val blocked = local.blocked()
            for (key in blocked) device("DELETE", grantPath(key), credential)
            updateMe(device("GET", "/native/me", credential))
            for (id in blocked) local.unblock(id)
            local.expire(System.currentTimeMillis())
            upload("/native/locations", "points", { local.pending().map { it.json() } }, { local.acknowledge(it) })
            // Heart rate after points (#634), under its own quota and the same exact-acknowledgement rule.
            heartRateStage = true
            upload("/native/heart-rate", "samples", { local.pendingHeartRate().map { it.json() } }, { local.acknowledgeHeartRate(it) })
            local.heartRateSyncError = ""
            local.lastSync = System.currentTimeMillis(); local.lastSyncAttempt = local.lastSync; local.message = ""; local.lastSyncError = ""
            runCatching { local.syncSucceeded() }
        } catch (e: Exception) {
            if (DeviceConnection.expired(e)) throw e // the expired card says it, not a sync failure
            local.message = if (e is ApiFailure) e.message ?: "Reconnect your account." else "Waiting to sync. Location stays on this phone."
            local.lastSyncAttempt = System.currentTimeMillis(); local.lastSyncError = e.message ?: local.message
            // A failure before the heart-rate stage also holds back a waiting heart-rate queue (#674).
            if (heartRateStage || runCatching { local.heartRateCount() > 0 }.getOrDefault(false)) local.heartRateSyncError = e.message ?: local.message
            val rejected = if (heartRateStage) ShareEvent.Kind.HEART_RATE_PROBLEM else ShareEvent.Kind.UPLOAD_REJECTED
            // Activity log: status (0 = network) plus the server's `error` text only.
            val status = (e as? ApiFailure)?.status ?: if (e is IOException) 0 else null
            if (runCatching { local.syncFailed(status?.let { "$it ${e.message ?: ""}".trim() } ?: (e.message ?: "")) }.getOrDefault(false)) runCatching {
                if (status == 429) local.record(ShareEvent.Kind.QUOTA, detail = "429")
                if (uploading && (status == 400 || status == 413)) local.record(rejected, detail = "$status")
                if (partial) local.record(rejected, detail = "partial_ack")
            }
            throw e
        }
    } }
    /**
     * Reconnecting before the connection expires (#652): uploads what it can, then takes the expiry path, which keeps
     * the history. The old credential is only forgotten: revoking it would delete the platform copies already shared,
     * and it lapses within days.
     */
    suspend fun renew() = withContext(Dispatchers.IO) {
        if (token() == null) return@withContext
        try { sync() } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e }
        operations.withLock { if (token() != null) expire("renew") }
    }
    /** A device-authenticated request. A 401 expires the connection (#652). */
    private fun device(method: String, path: String, credential: String, body: JSONObject? = null): JSONObject = try {
        api.request(method, path, credential, body)
    } catch (e: ApiFailure) {
        if (DeviceConnection.expired(e)) expire()
        throw e
    }
    companion object {
        /** The grant path for a [NativeEntry.key]: a bare app id is location's original path. */
        fun grantPath(key: String): String = key.split('/', limit = 2).let { if (it.size == 2) "/native/apps/${it[0]}/capabilities/${it[1]}" else "/native/apps/$key/location" }
    }
    /** Drops the credential, so collection stops, and keeps everything on the phone for Reconnect. */
    private fun expire(detail: String = "") { local.markExpired(secure.read().optString("userId"), detail); secure.clear() }
}
