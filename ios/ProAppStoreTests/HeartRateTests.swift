import XCTest
@testable import ProAppStore

/// #631: the Heart Rate Measurement parser, the sample policy, the chart bucketing and the activity text. The parser
/// vectors are copied verbatim into android HeartRateTest.kt (#634); keep the two lists identical.
final class HeartRateTests: XCTestCase {
    private func parse(_ bytes: [UInt8]) -> (bpm: Int, contact: Bool?)? { HeartRateMeasurement.parse(Data(bytes)) }

    func testEightBitValue() throws {
        let r = try XCTUnwrap(parse([0x00, 72]))
        XCTAssertEqual(r.bpm, 72); XCTAssertNil(r.contact)
    }

    func testSixteenBitValue() throws {
        let r = try XCTUnwrap(parse([0x01, 0x8E, 0x00])) // 142, little-endian
        XCTAssertEqual(r.bpm, 142)
        XCTAssertEqual(try XCTUnwrap(parse([0x01, 0xFA, 0x00])).bpm, 250)
    }

    func testContactUnsupportedIsNil() throws {
        XCTAssertNil(try XCTUnwrap(parse([0x02, 90])).contact, "bit 1 without bit 2 means nothing")
    }

    func testContactSupportedDetectedAndNotDetected() throws {
        XCTAssertEqual(try XCTUnwrap(parse([0x06, 90])).contact, true)
        XCTAssertEqual(try XCTUnwrap(parse([0x04, 90])).contact, false)
    }

    func testEnergyAndRrPresentStillReadTheValue() throws {
        // flags: 8-bit, contact detected, energy expended (bit 3) and RR (bit 4): value, energy u16, two RR u16.
        let r = try XCTUnwrap(parse([0x1E, 131, 0x10, 0x00, 0x00, 0x02, 0x10, 0x02]))
        XCTAssertEqual(r.bpm, 131); XCTAssertEqual(r.contact, true)
        XCTAssertEqual(try XCTUnwrap(parse([0x19, 0x9B, 0x00, 0x10, 0x00, 0x00, 0x02])).bpm, 155)
    }

    func testShortOrOutOfRangeDataIsNil() {
        XCTAssertNil(parse([]))
        XCTAssertNil(parse([0x00]))
        XCTAssertNil(parse([0x01, 0x8E]), "16-bit flag with one value byte")
        XCTAssertNil(parse([0x00, 24]))
        XCTAssertNil(parse([0x01, 0xFB, 0x00]), "251")
        XCTAssertNil(parse([0x00, 0]))
        XCTAssertEqual(parse([0x00, 25])?.bpm, 25)
    }

    func testPolicyRejectsNoContactAndThrottlesToOneHertz() {
        var policy = HeartRatePolicy()
        XCTAssertFalse(policy.accept(contact: false, at: 0))
        XCTAssertTrue(policy.accept(contact: true, at: 0), "a rejected reading does not start the throttle")
        XCTAssertFalse(policy.accept(contact: true, at: 999))
        XCTAssertTrue(policy.accept(contact: nil, at: 1_000))
        XCTAssertFalse(policy.accept(contact: nil, at: 1_500))
        XCTAssertTrue(policy.accept(contact: true, at: 2_100))
    }

    private func entry(_ app: String, _ capability: String, grant: String?, consentAt: Int64 = 1) throws -> NativeEntry {
        let json: [String: Any] = ["appId": app, "appName": app, "capability": capability, "name": "n", "purpose": "p", "disclosure": "d",
                                   "version": "v", "grant": grant.map { ["id": $0, "consent_at": consentAt] as [String: Any] } ?? NSNull()]
        return try JSONDecoder().decode(NativeEntry.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testRecipientsAreHeartRateGrantsNotDisabledPausedOrBeforeConsent() throws {
        let entries = [try entry("run", "heart_rate.ble", grant: "hr"), try entry("run", "location.background", grant: "loc"),
                       try entry("other", "heart_rate.ble", grant: nil), try entry("late", "heart_rate.ble", grant: "late", consentAt: 50)]
        XCTAssertEqual(HeartRatePolicy.recipients(entries, blocked: [], pausedApps: [], at: 10), ["hr"])
        XCTAssertEqual(HeartRatePolicy.recipients(entries, blocked: [], pausedApps: [], at: 50), ["hr", "late"])
        XCTAssertEqual(HeartRatePolicy.recipients(entries, blocked: ["run"], pausedApps: [], at: 10), ["hr"], "location's key leaves heart rate")
        XCTAssertEqual(HeartRatePolicy.recipients(entries, blocked: ["run/heart_rate.ble"], pausedApps: [], at: 10), [])
        XCTAssertEqual(HeartRatePolicy.recipients(entries, blocked: [], pausedApps: ["run"], at: 10), [], "pausing Run pauses its heart rate (#620)")
    }

    func testEntryKeysAndGrantPathsStayUnderNative() throws {
        XCTAssertEqual(try entry("run", "location.background", grant: nil).key, "run")
        XCTAssertEqual(try entry("run", "heart_rate.ble", grant: nil).key, "run/heart_rate.ble")
        XCTAssertEqual(CompanionRepository.grantPath("run"), "/native/apps/run/location")
        XCTAssertEqual(CompanionRepository.grantPath("run/heart_rate.ble"), "/native/apps/run/capabilities/heart_rate.ble")
    }

    // MARK: Chart

    func testBucketsAverageAndBoundEachBucketAndKeepGaps() {
        let samples = [HeartRatePoint(at: 0, bpm: 100), HeartRatePoint(at: 5, bpm: 110), HeartRatePoint(at: 12, bpm: 120),
                       HeartRatePoint(at: 41, bpm: 150), HeartRatePoint(at: 100, bpm: 90), HeartRatePoint(at: 101, bpm: 200)]
        let b = HeartRateChart.buckets(samples, range: 0...100, count: 10)
        XCTAssertEqual(b.map(\.start), [0, 10, 40, 90])
        XCTAssertEqual(b[0], HeartRateBucket(start: 0, end: 10, min: 100, max: 110, mean: 105, segment: 0))
        XCTAssertEqual(b.map(\.segment), [0, 0, 1, 2], "an empty bucket breaks the line")
        XCTAssertEqual(b.last?.mean, 90, "the upper bound falls in the last bucket; a sample past it is ignored")
    }

    func testBucketsOfAnEmptyOrDegenerateRange() {
        XCTAssertEqual(HeartRateChart.buckets([], range: 0...100), [])
        XCTAssertEqual(HeartRateChart.buckets([HeartRatePoint(at: 5, bpm: 80)], range: 5...5), [])
        XCTAssertEqual(HeartRateChart.buckets([HeartRatePoint(at: 2, bpm: 80)], range: 0...3, count: 120).map(\.start), [2], "width never below 1 ms")
    }

    // MARK: Activity text

    private func sentence(_ kind: ShareEvent.Kind, _ detail: String, app: String? = "run") -> String {
        ActivityText.sentence(for: ShareEvent(id: 1, at: 0, appId: app, kind: kind, detail: detail), appName: app == nil ? nil : "Run")
    }

    func testHeartRateEventText() {
        XCTAssertEqual(sentence(.heartRate, "enabled"), "Run heart rate turned on")
        XCTAssertEqual(sentence(.heartRate, "disabled"), "Run heart rate turned off")
        XCTAssertEqual(sentence(.heartRate, "sensor_chosen", app: nil), "Heart-rate sensor chosen")
        XCTAssertEqual(sentence(.heartRate, "connected", app: nil), "Heart-rate sensor connected")
        XCTAssertEqual(sentence(.heartRate, "lost", app: nil), "Heart-rate sensor disconnected or out of range")
        XCTAssertEqual(sentence(.heartRate, "forgotten", app: nil), "Heart-rate sensor forgotten")
        XCTAssertEqual(sentence(.heartRateProblem, "queue_full", app: nil), "Heart-rate queue full: heart rate stopped until uploads catch up")
        XCTAssertEqual(sentence(.heartRateProblem, "400", app: nil), "Heart-rate upload rejected by ProAppStore (400)")
        XCTAssertEqual(sentence(.heartRateProblem, "partial_ack", app: nil), "Heart-rate upload not fully acknowledged: the copy on this phone was kept")
        XCTAssertEqual(sentence(.bluetooth, "off", app: nil), "Bluetooth turned off: heart rate stopped")
        XCTAssertEqual(sentence(.bluetooth, "unauthorized", app: nil), "Bluetooth permission denied: heart rate stopped")
        XCTAssertEqual(ActivityText.category(.heartRate), .sharing)
        XCTAssertEqual(ActivityText.category(.heartRateProblem), .problem)
        XCTAssertEqual(ActivityText.category(.bluetooth), .problem)
        XCTAssertEqual(HeartRateCollector.name(.poweredOff), "off")
        XCTAssertNil(HeartRateCollector.name(.resetting))
    }

    /// Heart-rate events never open, end or pause a location session.
    func testHeartRateEventsLeaveLocationSessionsAlone() {
        let events = [ShareEvent(id: 1, at: 10, appId: "run", kind: .enabled, detail: ""),
                      ShareEvent(id: 2, at: 20, appId: "run", kind: .heartRate, detail: "disabled"),
                      ShareEvent(id: 3, at: 30, appId: nil, kind: .bluetooth, detail: "off"),
                      ShareEvent(id: 4, at: 40, appId: "run", kind: .heartRate, detail: "enabled")]
        XCTAssertEqual(SharingTimeline.sessions(events, appId: "run"), [SharingSession(start: 10, end: nil, endKind: nil, inactive: [])])
    }
}
