import XCTest
@testable import ProAppStore

/// ADR-020's collection sessions (#687), ported from android SharingSessionTest.kt: the end rules, movement, recipients,
/// the twin of #677, links and the pause migration.
final class SharingSessionTests: XCTestCase {
    private let min: Int64 = 60_000
    private let hour: Int64 = 3_600_000

    func testTheConstantsMatchAndroid() {
        XCTAssertEqual(LocationPolicy.STATIONARY_TIMEOUT_MS, 30 * min)
        XCTAssertEqual(LocationPolicy.MAX_SESSION_MS, 12 * hour)
    }

    func testStationaryEndsAtThirtyMinutesNotBefore() {
        let s = Session(appId: "run", startedAt: 0, lastMovedAt: 10 * min)
        XCTAssertNil(SharingSessions.endReason(s, now: 10 * min + 29 * min + 59_000))
        XCTAssertEqual(SharingSessions.endReason(s, now: 10 * min + 30 * min), .stationary)
    }

    func testNoFixAtAllCountsAsNoMovement() {
        XCTAssertEqual(SharingSessions.endReason(Session(appId: "run", startedAt: 0, lastMovedAt: 0), now: 30 * min), .stationary)
    }

    func testMaxLengthEndsAtTwelveHoursAndWinsWhenBothAreDue() {
        XCTAssertNil(SharingSessions.endReason(Session(appId: "run", startedAt: 0, lastMovedAt: 12 * hour - 1), now: 12 * hour - 1))
        XCTAssertEqual(SharingSessions.endReason(Session(appId: "run", startedAt: 0, lastMovedAt: 12 * hour), now: 12 * hour), .maxLength)
        XCTAssertEqual(SharingSessions.endReason(Session(appId: "run", startedAt: 0, lastMovedAt: 0), now: 12 * hour), .maxLength, "both due: max")
        XCTAssertEqual(SharingSessions.EndReason.maxLength.rawValue, "max")
        XCTAssertEqual(SharingSessions.EndReason.stationary.rawValue, "stationary")
    }

    func testOnlyAnEmittedMoveIsMovement() {
        XCTAssertTrue(SharingSessions.isMovement(.moved))
        for reason in [EmitFilter.Reason.first, .heartbeat, .resumed] { XCTAssertFalse(SharingSessions.isMovement(reason), "\(reason)") }
    }

    private let run = ConnectedApp(id: "run", name: "Run", purpose: "Runs", disclosure: "D", version: "1", grantId: "run-g")
    private let ski = ConnectedApp(id: "ski", name: "Ski", purpose: "Routes", disclosure: "D", version: "1", grantId: "ski-g")
    private func entry(_ capability: String, grant: String?) throws -> NativeEntry {
        let json: [String: Any] = ["appId": "run", "appName": "Run", "capability": capability, "name": "n", "purpose": "p", "disclosure": "d",
                                   "version": "1", "grant": grant.map { ["id": $0, "consent_at": 0] as [String: Any] } ?? NSNull()]
        return try JSONDecoder().decode(NativeEntry.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testRecipientsNeedASession() throws {
        let hr = try entry(HeartRate.CAPABILITY, grant: "run-hr")
        XCTAssertEqual(LocationPolicy.recipients([run, ski], blocked: [], sessions: [], at: 10), [])
        XCTAssertEqual(LocationPolicy.recipients([run, ski], blocked: [], sessions: ["ski"], at: 10), ["ski-g"])
        XCTAssertEqual(LocationPolicy.recipients([run, ski], blocked: ["ski"], sessions: ["ski"], at: 10), [], "disabled, with a session")
        XCTAssertEqual(HeartRatePolicy.recipients([hr], blocked: [], sessions: [], at: 10), [], "no session, no heart rate")
        XCTAssertEqual(HeartRatePolicy.recipients([hr], blocked: [], sessions: ["run"], at: 10), ["run-hr"])
    }

    /// #677: the session ends only when no capability is left, in both directions.
    func testKeepsSessionInBothDirections() throws {
        let loc = try entry(NativeEntry.LOCATION, grant: "run-g"), hr = try entry(HeartRate.CAPABILITY, grant: "run-hr")
        XCTAssertTrue(SharingSessions.keepsSession("run", apps: [run], entries: [loc, hr], blocked: ["run"]), "location off, heart rate on")
        XCTAssertTrue(SharingSessions.keepsSession("run", apps: [run], entries: [loc, hr], blocked: ["run/heart_rate.ble"]), "heart rate off, location on")
        XCTAssertFalse(SharingSessions.keepsSession("run", apps: [run], entries: [loc, hr], blocked: ["run", "run/heart_rate.ble"]), "both off")
        XCTAssertFalse(SharingSessions.keepsSession("run", apps: [run], entries: [loc, try entry(HeartRate.CAPABILITY, grant: nil)], blocked: ["run"]))
        XCTAssertFalse(SharingSessions.keepsSession("ski", apps: [ski], entries: [], blocked: ["ski"]), "location-only Ski")
    }

    func testLinkedApp() throws {
        func link(_ s: String) -> String? {
            SharingSessions.linkedApp(URL(string: s)!).map { [$0.appId, $0.capability].compactMap { $0 }.joined(separator: "/") }
        }
        XCTAssertEqual(link("proappstore://native/apps/run"), "run")
        XCTAssertEqual(link("proappstore://native/apps/ride-share_2/"), "ride-share_2")
        XCTAssertEqual(link("proappstore://native/apps/run/heart_rate.ble"), "run/heart_rate.ble")
        XCTAssertEqual(link("proappstore://native/apps/" + String(repeating: "a", count: 64)), String(repeating: "a", count: 64))
        for bad in ["proappstore://other/apps/run", "https://native/apps/run", "proappstore://native", "proappstore://native/apps/",
                    "proappstore://native/apps/run?start=1", "proappstore://native/apps/run/heart_rate.ble/x", "proappstore://native/connected",
                    "proappstore://native/apps/" + String(repeating: "a", count: 65), "proappstore://native/apps/r%C3%BCn"] {
            XCTAssertNil(link(bad), bad)
        }
    }

    func testEncodeDecodeRoundTrip() {
        let sessions = [Session(appId: "run", startedAt: 1, lastMovedAt: 2), Session(appId: "ski", startedAt: 3, lastMovedAt: 4)]
        XCTAssertEqual(SharingSessions.decode(SharingSessions.encode(sessions)), sessions)
        XCTAssertEqual(SharingSessions.decode(nil), [])
        // Android's JSON shape.
        XCTAssertEqual(SharingSessions.decode(#"[{"appId":"run","startedAt":5,"lastMovedAt":6}]"#), [Session(appId: "run", startedAt: 5, lastMovedAt: 6)])
    }

    func testMigrateDropsBothPauseSettingsAndCreatesNoSession() {
        var settings = ["paused": "0", "pausedApps": #"["run"]"#, "blocked": #"["ski"]"#, "apps": "[]"]
        SharingSessions.migrate(Array(settings.keys)) { settings[$0] = nil }
        XCTAssertEqual(Set(settings.keys), ["blocked", "apps"])
        XCTAssertEqual(SharingSessions.decode(settings["sessions"]), [])
        SharingSessions.migrate(Array(settings.keys)) { settings[$0] = nil } // idempotent
        XCTAssertEqual(Set(settings.keys), ["blocked", "apps"])
    }

    func testTheEndNoticeUsesAndroidsWording() {
        XCTAssertEqual(SharingSessions.endedText("Run", .stationary), "Stopped sharing with Run: no movement for 30 minutes")
        XCTAssertEqual(SharingSessions.endedText("Run", .maxLength), "Stopped sharing with Run: 12 hours reached")
    }
}
