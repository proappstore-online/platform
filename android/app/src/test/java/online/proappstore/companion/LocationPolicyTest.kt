package online.proappstore.companion

import org.junit.Assert.*
import org.junit.Test

class LocationPolicyTest {
    private val app = ConnectedApp("ski", "Ski", "Routes", "Disclosure", "1", "grant-one", 1000)
    private val both = setOf("ski", "run")
    @Test fun recipientsRequireConsentAndRespectLocalRevocation() {
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app), emptySet(), both, 999))
        assertEquals(listOf("grant-one"), LocationPolicy.recipients(listOf(app), emptySet(), both, 1000))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app), setOf("ski"), both, 1001))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app.copy(grantId = null)), emptySet(), both, 1001))
    }
    /** With every granted app revoked or without a session there is no recipient, which is the condition LocationService stops on. */
    @Test fun noRecipientsWhenEveryGrantedAppIsExcluded() {
        val run = ConnectedApp("run", "Run", "Routes", "Disclosure", "1", "grant-two", 1000)
        assertEquals(listOf("grant-two"), LocationPolicy.recipients(listOf(app, run), setOf("ski"), both, 2000))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app, run), setOf("ski", "run"), both, 2000))
        assertEquals(emptyList<String>(), LocationPolicy.recipients(listOf(app, run), setOf("ski"), setOf("ski"), 2000))
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

    // #639: the emit filter.
    private val home = -33.87 to 151.21
    /** A fix `north` and `east` metres from home. */
    private fun fix(at: Long, north: Double, east: Double, accuracy: Float) = TrackPoint("p$at", at,
        home.first + north / 111_195.0, home.second + east / (111_195.0 * Math.cos(Math.toRadians(home.first))), accuracy, listOf("grant-one"))
    /** Runs fixes through the filter like LocationService does and returns the emitted ones. */
    private fun emitted(fixes: List<Pair<TrackPoint, Float?>>): List<TrackPoint> {
        var last: TrackPoint? = null
        return fixes.filter { (f, speed) -> LocationPolicy.shouldEmit(last, f, speed).also { if (it) last = f } }.map { it.first }
    }

    @Test fun distanceIsGreatCircleMetres() {
        assertEquals(111_195.0, LocationPolicy.distanceMeters(0.0, 0.0, 1.0, 0.0), 1.0)
        assertEquals(30.0, LocationPolicy.distanceMeters(fix(0, 0.0, 0.0, 5f).lat, fix(0, 0.0, 0.0, 5f).lng, fix(0, 0.0, 30.0, 5f).lat, fix(0, 0.0, 30.0, 5f).lng), 0.05)
    }

    @Test fun stationaryJitterWithDopplerEmitsOnlyHeartbeats() {
        // Serge's 16 minutes indoors: a fix every 10 s, up to 30 m off in any direction, 12-53 m accuracy, Doppler near zero.
        val random = java.util.Random(639)
        val fixes = (0 until 96).map { i ->
            val r = 30 * random.nextDouble(); val a = 2 * Math.PI * random.nextDouble()
            fix(i * 10_000L, r * Math.cos(a), r * Math.sin(a), 12f + random.nextInt(42)) to random.nextFloat() * 0.25f
        }
        assertEquals(listOf(0L, 300_000L, 600_000L, 900_000L), emitted(fixes).map { it.at })
    }

    @Test fun jitterInsideTheAccuracyCircleWithoutDopplerEmitsOnlyHeartbeats() {
        // The network provider reports no speed; its fixes wander inside their own accuracy.
        val random = java.util.Random(622)
        val fixes = (0 until 96).map { i ->
            val accuracy = 30f + random.nextInt(24)
            val r = accuracy / 2 * random.nextDouble(); val a = 2 * Math.PI * random.nextDouble()
            fix(i * 10_000L, r * Math.cos(a), r * Math.sin(a), accuracy) to null
        }
        assertEquals(listOf(0L, 300_000L, 600_000L, 900_000L), emitted(fixes).map { it.at })
    }

    @Test fun aPreciseWalkEmitsAboutOnePointPerTenMetres() {
        // 1 km north at 1 m/s, a fix a second, 3 m accuracy.
        val fixes = (0..1_000).map { i -> fix(i * 1_000L, i.toDouble(), 0.0, 3f) to 1f }
        val points = emitted(fixes)
        assertTrue("${points.size} points", points.size in 95..101)
        points.zipWithNext().forEach { (a, b) -> assertTrue(LocationPolicy.distanceMeters(a.lat, a.lng, b.lat, b.lng) >= 10.0) }
    }

    @Test fun theThresholdIsTheCoarserAccuracyAndAtLeastTenMetres() {
        val last = fix(0, 0.0, 0.0, 3f)
        assertFalse(LocationPolicy.shouldEmit(last, fix(10_000, 9.0, 0.0, 3f), null))
        assertTrue(LocationPolicy.shouldEmit(last, fix(10_000, 11.0, 0.0, 3f), null))
        assertFalse(LocationPolicy.shouldEmit(last, fix(10_000, 39.0, 0.0, 40f), null))
        assertFalse(LocationPolicy.shouldEmit(fix(0, 0.0, 0.0, 40f), fix(10_000, 39.0, 0.0, 3f), null))
        assertTrue(LocationPolicy.shouldEmit(last, fix(10_000, 41.0, 0.0, 40f), null))
    }

    @Test fun dopplerStillnessHoldsUntilTheHeartbeatAndTheFirstFixAlwaysEmits() {
        val last = fix(0, 0.0, 0.0, 5f)
        assertTrue(LocationPolicy.shouldEmit(null, last, 0f))
        assertFalse(LocationPolicy.shouldEmit(last, fix(60_000, 50.0, 0.0, 5f), 0.29f))
        assertTrue(LocationPolicy.shouldEmit(last, fix(60_000, 50.0, 0.0, 5f), 0.3f))
        assertFalse(LocationPolicy.shouldEmit(last, fix(LocationPolicy.HEARTBEAT_MS - 1, 0.0, 0.0, 5f), 0f))
        assertTrue(LocationPolicy.shouldEmit(last, fix(LocationPolicy.HEARTBEAT_MS, 0.0, 0.0, 5f), 0f))
    }

    @Test fun theCollectorSyncsOnlyWithWorkOrForAGrantRefresh() {
        assertFalse(LocationPolicy.syncDue(0, false, 1_000, 1_000 + LocationPolicy.IDLE_SYNC_MS - 1))
        assertTrue(LocationPolicy.syncDue(0, false, 1_000, 1_000 + LocationPolicy.IDLE_SYNC_MS))
        assertTrue(LocationPolicy.syncDue(1, false, 1_000, 1_001))
        assertTrue(LocationPolicy.syncDue(0, true, 1_000, 1_001))
        assertTrue(LocationPolicy.syncDue(0, false, 0, 1_000 + LocationPolicy.IDLE_SYNC_MS))
    }
}
