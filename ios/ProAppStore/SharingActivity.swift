import ActivityKit
import Foundation

/// Keeps the Lock Screen activity (#625) equal to the sessions that may collect now. Called after every
/// `LocationCollector.evaluate()`, which every Start, Stop, automatic end, permission change and fix passes through.
/// A request succeeds only with the app in the foreground, which a Start always is; iOS removes an activity after about
/// 8 hours, and the next open shows it again. A background relaunch has no live sessions (ADR-020 §7), so it ends a
/// leftover activity rather than show sharing that is not running.
@MainActor
final class SharingActivity {
    private var current: Activity<SharingActivityAttributes>?

    init() { current = Activity<SharingActivityAttributes>.activities.first }

    /// The activity's content for `sessions`, or nil when none runs. Names come from `names` by app id.
    nonisolated static func content(_ sessions: [Session], names: [String: String]) -> SharingActivityAttributes.ContentState? {
        let ordered = sessions.sorted { ($0.startedAt, $0.appId) < ($1.startedAt, $1.appId) }
        guard let first = ordered.first else { return nil }
        return .init(apps: ordered.map { names[$0.appId] ?? $0.appId }, since: Date(timeIntervalSince1970: Double(first.startedAt) / 1000))
    }

    func show(_ state: SharingActivityAttributes.ContentState?) {
        guard let state else { return end() }
        if let current, current.activityState == .active {
            if current.content.state != state { Task { await current.update(.init(state: state, staleDate: nil)) } }
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        current = try? Activity.request(attributes: SharingActivityAttributes(), content: .init(state: state, staleDate: nil))
    }

    private func end() {
        current = nil
        for activity in Activity<SharingActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
