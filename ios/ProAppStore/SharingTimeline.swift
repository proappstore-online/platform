import Foundation

/// Why sharing with an app was inactive inside a session.
enum InactiveCause: Equatable {
    case you                 // this app paused by the user (retired, in older history)
    case all                 // Pause all (retired, in older history)
    case system(String)      // a forced stop: `stopped` detail (unlock_failed, signed_out, storage_failed)
    case stopped(String)     // no collection session (ADR-020): `session_ended` detail, or "" before the first Start
}

struct InactiveInterval: Equatable {
    let start: Int64
    var end: Int64?          // nil = still inactive
    let cause: InactiveCause
}

/// One consent period for one app: from `enabled` (or `grant_restored`) to `disabled`, `grant_lost`, `history_cleared` or
/// `expired` (open if none). Outside a collection session (ADR-020: `session_started` to `session_ended`) it is inactive.
/// This is *intended* sharing. Permission loss or iOS ending the app can still leave gaps in the points, and the
/// track shows those (ADR-015: a gap must remain a gap).
struct SharingSession: Equatable {
    let start: Int64
    var end: Int64?
    var endKind: ShareEvent.Kind?
    /// Non-overlapping and in order. A change of cause starts a new interval.
    var inactive: [InactiveInterval]

    /// Session span minus inactive intervals, clipped to `range`. Open ends run to `range.upperBound`.
    func sharedMs(within range: ClosedRange<Int64>) -> Int64 {
        func clipped(_ start: Int64, _ end: Int64?) -> Int64 {
            max(0, min(end ?? range.upperBound, range.upperBound) - max(start, range.lowerBound))
        }
        return clipped(start, end) - inactive.reduce(0) { $0 + clipped($1.start, $1.end) }
    }
}

enum SharingTimeline {
    /// Sessions for `appId`, oldest first, from events in `(at, id)` order.
    static func sessions(_ events: [ShareEvent], appId: String) -> [SharingSession] {
        var sessions: [SharingSession] = []
        var appPaused = false        // the retired per-app pause, in older history
        var global: InactiveCause?   // Pause all or a forced stop, until `resumed_all` or a session start
        var live = false             // a collection session is running
        var stopped: String?         // why there is no session; nil in one

        func cause() -> InactiveCause? { global ?? stopped.map(InactiveCause.stopped) ?? (appPaused ? .you : nil) }
        /// Closes the open session's open interval at `at`, dropping it if it is empty.
        func closeInterval(_ session: inout SharingSession, at: Int64) {
            guard let last = session.inactive.last, last.end == nil else { return }
            if last.start == at { session.inactive.removeLast() } else { session.inactive[session.inactive.count - 1].end = at }
        }
        /// When the cause changed, closes the open interval and opens one for the new cause.
        func transition(at: Int64, from old: InactiveCause?) {
            guard var session = sessions.last, session.end == nil, old != cause() else { return }
            closeInterval(&session, at: at)
            if let now = cause() { session.inactive.append(InactiveInterval(start: at, end: nil, cause: now)) }
            sessions[sessions.count - 1] = session
        }
        func end(at: Int64, kind: ShareEvent.Kind) {
            guard var session = sessions.last, session.end == nil else { return }
            closeInterval(&session, at: at)
            session.end = at; session.endKind = kind
            sessions[sessions.count - 1] = session
        }

        for event in events {
            let old = cause()
            switch (event.kind, event.appId) {
            case (.enabled, appId), (.grantRestored, appId):
                // A start inside an open session (a grant restored by re-enabling) continues it.
                if let last = sessions.last, last.end == nil { break }
                appPaused = false
                stopped = live ? nil : ""
                sessions.append(SharingSession(start: event.at, end: nil, endKind: nil,
                                               inactive: cause().map { [InactiveInterval(start: event.at, end: nil, cause: $0)] } ?? []))
            case (.disabled, appId), (.grantLost, appId):
                end(at: event.at, kind: event.kind); appPaused = false
            case (.historyCleared, nil), (.expired, nil):
                end(at: event.at, kind: event.kind)
            case (.paused, appId):
                appPaused = true; transition(at: event.at, from: old)
            case (.resumed, appId):
                appPaused = false; transition(at: event.at, from: old)
            case (.pausedAll, nil):
                if global == nil { global = .all }
                transition(at: event.at, from: old)
            case (.stopped, nil):
                global = .system(event.detail); transition(at: event.at, from: old)
            case (.resumedAll, nil):
                global = nil; transition(at: event.at, from: old)
            // A session start also ends a Pause all or forced stop left open by older history: sessions replaced both.
            case (.sessionStarted, appId):
                live = true; stopped = nil; global = nil; appPaused = false; transition(at: event.at, from: old)
            case (.sessionEnded, appId):
                live = false; stopped = event.detail; transition(at: event.at, from: old)
            default:
                break
            }
        }
        return sessions
    }

    /// Local midnight to `now`, the "today" window.
    static func today(now: Date = Date(), calendar: Calendar = .current) -> ClosedRange<Int64> {
        Int64(calendar.startOfDay(for: now).timeIntervalSince1970 * 1000)...Int64(now.timeIntervalSince1970 * 1000)
    }

    /// Today's track range: local midnight onwards, open-ended. It is stable through the day, unlike `today()`, so a
    /// track keyed on it reloads only when points arrive or upload, not on every re-render (#648).
    static func todayTrack(now: Date = Date(), calendar: Calendar = .current) -> ClosedRange<Int64> {
        today(now: now, calendar: calendar).lowerBound...Int64.max
    }
}
