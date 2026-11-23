package online.proappstore.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

/**
 * The credential-free client for the public catalogue and its images (ADR-017 decision 4). It is not [PasApi], which is
 * the device credential's only gate: no `Authorization`, no cookies, no HTTP cache, no redirects.
 */
open class PublicFetch {
    class Result(val status: Int, val body: ByteArray, val etag: String?)

    /** Reads at most `maxBytes`; a larger body fails. */
    open fun get(url: String, headers: Map<String, String> = emptyMap(), maxBytes: Int): Result {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = 15_000; connection.readTimeout = 20_000
            headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
            val code = connection.responseCode
            if (code != 200) return Result(code, ByteArray(0), null)
            val body = connection.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    if (out.size() > maxBytes) throw IOException("Response too large")
                }
                out.toByteArray()
            }
            return Result(code, body, connection.getHeaderField("ETag"))
        } finally { connection.disconnect() }
    }
}

/**
 * The catalogue, cached on disk and revalidated with `If-None-Match` when the app comes to the foreground. It lives in
 * `no_backup/pas-catalogue`, outside the companion's database and settings, so browsing survives `LocalStore.clear()`
 * on pairing and disconnect.
 */
class CatalogueStore(private val directory: File, private val client: PublicFetch = PublicFetch()) {
    data class State(val catalogue: Catalogue = Catalogue(emptyList()), val stale: Boolean = false, val loading: Boolean = false)

    private val file = File(directory, "catalogue.json")
    private val etagFile = File(directory, "catalogue.etag")
    private val running = Mutex()
    private val _state = MutableStateFlow(State(catalogue = runCatching { Catalogue.parse(file.readText()) }.getOrNull() ?: Catalogue(emptyList())))
    val state: StateFlow<State> = _state

    suspend fun refresh() {
        if (!running.tryLock()) return
        try {
            _state.value = _state.value.copy(loading = true)
            val stale = withContext(Dispatchers.IO) {
                val etag = if (_state.value.catalogue.apps.isEmpty()) null else runCatching { etagFile.readText() }.getOrNull()
                try {
                    val response = client.get(URL, etag?.let { mapOf("If-None-Match" to it) } ?: emptyMap(), MAX_BYTES)
                    if (response.status == 304) return@withContext false
                    val text = response.body.toString(Charsets.UTF_8)
                    val fresh = Catalogue.parse(text)?.takeIf { response.status == 200 && it.apps.isNotEmpty() } ?: return@withContext true
                    save(text, response.etag)
                    _state.value = _state.value.copy(catalogue = fresh)
                    false
                } catch (_: Exception) { true }
            }
            _state.value = _state.value.copy(stale = stale, loading = false)
        } finally { running.unlock() }
    }

    private fun save(text: String, etag: String?) {
        directory.mkdirs()
        val tmp = File(directory, "catalogue.json.tmp")
        tmp.writeText(text)
        check(tmp.renameTo(file)) { "Could not save the catalogue." }
        if (etag != null) etagFile.writeText(etag) else etagFile.delete()
    }

    companion object {
        const val URL = "https://proappstore.online/catalogue.json"
        const val MAX_BYTES = 1_000_000
        fun directory(context: Context) = File(context.noBackupFilesDir, "pas-catalogue")
    }
}

/**
 * Catalogue images: memory, then `cache/pas-images/<sha256(url)>`, then [PublicFetch]. Only a `200` of at most 2 MB that
 * decodes is kept (the cap in `listing-images.cjs`). Callers pass only URLs [CatalogueApp] validated.
 */
class ImageCache(private val directory: File, private val client: PublicFetch = PublicFetch()) {
    private val memory = LruCache<String, Bitmap>(48)

    fun cached(url: String): Bitmap? = memory.get(url)

    suspend fun image(url: String): Bitmap? = withContext(Dispatchers.IO) {
        memory.get(url)?.let { return@withContext it }
        val file = File(directory, MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) })
        val bytes = runCatching { file.readBytes() }.getOrNull()
            ?: runCatching { client.get(url, maxBytes = MAX_BYTES) }.getOrNull()?.takeIf { it.status == 200 }?.body?.also { fetched ->
                if (decode(fetched) != null) runCatching { directory.mkdirs(); file.writeBytes(fetched) }
            }
            ?: return@withContext null
        decode(bytes)?.also { memory.put(url, it) }
    }

    /** Downsampled to about 1200 px on the long side: a 2 MB hero must not become a 50 MB bitmap. */
    private fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1200) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    companion object {
        const val MAX_BYTES = 2_000_000
        fun directory(context: Context) = File(context.cacheDir, "pas-images")
    }
}
