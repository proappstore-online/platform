import ActivityKit
import AppIntents
import Foundation

/// The Lock Screen activity while ProAppStore shares (#625, ADR-020 §5). Compiled into the app and the widget extension.
/// It carries app names and a start time only: never a location.
struct SharingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// The names of the apps with a session, oldest session first.
        var apps: [String]
        /// The oldest session's start, for the elapsed time.
        var since: Date
    }
}

/// The activity's single Stop: ends every session, like the Android notification's Stop and Stop all (ADR-020 §5).
/// A LiveActivityIntent runs in the app's process, so it writes the app's own store; no App Group is shared with the
/// extension. It never touches a grant, consent or the queue (§9).
struct StopSharingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop sharing"
    static let description = IntentDescription("Stops every ProAppStore sharing session.")

    /// Set by the app's model; the extension never runs `perform`.
    @MainActor static var stopAll: () -> Void = {}

    func perform() async throws -> some IntentResult {
        await MainActor.run { Self.stopAll() }
        return .result()
    }
}
