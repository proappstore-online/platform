import Foundation

/// One app's collection session (ADR-020): started by a tap in the companion, ended by Stop,
/// `LocationPolicy.STATIONARY_TIMEOUT_MS` without movement, `LocationPolicy.MAX_SESSION_MS`, or the end of its grant or
/// permission. Local to the phone. Ported from android SharingSession.kt; stored as the same JSON.
struct Session: Codable, Equatable {
    let appId: String
    let startedAt: Int64
    var lastMovedAt: Int64
}

/// The session rules. Pure, so they are unit-tested off-device.
enum SharingSessions {
    /// An automatic end. The raw value is the `session_ended` row's detail.
    enum EndReason: String { case stationary, maxLength = "max" }

    /// The automatic end due at `now`, or nil while the session may run. The 12-hour cap wins over the stationary end.
    static func endReason(_ s: Session, now: Int64) -> EndReason? {
        if now - s.startedAt >= LocationPolicy.MAX_SESSION_MS { return .maxLength }
        if now - s.lastMovedAt >= LocationPolicy.STATIONARY_TIMEOUT_MS { return .stationary }
        return nil
    }

    /// Whether an emitted point is movement (§3): it moved the emit threshold (#639). The first point, a heartbeat and the
    /// first precise fix after a stationary spell are not. While still, `.moved` already means at least 100 m.
    static func isMovement(_ reason: EmitFilter.Reason) -> Bool { reason == .moved }

    /// Whether `appId` keeps its session when one of its capabilities is turned off: it still has another enabled one
    /// (#677, Android #668). Turning a capability off never starts or resumes another, and never stops one that is left.
    static func keepsSession(_ appId: String, apps: [ConnectedApp], entries: [NativeEntry], blocked: Set<String>) -> Bool {
        apps.contains { $0.id == appId && $0.grantId != nil && !blocked.contains($0.id) } ||
            entries.contains { $0.appId == appId && $0.capability != NativeEntry.LOCATION && $0.grantId != nil && !blocked.contains($0.key) }
    }

    /// The app (and capability) a `proappstore://native/apps/<appId>[/<capability>]` link names, or nil. A link only
    /// selects an app (ADR-020 §2, ADR-018 §9): it never grants or starts anything.
    static func linkedApp(_ url: URL) -> (appId: String, capability: String?)? {
        guard url.scheme == "proappstore", url.host == "native", url.query == nil, url.fragment == nil else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2 || parts.count == 3, parts[0] == "apps", parts.dropFirst().allSatisfy(valid) else { return nil }
        return (parts[1], parts.count == 3 ? parts[2] : nil)
    }

    private static func valid(_ id: String) -> Bool {
        (1...64).contains(id.count) && id.unicodeScalars.allSatisfy { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || "._-".contains(Character($0)) }
    }

    static func encode(_ sessions: [Session]) -> String { String(decoding: (try? JSONEncoder().encode(sessions)) ?? Data("[]".utf8), as: UTF8.self) }
    static func decode(_ json: String?) -> [Session] { json.flatMap { try? JSONDecoder().decode([Session].self, from: Data($0.utf8)) } ?? [] }

    /// The settings Pause all and the per-app pause list (#620) used, both named `paused…`. Retired by ADR-020 §9.
    static func retired(_ key: String) -> Bool { key.hasPrefix("paused") }

    /// First open after sessions: drops both pause settings among `keys` through `remove`. No session is created; the
    /// user starts each one.
    static func migrate(_ keys: [String], remove: (String) throws -> Void) rethrows {
        for key in keys where retired(key) { try remove(key) }
    }

    /// "Stopped sharing with Run: no movement for 30 minutes", Android's wording (§4). From the constants' labels, not
    /// their values.
    static func endedText(_ appName: String, _ reason: EndReason) -> String {
        "Stopped sharing with \(appName): " + (reason == .stationary ? "no movement for 30 minutes" : "12 hours reached")
    }
}
