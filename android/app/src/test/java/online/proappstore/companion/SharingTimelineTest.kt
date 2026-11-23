package online.proappstore.companion

import online.proappstore.companion.ShareEvent.Kind.*
import org.junit.Assert.*
import org.junit.Test

/** Ported from iOS SharingTimelineTests.swift (#621). */
class SharingTimelineTest {
    private val min = 60_000L
    private var nextId = 0L
    private fun e(kind: ShareEvent.Kind, at: Long, appId: String? = "run", detail: String = "") = ShareEvent(++nextId, at, appId, kind, detail)

    @Test fun pauseAndResumeInsideAClosedSession() {
        val t = 10 * 60 * min
        val sessions = SharingTimeline.sessions(listOf(e(ENABLED, t), e(PAUSED, t + 20 * min), e(RESUMED, t + 30 * min), e(DISABLED, t + 60 * min)), "run")
        assertEquals(1, sessions.size)
        assertEquals(t + 60 * min, sessions[0].end)
        assertEquals(DISABLED, sessions[0].endKind)
        assertEquals(listOf(InactiveInterval(t + 20 * min, t + 30 * min, InactiveCause.You)), sessions[0].inactive)
        assertEquals(50 * min, sessions[0].sharedMs(0..t * 2))
    }

    @Test fun pauseAllOverlappingAnAppPauseIsNotDoubleSubtracted() {
        val sessions = SharingTimeline.sessions(listOf(
            e(ENABLED, 0), e(PAUSED, 10 * min), e(PAUSED_ALL, 15 * min, null), e(RESUMED, 20 * min), e(RESUMED_ALL, 30 * min, null), e(DISABLED, 60 * min)), "run")
        assertEquals(listOf(InactiveCause.You, InactiveCause.All), sessions[0].inactive.map { it.cause })
        assertEquals(40 * min, sessions[0].sharedMs(0..100 * min))
    }

    @Test fun aSessionAcrossMidnightCountsOnlyTodaysPart() {
        val midnight = 24 * 60 * min
        val sessions = SharingTimeline.sessions(listOf(e(ENABLED, midnight - 30 * min)), "run")
        assertNull(sessions[0].end)
        assertEquals(45 * min, sessions[0].sharedMs(midnight..midnight + 45 * min))
        assertEquals(30 * min - 1, sessions[0].sharedMs(midnight - 60 * min..midnight - 1))
    }

    @Test fun grantLostEndsTheSession() {
        val sessions = SharingTimeline.sessions(listOf(e(ENABLED, 0), e(GRANT_LOST, 5 * min, "run", "revoked"), e(ENABLED, 9 * min, "ski")), "run")
        assertEquals(1, sessions.size)
        assertEquals(GRANT_LOST, sessions[0].endKind)
        assertEquals(5 * min, sessions[0].end)
    }

    @Test fun appResumeUnderPauseAllStaysInactiveUntilResumeAll() {
        val sessions = SharingTimeline.sessions(listOf(
            e(ENABLED, 0), e(PAUSED, 10 * min), e(PAUSED_ALL, 20 * min, null), e(RESUMED, 30 * min), e(RESUMED_ALL, 40 * min, null)), "run")
        assertEquals(listOf(InactiveInterval(10 * min, 20 * min, InactiveCause.You), InactiveInterval(20 * min, 40 * min, InactiveCause.All)), sessions[0].inactive)
        assertEquals(20 * min, sessions[0].sharedMs(0..50 * min))
    }

    @Test fun forcedStopAndOtherAppsEventsAndHistoryCleared() {
        val sessions = SharingTimeline.sessions(listOf(
            e(ENABLED, 0), e(PAUSED, 5 * min, "ski"), e(STOPPED, 10 * min, null, "signed_out"), e(RESUMED_ALL, 20 * min, null), e(HISTORY_CLEARED, 30 * min, null)), "run")
        assertEquals(listOf(InactiveInterval(10 * min, 20 * min, InactiveCause.System("signed_out"))), sessions[0].inactive)
        assertEquals(HISTORY_CLEARED, sessions[0].endKind)
    }

    /** #652: an expiry ends every open session; re-enabling after Reconnect starts a new one. */
    @Test fun expiryEndsTheSessionAndReconnectStartsANewOne() {
        val sessions = SharingTimeline.sessions(listOf(e(ENABLED, 0), e(EXPIRED, 10 * min, null), e(ENABLED, 30 * min)), "run")
        assertEquals(listOf(0L, 30 * min), sessions.map { it.start })
        assertEquals(10 * min, sessions[0].end)
        assertEquals(EXPIRED, sessions[0].endKind)
        assertNull(sessions[1].end)
    }

    @Test fun aRestoredGrantStartsASessionAndEnableInsideItContinuesIt() {
        val sessions = SharingTimeline.sessions(listOf(e(ENABLED, 0), e(GRANT_LOST, 10 * min), e(GRANT_RESTORED, 20 * min), e(ENABLED, 20 * min)), "run")
        assertEquals(listOf(0L, 20 * min), sessions.map { it.start })
        assertNull(sessions[1].end)
    }

    @Test fun periodsCutASessionIntoSharedAndInactiveStretches() {
        val session = SharingTimeline.sessions(listOf(e(ENABLED, 0), e(PAUSED, 10 * min), e(RESUMED, 20 * min)), "run")[0]
        assertEquals(listOf(SharingPeriod(0, 10 * min, null), SharingPeriod(10 * min, 20 * min, InactiveCause.You), SharingPeriod(20 * min, 30 * min, null)),
            session.periods(30 * min))
    }

    @Test fun todayRunsFromLocalMidnight() {
        val zone = java.time.ZoneId.of("Australia/Sydney")
        val now = java.time.ZonedDateTime.of(2026, 11, 23, 9, 30, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals(java.time.ZonedDateTime.of(2026, 11, 23, 0, 0, 0, 0, zone).toInstant().toEpochMilli()..now, SharingTimeline.today(now, zone))
    }
}
