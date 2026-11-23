import CoreLocation

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

    /// Fixes at this accuracy or better are drawn on the maps and restart a walk after a stationary spell (#639).
    static let PRECISE_M = 25.0

    /// CLLocationManager settings for the motion state (#639). Moving: best accuracy, a fix every 5 m. Stationary:
    /// GPS off (Wi-Fi accuracy) and no distance filter, so fixes keep coming for the heartbeat.
    static func tracking(stationary: Bool) -> (accuracy: CLLocationAccuracy, distanceFilter: CLLocationDistance) {
        stationary ? (kCLLocationAccuracyHundredMeters, kCLDistanceFilterNone) : (kCLLocationAccuracyBest, 5)
    }

    static func recipients(_ apps: [ConnectedApp], blocked: Set<String>, at: Int64) -> [String] {
        apps.filter { !blocked.contains($0.id) && $0.grantId != nil && at >= $0.consentAt }.compactMap(\.grantId)
    }
}

/// Which valid fixes become points (#639). With a bare 5 m distance filter, GPS jitter indoors (accuracy
/// 12–53 m) turned 16 stationary minutes into 39 points and a 366 m scribble. A fix is emitted when it is at least
/// `max(10 m, last emitted accuracy, its accuracy)` from the last emitted point, or 100 m while the phone is still
/// (a valid Doppler speed under 0.3 m/s, or CoreLocation's motion state). A heartbeat every 5 minutes tells apps the
/// phone is still there. Pure: fed fixes in delivery order.
struct EmitFilter {
    enum Reason: Equatable { case first, moved, heartbeat, resumed }

    static let MIN_DISTANCE_M = 10.0
    /// While still, only a move this large counts, so a missed "moving" signal costs at most this much track.
    static let STILL_DISTANCE_M = 100.0
    static let HEARTBEAT_MS: Int64 = 5 * 60_000
    static let STILL_SPEED = 0.3

    private var last: CLLocation?
    private var resumed = false

    /// Motion resumed after a stationary spell, whose heartbeats may be coarse Wi-Fi fixes: the next precise fix is
    /// emitted whatever the anchor, so a walk's start is not lost inside a coarse fix's radius.
    mutating func motionResumed() { resumed = true }

    /// `stationary`: the motion state says the phone is not moving.
    mutating func accept(_ fix: CLLocation, stationary: Bool = false) -> Reason? {
        let reason = decide(fix, stationary: stationary)
        if reason != nil { last = fix; resumed = false }
        return reason
    }

    private func decide(_ fix: CLLocation, stationary: Bool) -> Reason? {
        guard let last else { return .first }
        if fix.timestamp.timeIntervalSince(last.timestamp) * 1000 >= Double(Self.HEARTBEAT_MS) { return .heartbeat }
        if resumed && fix.horizontalAccuracy <= LocationPolicy.PRECISE_M { return .resumed }
        // CoreLocation reports an unknown speed or speed accuracy as negative.
        let still = stationary || (fix.speed >= 0 && fix.speedAccuracy >= 0 && fix.speed < Self.STILL_SPEED)
        let threshold = max(Self.MIN_DISTANCE_M, last.horizontalAccuracy, fix.horizontalAccuracy, still ? Self.STILL_DISTANCE_M : 0)
        return fix.distance(from: last) >= threshold ? .moved : nil
    }
}
