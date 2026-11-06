package online.proappstore.companion

import org.junit.Assert.*
import org.junit.Test

class LocationPolicyTest {
    private val app = ConnectedApp("ski", "Ski", "Routes", "Disclosure", "1", "grant-one", 1000)
    @Test fun recipientsRequireConsentAndRespectLocalRevocation() {
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app), emptySet(), 999))
        assertEquals(listOf("grant-one"), LocationPolicy.recipients(listOf(app), emptySet(), 1000))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app), setOf("ski"), 1001))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app.copy(grantId = null)), emptySet(), 1001))
    }
    @Test fun gpsMustBeFreshAccurateAndHaveRecipients() {
        val p = TrackPoint("point", 20_000, -36.4, 148.4, 5f, listOf("grant-one"))
        assertTrue(LocationPolicy.valid(p, 20_000))
        assertFalse(LocationPolicy.valid(p.copy(at = 4_999), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(at = 22_001), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(lat = Double.NaN), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(lng = 181.0), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(accuracy = 101f), 20_000))
        assertFalse(LocationPolicy.valid(p.copy(grants = emptyList()), 20_000))
    }
}
