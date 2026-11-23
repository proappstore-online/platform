package online.proappstore.companion

import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

/** #652: only a 401 expires the connection; the note shows only in the last 7 days. */
class DeviceConnectionTest {
    @Test fun only401Expires() {
        assertTrue(DeviceConnection.expired(ApiFailure(401, "Device connection expired or was disconnected.")))
        for (status in listOf(400, 403, 404, 409, 429, 500, 502, 503)) assertFalse("$status", DeviceConnection.expired(ApiFailure(status, "x")))
        assertFalse(DeviceConnection.expired(IOException("offline")))
        assertFalse(DeviceConnection.expired(IllegalStateException("Upload was not fully acknowledged.")))
    }
    @Test fun expiryNoteOnlyInTheLastSevenDays() {
        val day = 24L * 60 * 60 * 1000
        assertNull(DeviceConnection.expiresInDays(0, 1))
        assertNull(DeviceConnection.expiresInDays(10 * day, 0))
        assertNull(DeviceConnection.expiresInDays(7 * day, 0))
        assertEquals(7, DeviceConnection.expiresInDays(7 * day - 1, 0))
        assertEquals(1, DeviceConnection.expiresInDays(day, 0))
        assertEquals(1, DeviceConnection.expiresInDays(1, 0))
        assertNull(DeviceConnection.expiresInDays(5, 5))
    }
}
