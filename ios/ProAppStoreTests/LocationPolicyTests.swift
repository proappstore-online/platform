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
