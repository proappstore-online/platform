import CoreLocation
import XCTest
@testable import ProAppStore

/// Port of android LocationPolicyTest.kt, with the iOS freshness rule (ADR-016).
final class LocationPolicyTests: XCTestCase {
    private let app = ConnectedApp(id: "ski", name: "Ski", purpose: "Routes", disclosure: "Disclosure", version: "1", grantId: "grant-one", consentAt: 1000)

    func testRecipientsRequireConsentAndRespectLocalRevocation() {
        XCTAssertEqual(LocationPolicy.recipients([app], blocked: [], at: 999), [])
        XCTAssertEqual(LocationPolicy.recipients([app], blocked: [], at: 1000), ["grant-one"])
        XCTAssertEqual(LocationPolicy.recipients([app], blocked: ["ski"], at: 1001), [])
        let ungranted = ConnectedApp(id: "ski", name: "Ski", purpose: "Routes", disclosure: "Disclosure", version: "1", grantId: nil, consentAt: 1000)
        XCTAssertEqual(LocationPolicy.recipients([ungranted], blocked: [], at: 1001), [])
    }

    func testGpsMustBeFreshAccurateAndHaveRecipients() {
        let now: Int64 = 200_000
        let p = TrackPoint(id: "point", at: now, lat: -36.4, lng: 148.4, accuracy: 5, grants: ["grant-one"])
        func with(at: Int64? = nil, lat: Double? = nil, lng: Double? = nil, accuracy: Double? = nil, grants: [String]? = nil) -> TrackPoint {
            TrackPoint(id: p.id, at: at ?? p.at, lat: lat ?? p.lat, lng: lng ?? p.lng, accuracy: accuracy ?? p.accuracy, grants: grants ?? p.grants)
        }
        XCTAssertTrue(LocationPolicy.valid(p, now: now, lastFixAt: 0))
        XCTAssertFalse(LocationPolicy.valid(with(at: now - 120_001), now: now, lastFixAt: 0))
        XCTAssertFalse(LocationPolicy.valid(with(at: now + 2_001), now: now, lastFixAt: 0))
        XCTAssertFalse(LocationPolicy.valid(with(lat: .nan), now: now, lastFixAt: 0))
        XCTAssertFalse(LocationPolicy.valid(with(lng: 181), now: now, lastFixAt: 0))
        XCTAssertFalse(LocationPolicy.valid(with(accuracy: 101), now: now, lastFixAt: 0))
        XCTAssertFalse(LocationPolicy.valid(with(accuracy: -1), now: now, lastFixAt: 0)) // CoreLocation: negative = invalid fix
        XCTAssertFalse(LocationPolicy.valid(with(grants: []), now: now, lastFixAt: 0))
    }

    /// didUpdateLocations can deliver several fixes at once. Older entries are real route samples, so they are
    /// kept (Android's 15 s rule would drop them), but only in order and never twice.
    func testBatchDeliveryKeepsOlderSamplesInOrder() {
        let now: Int64 = 1_000_000
        let batch = [now - 90_000, now - 60_000, now - 30_000, now].map {
            TrackPoint(id: "p\($0)", at: $0, lat: 1, lng: 2, accuracy: 5, grants: ["grant-one"])
        }
        var lastFixAt: Int64 = 0
        for point in batch {
            XCTAssertTrue(LocationPolicy.valid(point, now: now, lastFixAt: lastFixAt))
            lastFixAt = point.at
        }
        XCTAssertFalse(LocationPolicy.valid(batch[1], now: now, lastFixAt: lastFixAt)) // out of order / redelivered
        XCTAssertFalse(LocationPolicy.valid(batch[3], now: now, lastFixAt: lastFixAt)) // same timestamp
    }

    /// #620: with every granted app paused or revoked there is no recipient, which is the condition
    /// LocationCollector.evaluate() stops collection on.
    func testNoRecipientsWhenEveryGrantedAppIsExcluded() {
        let run = ConnectedApp(id: "run", name: "Run", purpose: "Routes", disclosure: "Disclosure", version: "1", grantId: "grant-two", consentAt: 1000)
        XCTAssertEqual(LocationPolicy.recipients([app, run], blocked: ["ski"], at: 2000), ["grant-two"])
        XCTAssertEqual(LocationPolicy.recipients([app, run], blocked: ["ski", "run"], at: 2000), [])
    }
}

/// #639: the stationary emit filter, on synthetic fixes.
final class EmitFilterTests: XCTestCase {
    private let home = CLLocationCoordinate2D(latitude: -33.87, longitude: 151.21)
    private let start = Date(timeIntervalSince1970: 1_763_850_000)

    /// A fix `east`/`north` metres from home, `seconds` after the start. Speed -1 = unknown, as CoreLocation reports it.
    private func fix(_ seconds: Double, east: Double = 0, north: Double = 0, accuracy: Double = 5, speed: Double = -1, speedAccuracy: Double = -1) -> CLLocation {
        let coordinate = CLLocationCoordinate2D(latitude: home.latitude + north / 111_320,
                                                longitude: home.longitude + east / (111_320 * cos(home.latitude * .pi / 180)))
        return CLLocation(coordinate: coordinate, altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1, course: -1, courseAccuracy: -1,
                          speed: speed, speedAccuracy: speedAccuracy, timestamp: start.addingTimeInterval(seconds))
    }

    /// Serge's evidence: 16 minutes indoors, accuracy 12–53 m. Here every 5 s with up to ±30 m of jitter on each axis.
    private func indoors(speed: Double, speedAccuracy: Double) -> [CLLocation] {
        var seed: UInt64 = 639
        func random() -> Double { seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407; return Double(seed >> 11) / Double(1 << 53) }
        return (0..<(16 * 12)).map { i in
            fix(Double(i) * 5, east: random() * 60 - 30, north: random() * 60 - 30, accuracy: 12 + random() * 41, speed: speed, speedAccuracy: speedAccuracy)
        }
    }

    private func reasons(_ fixes: [CLLocation], stationary: Bool = false) -> [EmitFilter.Reason] {
        var filter = EmitFilter()
        return fixes.compactMap { filter.accept($0, stationary: stationary) }
    }

    func testStationaryJitterEmitsOnlyHeartbeatsWhenMotionSaysStill() {
        XCTAssertEqual(reasons(indoors(speed: -1, speedAccuracy: -1), stationary: true), [.first, .heartbeat, .heartbeat, .heartbeat])
    }

    func testStationaryJitterEmitsOnlyHeartbeatsWhenDopplerSaysStill() {
        XCTAssertEqual(reasons(indoors(speed: 0.1, speedAccuracy: 0.4)), [.first, .heartbeat, .heartbeat, .heartbeat])
    }

    /// A 1 km walk at 1.4 m/s with 3 m accuracy, one fix per 5 m (the moving distance filter): about one point per 10 m.
    func testAPreciseWalkEmitsAboutOnePointPer10Metres() {
        let walk = (0...200).map { i in fix(Double(i) * 5 / 1.4, east: Double(i) * 5, accuracy: 3, speed: 1.4, speedAccuracy: 0.3) }
        var filter = EmitFilter()
        let emitted = walk.filter { filter.accept($0) != nil }
        XCTAssertEqual(emitted.count, 101)
        for (a, b) in zip(emitted, emitted.dropFirst()) { XCTAssertGreaterThanOrEqual(b.distance(from: a), 10 - 0.01) }
    }

    func testTheThresholdIsTheWorseAccuracyOfTheTwoFixes() {
        var filter = EmitFilter()
        XCTAssertEqual(filter.accept(fix(0, accuracy: 40)), .first)
        XCTAssertNil(filter.accept(fix(5, east: 35, accuracy: 5)))        // inside the anchor's 40 m
        XCTAssertNil(filter.accept(fix(10, east: 45, accuracy: 50)))      // inside its own 50 m
        XCTAssertEqual(filter.accept(fix(15, east: 45, accuracy: 5)), .moved)
        XCTAssertNil(filter.accept(fix(20, east: 52, accuracy: 3)))       // 7 m: under the 10 m floor
    }

    /// An unknown speed or speed accuracy (negative) is not evidence of standing still.
    func testOnlyAValidDopplerSpeedCountsAsStill() {
        for (speed, speedAccuracy) in [(-1.0, 0.5), (0.1, -1.0), (0.5, 0.5)] {
            var filter = EmitFilter()
            _ = filter.accept(fix(0))
            XCTAssertEqual(filter.accept(fix(5, east: 15, speed: speed, speedAccuracy: speedAccuracy)), .moved, "\(speed) \(speedAccuracy)")
        }
        var filter = EmitFilter()
        _ = filter.accept(fix(0))
        XCTAssertNil(filter.accept(fix(5, east: 15, speed: 0.2, speedAccuracy: 0.5)))
    }

    /// A still phone that ends up 100 m away has moved, so a missed motion update costs at most 100 m of track.
    func testAStillPhoneThatMoves100MetresIsMoving() {
        var filter = EmitFilter()
        _ = filter.accept(fix(0), stationary: true)
        XCTAssertNil(filter.accept(fix(30, east: 90), stationary: true))
        XCTAssertEqual(filter.accept(fix(60, east: 101), stationary: true), .moved)
    }

    /// After a stationary spell anchored on a coarse Wi-Fi heartbeat, the first precise fix restarts the track.
    func testMotionResumedEmitsTheNextPreciseFix() {
        var filter = EmitFilter()
        _ = filter.accept(fix(0, accuracy: 65), stationary: true)
        filter.motionResumed()
        XCTAssertNil(filter.accept(fix(5, east: 10, accuracy: 40)))
        XCTAssertEqual(filter.accept(fix(10, east: 15, accuracy: 6)), .resumed)
        XCTAssertNil(filter.accept(fix(15, east: 20, accuracy: 6)))   // anchored on the precise fix again
    }

    func testStationaryTurnsGpsOffAndKeepsFixesComingForTheHeartbeat() {
        XCTAssertEqual(LocationPolicy.tracking(stationary: true).accuracy, kCLLocationAccuracyHundredMeters)
        XCTAssertEqual(LocationPolicy.tracking(stationary: true).distanceFilter, kCLDistanceFilterNone)
        XCTAssertEqual(LocationPolicy.tracking(stationary: false).accuracy, kCLLocationAccuracyBest)
        XCTAssertEqual(LocationPolicy.tracking(stationary: false).distanceFilter, 5)
    }
}
