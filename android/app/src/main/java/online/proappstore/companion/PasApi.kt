package online.proappstore.companion

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class ApiFailure(val status: Int, message: String) : Exception(message)

class PasApi {
    companion object { const val ORIGIN = "https://api.proappstore.online" }
    /** Only the platform origin receives the narrow native credential; redirects are refused. */
    fun request(method: String, path: String, token: String? = null, body: JSONObject? = null): JSONObject {
        require(path.startsWith("/native/"))
        val connection = URL("$ORIGIN/v1$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000; connection.readTimeout = 20_000
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
            val result = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            if (code !in 200..299) throw ApiFailure(code, result.optString("error", "Could not reach ProAppStore ($code)."))
            return result
        } finally { connection.disconnect() }
    }
}
