import Foundation

/// Pure consent and fix-quality rules, ported from android Models.kt `LocationPolicy`.
enum LocationPolicy {
    static let RETENTION_MS: Int64 = 7 * 24 * 60 * 60 * 1000
    static let MAX_QUEUE = 60_000
    /// On-device sharing history (#621): kept 30 days, capped at about 20-30 MB worst case.
    static let HISTORY_MS: Int64 = 30 * 24 * 60 * 60 * 1000
    static let HISTORY_MAX_POINTS = 200_000
    /// Oldest fix accepted. Android uses 15 s; iOS delivers batches whose older entries are real
    /// route samples, so freshness is relative to the last accepted fix instead (ADR-016).
    static let MAX_FIX_AGE_MS: Int64 = 120_000

    static func valid(_ point: TrackPoint, now: Int64, lastFixAt: Int64) -> Bool {
        point.at > lastFixAt && point.at >= now - MAX_FIX_AGE_MS && point.at <= now + 2_000 &&
            point.lat.isFinite && (-90.0...90.0).contains(point.lat) &&
            point.lng.isFinite && (-180.0...180.0).contains(point.lng) &&
            point.accuracy.isFinite && (0.0...100.0).contains(point.accuracy) && !point.grants.isEmpty
    }

    static func recipients(_ apps: [ConnectedApp], blocked: Set<String>, at: Int64) -> [String] {
        apps.filter { !blocked.contains($0.id) && $0.grantId != nil && at >= $0.consentAt }.compactMap(\.grantId)
    }
}
