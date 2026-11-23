package online.proappstore.companion

import online.proappstore.companion.ShareEvent.Kind.*
import org.junit.Assert.*
import org.junit.Test

/** Pure pieces of the sharing screens, ported from iOS TrackShapeTests, ActivityTextTests and SharingStateTests (#622-#624). */
class SharingViewsTest {
    private fun s(at: Long, sent: Long? = 1) = TrackSample(at, 1.0, 2.0, 5.0, sent)

    @Test fun aGapOverAMinuteSplitsAndOneUnderDoesNot() {
        assertEquals(2, TrackShape.segments(listOf(s(0), s(61_000))).size)
        assertEquals(1, TrackShape.segments(listOf(s(0), s(59_000))).size)
    }

    @Test fun uploadStateSplitsAndFlagsPending() {
        val segments = TrackShape.segments(listOf(s(0), s(1_000), s(2_000, null), s(3_000, null)))
        assertEquals(listOf(false, true), segments.map { it.pending })
        assertEquals(listOf(listOf(0L, 1_000L), listOf(2_000L, 3_000L)), segments.map { seg -> seg.samples.map { it.at } })
    }

    @Test fun thinningKeepsEveryEndpointAndStaysUnderTheCap() {
        // Three walks separated by gaps, 12,000 samples in all.
        val samples = (0 until 12_000).map { i -> s(i * 1_000L + (i / 4_000) * 120_000L) }
        val full = TrackShape.segments(samples, maxPoints = Int.MAX_VALUE)
        val thinned = TrackShape.segments(samples)
        assertEquals(3, thinned.size)
        assertTrue(thinned.sumOf { it.samples.size } <= 5_000)
        full.zip(thinned).forEach { (a, b) -> assertEquals(a.samples.first(), b.samples.first()); assertEquals(a.samples.last(), b.samples.last()) }
    }

    /** #639: only fixes at 25 m or better are drawn; coarser ones are skipped. */
    @Test fun coarseFixesAreNotDrawn() {
        val samples = listOf(s(0), s(1_000).copy(accuracy = 25.0), s(2_000).copy(accuracy = 25.1, lat = 9.0), s(3_000).copy(accuracy = 53.0, lat = 9.0), s(4_000))
        assertEquals(listOf(listOf(0L, 1_000L, 4_000L)), TrackShape.segments(samples).map { seg -> seg.samples.map { it.at } })
        assertEquals(emptyList<TrackShape.Segment>(), TrackShape.segments(listOf(s(0).copy(accuracy = 40.0))))
    }

    @Test fun emptyInputGivesNoSegments() { assertEquals(emptyList<TrackShape.Segment>(), TrackShape.segments(emptyList())) }

    @Test fun projectionKeepsShapeAndFitsTheBox() {
        val points = listOf(-33.0 to 151.0, -33.01 to 151.02)
        val p = TrackProjection(points, 400f, 200f, 10f)
        val a = p.project(-33.0, 151.0); val b = p.project(-33.01, 151.02)
        assertTrue(a.x < b.x); assertTrue(a.y < b.y) // east is right, south is down
        listOf(a, b).forEach { assertTrue(it.x in 0f..400f && it.y in 0f..200f) }
        // One point sits in the middle.
        assertEquals(200f, TrackProjection(listOf(1.0 to 2.0), 400f, 200f, 10f).project(1.0, 2.0).x, 0.01f)
    }

    @Test fun everyKindHasASentence() {
        fun sentence(kind: ShareEvent.Kind, detail: String = "", app: String? = "run") = ActivityText.sentence(ShareEvent(1, 0, app, kind, detail), if (app == null) null else "Run")
        val table = listOf(
            Triple(ENABLED, "", "Run sharing turned on"), Triple(DISABLED, "", "Run sharing turned off"),
            Triple(PAUSED, "", "Run paused by you"), Triple(RESUMED, "", "Run resumed by you"),
            Triple(PAUSED_ALL, "", "All sharing paused by you"), Triple(RESUMED_ALL, "", "All sharing resumed"),
            Triple(STOPPED, "signed_out", "Sharing stopped: this phone was signed out"),
            Triple(GRANT_LOST, "revoked", "Run access revoked by ProAppStore (the app changed owner or its disclosure)"),
            Triple(GRANT_RESTORED, "", "Run access restored"), Triple(HISTORY_CLEARED, "", "History cleared"),
            Triple(SYNC_FAILED, "429 Upload limit reached. Retry later.", "Upload failed: Upload limit reached. Retry later. (429)"),
            Triple(SYNC_RECOVERED, "after 3 attempts", "Uploads working again after 3 attempts"),
            Triple(UPLOAD_REJECTED, "partial_ack", "Upload not fully acknowledged: the copy on this phone was kept"),
            Triple(QUOTA, "429", "Upload limit reached (429)"),
            Triple(PERMISSION, "always→approximate", "Precise location turned off: recording stopped"),
            Triple(QUEUE_FULL, "", "Storage queue full: recording stopped until uploads catch up"),
            Triple(EXPIRED, "", "Connection to ProAppStore expired: sharing stopped"),
        )
        assertEquals(ShareEvent.Kind.entries.toSet(), table.map { it.first }.toSet())
        table.forEach { (kind, detail, expected) -> assertEquals(expected, sentence(kind, detail)) }
        assertEquals("Upload failed (offline)", sentence(SYNC_FAILED, "0 Unable to resolve host", null))
        assertEquals("Upload rejected by ProAppStore (413)", sentence(UPLOAD_REJECTED, "413", null))
        assertEquals("Location permission changed: All the time → While using the app", sentence(PERMISSION, "always→whenInUse", null))
        assertEquals("Precise location turned on", sentence(PERMISSION, "approximate→whenInUse", null))
        assertEquals("Reconnecting to ProAppStore: sharing stopped until you re-enable apps", sentence(EXPIRED, "renew", null))
        assertEquals(ActivityText.Category.PROBLEM, ActivityText.category(EXPIRED))
        assertEquals(ActivityText.Category.SHARING, ActivityText.category(PAUSED))
        assertEquals(ActivityText.Category.PROBLEM, ActivityText.category(SYNC_FAILED))
    }

    @Test fun everyKindRoundTripsItsStoredName() {
        ShareEvent.Kind.entries.forEach { assertEquals(it, ShareEvent.Kind.of(it.raw)) }
        assertNull(ShareEvent.Kind.of("from_a_newer_build"))
    }

    @Test fun everyChip() {
        data class Case(val granted: Boolean, val blocked: Boolean, val appPaused: Boolean, val pausedAll: Boolean, val running: Boolean, val chip: SharingState)
        listOf(
            Case(true, false, false, false, true, SharingState.SHARING),
            Case(true, false, true, false, true, SharingState.PAUSED),
            Case(true, false, true, true, false, SharingState.PAUSED_ALL), // Pause all wins over the app's own pause
            Case(true, false, false, true, false, SharingState.PAUSED_ALL),
            Case(false, false, false, false, true, SharingState.OFF),
            Case(false, true, false, false, true, SharingState.OFF), // revocation finished, grant gone
            Case(true, true, false, false, true, SharingState.TURNING_OFF), // DELETE still pending
            Case(true, true, true, true, false, SharingState.TURNING_OFF),
            Case(true, false, false, false, false, SharingState.NOT_RECORDING), // e.g. permission lost
        ).forEach { assertEquals(it.toString(), it.chip, SharingState.of(it.granted, it.blocked, it.appPaused, it.pausedAll, it.running)) }
    }

    /** #652: an expired connection enables nothing, and every app's chip says so. */
    @Test fun anExpiredConnectionEnablesNothing() {
        val app = ConnectedApp("ski", "Ski", "Routes", "D", "1", "g")
        val state = CompanionState(expired = true, apps = listOf(app), paused = false, running = true)
        assertFalse(state.enabled(app))
        assertFalse(state.sharing(app))
        assertEquals(SharingState.EXPIRED, state.stateOf(app))
        assertTrue(CompanionState(signedIn = true, apps = listOf(app)).enabled(app))
    }

    @Test fun durations() {
        assertEquals("0 min", Format.duration(59_000))
        assertEquals("1 h 12 min", Format.duration(72 * 60_000L))
    }
}
