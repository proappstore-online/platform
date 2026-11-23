package online.proappstore.companion

import java.time.Instant
import java.time.ZoneId

/** Why sharing with an app was inactive inside a session. */
sealed class InactiveCause {
    /** This app paused by the user. */
    data object You : InactiveCause()
    /** Pause all. */
    data object All : InactiveCause()
    /** A forced stop: `stopped` detail (unlock_failed, signed_out, storage_failed). */
    data class System(val detail: String) : InactiveCause()
}

data class InactiveInterval(val start: Long, val end: Long?, val cause: InactiveCause)

/** A stretch of one session: shared (`cause` null), or inactive for a cause. */
data class SharingPeriod(val start: Long, val end: Long, val cause: InactiveCause?)

/**
 * One consent period for one app: from `enabled` (or `grant_restored`) to `disabled`, `grant_lost` or `history_cleared`
 * (open if none). This is *intended* sharing: permission loss or Android stopping the service can still leave gaps in
 * the points, and the track shows those (ADR-015: a gap must remain a gap). Ported from iOS SharingTimeline.swift.
 */
data class SharingSession(val start: Long, val end: Long?, val endKind: ShareEvent.Kind?, val inactive: List<InactiveInterval>) {
    /** Session span minus inactive intervals, clipped to `range`. Open ends run to `range.last`. */
    fun sharedMs(range: LongRange): Long {
        fun clipped(start: Long, end: Long?) = maxOf(0, minOf(end ?: range.last, range.last) - maxOf(start, range.first))
        return clipped(start, end) - inactive.sumOf { clipped(it.start, it.end) }
    }

    /** The session cut into shared and inactive stretches, in order. Open ends run to `now`. */
    fun periods(now: Long): List<SharingPeriod> {
        val periods = mutableListOf<SharingPeriod>()
        var cursor = start
        for (interval in inactive) {
            if (interval.start > cursor) periods += SharingPeriod(cursor, interval.start, null)
            val stop = interval.end ?: end ?: now
            periods += SharingPeriod(interval.start, stop, interval.cause)
            cursor = stop
        }
        val last = end ?: now
        if (last > cursor) periods += SharingPeriod(cursor, last, null)
        return periods
    }
}

object SharingTimeline {
    /** Sessions for `appId`, oldest first, from events in `(at, id)` order. */
    fun sessions(events: List<ShareEvent>, appId: String): List<SharingSession> {
        val sessions = mutableListOf<SharingSession>()
        var appPaused = false
        var global: InactiveCause? = null // Pause all or a forced stop, until `resumed_all`

        fun cause(): InactiveCause? = global ?: if (appPaused) InactiveCause.You else null
        /** Closes the open session's open interval at `at`, dropping it if it is empty. */
        fun closeInterval(session: SharingSession, at: Long): SharingSession {
            val last = session.inactive.lastOrNull()
            if (last == null || last.end != null) return session
            val rest = session.inactive.dropLast(1)
            return session.copy(inactive = if (last.start == at) rest else rest + last.copy(end = at))
        }
        /** When the cause changed, closes the open interval and opens one for the new cause. */
        fun transition(at: Long, old: InactiveCause?) {
            val session = sessions.lastOrNull() ?: return
            if (session.end != null || old == cause()) return
            var next = closeInterval(session, at)
            cause()?.let { next = next.copy(inactive = next.inactive + InactiveInterval(at, null, it)) }
            sessions[sessions.size - 1] = next
        }
        fun end(at: Long, kind: ShareEvent.Kind) {
            val session = sessions.lastOrNull() ?: return
            if (session.end != null) return
            sessions[sessions.size - 1] = closeInterval(session, at).copy(end = at, endKind = kind)
        }

        for (event in events) {
            val old = cause()
            val mine = event.appId == appId
            val device = event.appId == null
            when (event.kind) {
                ShareEvent.Kind.ENABLED, ShareEvent.Kind.GRANT_RESTORED -> if (mine) {
                    // A start inside an open session (a grant restored by re-enabling) continues it.
                    if (sessions.lastOrNull()?.end == null && sessions.isNotEmpty()) continue
                    appPaused = false
                    sessions += SharingSession(event.at, null, null, global?.let { listOf(InactiveInterval(event.at, null, it)) } ?: emptyList())
                }
                ShareEvent.Kind.DISABLED, ShareEvent.Kind.GRANT_LOST -> if (mine) { end(event.at, event.kind); appPaused = false }
                ShareEvent.Kind.HISTORY_CLEARED -> if (device) end(event.at, ShareEvent.Kind.HISTORY_CLEARED)
                ShareEvent.Kind.PAUSED -> if (mine) { appPaused = true; transition(event.at, old) }
                ShareEvent.Kind.RESUMED -> if (mine) { appPaused = false; transition(event.at, old) }
                ShareEvent.Kind.PAUSED_ALL -> if (device) { if (global == null) global = InactiveCause.All; transition(event.at, old) }
                ShareEvent.Kind.STOPPED -> if (device) { global = InactiveCause.System(event.detail); transition(event.at, old) }
                ShareEvent.Kind.RESUMED_ALL -> if (device) { global = null; transition(event.at, old) }
                else -> Unit
            }
        }
        return sessions
    }

    /** Local midnight to `now`, the "today" window. */
    fun today(now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): LongRange =
        Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()..now
}
