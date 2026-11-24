import CoreBluetooth
import CoreLocation
import UserNotifications
import XCTest
@testable import ProAppStore

/// #660: the diagnostics snapshot's whitelist and size, the heart-rate code, and the send and delete flow inside sync.
final class DiagnosticsTests: XCTestCase {
    private let secure = SecureStore(service: "online.proappstore.companion.diagnosticstests")
    private var directory: URL!
    private var local: LocalStore!
    private var api: PasApi!
    private let now: Int64 = 1_800_000_000_000
    private static let device = DiagnosticsDevice(os: "iOS 18.0", location: "whenInUse", precise: true, bluetooth: "allowed",
                                                  notifications: "allowed", collecting: true, heartRateConnected: true)
    private let hrEntry: [String: Any] = ["appId": "run", "appName": "Run", "capability": "heart_rate.ble", "name": "Heart rate", "purpose": "p",
                                          "disclosure": "d", "version": "hv", "grant": ["id": "hr1", "consent_at": 1]]
    private var me: [String: Any] {
        ["user": ["id": "u1", "name": "Alex"], "device": ["id": "d1", "label": "iPhone", "expiresAt": 1],
         "apps": [["id": "run", "name": "Run", "version": "v", "purpose": "Routes", "disclosure": "D", "grant": ["id": "g1", "consent_at": 1]]],
         "capabilities": [hrEntry]]
    }

    override func setUpWithError() throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        api = PasApi(configuration: configuration)
        StubProtocol.seen = []
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        local = try LocalStore(directory: directory)
        try secure.clear()
    }

    override func tearDownWithError() throws {
        try secure.clear()
        local.close()
        try? FileManager.default.removeItem(at: directory)
    }

    /// Signed in, Run's location and heart rate granted, a Run session, one real queued point and heart-rate sample, and
    /// the main-actor state provider installed. `diagnostics` answers `/native/diagnostics`.
    private func connected(diagnostics: StubProtocol.Stub = .init(json: ["receivedAt": 1])) throws -> CompanionRepository {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        try local.saveApps(try JSONSerialization.data(withJSONObject: me["apps"]!))
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [hrEntry]))
        try local.startSession("run")
        let at = CompanionRepository.now()
        try local.enqueue(TrackPoint(id: "p", at: at, lat: 47.376887, lng: -8.541694, accuracy: 4.2, grants: ["g1"]))
        try local.enqueueHeartRate(HeartRateSample(id: "h", at: at, bpm: 142, grants: ["hr1"]))
        respond(diagnostics: diagnostics)
        let repository = CompanionRepository(local: local, secure: secure, api: api)
        repository.diagnosticsDevice = { Self.device }
        return repository
    }

    private func respond(diagnostics: StubProtocol.Stub, offline: Bool = false) {
        StubProtocol.handler = { [me] request in
            if offline { return .init(offline: true) }
            switch request.url!.path {
            case "/v1/native/me": return .init(json: me)
            case "/v1/native/locations": return .init(json: ["acknowledged": ["p"]])
            case "/v1/native/heart-rate": return .init(json: ["acknowledged": ["h"]])
            case "/v1/native/diagnostics": return diagnostics
            default: return .init(status: 404)
            }
        }
    }

    private var calls: [String] { StubProtocol.seen.map { "\($0.httpMethod!) \($0.url!.path)" } }
    private var diagnosticsCalls: [String] { calls.filter { $0.hasSuffix("/native/diagnostics") } }

    private func input(activity: [ActivityRow] = [], sessionEnds: [ActivityRow] = [], lastSyncError: String = "") -> DiagnosticsInput {
        DiagnosticsInput(now: now, version: "1.4.0", build: "57", device: Self.device, entries: [], blocked: ["ski", "run/heart_rate.ble"],
                         expired: false, sessions: [Session(appId: "run", startedAt: now - 600_000, lastMovedAt: now - 60_000)],
                         heartRateSensor: true, queue: 12, heartRateQueue: 340, lastSync: now - 15_000, lastSyncAttempt: now - 15_000,
                         lastSyncError: lastSyncError, heartRateLastUpload: 0, heartRateSyncError: "", sessionEnds: sessionEnds, activity: activity)
    }

    private func keys(_ value: Any, into out: inout Set<String>) {
        if let object = value as? [String: Any] { for (key, child) in object { out.insert(key); keys(child, into: &out) } }
        if let array = value as? [Any] { for child in array { keys(child, into: &out) } }
    }

    // MARK: The snapshot

    /// Built from a store holding a real queued point and heart-rate sample: counts only, no sample data.
    func testSnapshotHasNoSamplesOrCoordinates() throws {
        let repository = try connected()
        try local.record(.syncFailed, detail: "0 The Internet connection appears to be offline.")
        try local.endSession("run", detail: "stationary")
        let snapshot = Diagnostics.build(try repository.diagnosticsInput(Self.device, now: CompanionRepository.now()))
        let json = String(decoding: Diagnostics.encode(snapshot), as: UTF8.self)
        var names = Set<String>()
        keys(snapshot, into: &names)
        for banned in ["lat", "lng", "bpm", "points", "samples"] { XCTAssertFalse(names.contains(banned), banned) }
        XCTAssertNil(json.range(of: #"-?\d{1,3}\.\d{4,}"#, options: .regularExpression), json)
        XCTAssertEqual(snapshot["v"] as? Int, 1)
        XCTAssertEqual((snapshot["app"] as? [String: Any])?["platform"] as? String, "ios")
        XCTAssertEqual(snapshot["queue"] as? [String: Int], ["location": 1, "heartRate": 1])
        let collection = try XCTUnwrap(snapshot["collection"] as? [String: Any])
        XCTAssertEqual((collection["lastEnded"] as? [[String: Any]])?.first?["reason"] as? String, "stationary")
        XCTAssertEqual((snapshot["activity"] as? [[String: Any]])?.map { $0["kind"] as? String }, ["session_ended", "sync_failed", "session_started"])
        XCTAssertEqual((snapshot["sensors"] as? [String: String])?["location"], "collecting")
        XCTAssertEqual((snapshot["sensors"] as? [String: String])?["heartRate"], "no_session", "the session just ended")
    }

    func testFieldsFollowTheContract() {
        let snapshot = Diagnostics.build(input())
        XCTAssertEqual((snapshot["collection"] as? [String: Any])?["pendingRevocations"] as? [String], ["run/heart_rate.ble", "ski"])
        let sync = snapshot["sync"] as? [String: Any]
        XCTAssertEqual(sync?["lastSuccessAt"] as? Int64, now - 15_000)
        XCTAssertTrue((sync?["heartRate"] as? [String: Any])?["lastUploadAt"] is NSNull, "0 is null")
        XCTAssertEqual((snapshot["sensors"] as? [String: String])?["heartRate"], "off", "no heart-rate entry")
        var idle = input(); idle.sessions = []; idle.device.collecting = false
        XCTAssertEqual((Diagnostics.build(idle)["sensors"] as? [String: String])?["location"], "idle")
        var stopped = input(); stopped.device.collecting = false
        XCTAssertEqual((Diagnostics.build(stopped)["sensors"] as? [String: String])?["location"], "stopped")
    }

    func testTwoHundredMaximalEventsStayUnderTheCapAndKeepTheNewest() throws {
        let appId = "a" + String(repeating: "b", count: 57)
        let ascii = Diagnostics.build(input(activity: (0..<200).map { ActivityRow(at: now - Int64($0) * 1_000, appId: appId, kind: String(repeating: "k", count: 32), detail: String(repeating: "\"", count: 120)) }))
        XCTAssertLessThanOrEqual(Diagnostics.encode(ascii).count, Diagnostics.MAX_BYTES)
        XCTAssertEqual((ascii["activity"] as? [[String: Any]])?.first?["at"] as? Int64, now)
        // Two-byte characters push 200 events past the cap.
        let events = (0..<200).map { ActivityRow(at: now - Int64($0) * 1_000, appId: appId, kind: String(repeating: "k", count: 32), detail: String(repeating: "é", count: 120)) }
        let snapshot = Diagnostics.build(input(activity: events, lastSyncError: String(repeating: "x", count: 500)))
        XCTAssertLessThanOrEqual(Diagnostics.encode(snapshot).count, Diagnostics.MAX_BYTES)
        let activity = try XCTUnwrap(snapshot["activity"] as? [[String: Any]])
        XCTAssertGreaterThan(activity.count, 0, "some events fit")
        XCTAssertLessThan(activity.count, 200, "the cap dropped some")
        XCTAssertEqual(activity.map { $0["at"] as? Int64 }, (0..<activity.count).map { now - Int64($0) * 1_000 }, "the newest, in order")
        XCTAssertEqual(((snapshot["sync"] as? [String: Any])?["lastError"] as? String)?.count, 120)
    }

    func testEventsOlderThanSevenDaysOrWithBadKindsAreLeftOut() {
        let snapshot = Diagnostics.build(input(activity: [
            ActivityRow(at: now - 1, appId: nil, kind: "quota", detail: "429"),
            ActivityRow(at: now - 2, appId: nil, kind: "Not-A-Kind", detail: ""),
            ActivityRow(at: now - Diagnostics.WINDOW_MS - 1, appId: nil, kind: "quota", detail: "429"),
        ]))
        let activity = snapshot["activity"] as? [[String: Any]]
        XCTAssertEqual(activity?.count, 1)
        XCTAssertTrue(activity?.first?["appId"] is NSNull)
    }

    func testLastEndedPicksTheLatestPerApp() {
        let rows = [
            ActivityRow(at: 100, appId: "run", kind: "session_ended", detail: "user"), ActivityRow(at: 300, appId: "run", kind: "session_ended", detail: "stationary"),
            ActivityRow(at: 200, appId: "run", kind: "session_ended", detail: "max"), ActivityRow(at: 150, appId: "ski", kind: "session_ended", detail: "grant"),
            ActivityRow(at: 400, appId: "ski", kind: "session_ended", detail: "Not A Code"),
        ]
        XCTAssertEqual(Diagnostics.lastEnded(rows), [ActivityRow(at: 300, appId: "run", kind: "session_ended", detail: "stationary"),
                                                    ActivityRow(at: 150, appId: "ski", kind: "session_ended", detail: "grant")])
    }

    /// The Heart rate line's order (HeartRateViews.swift): the full queue is checked before Bluetooth.
    func testHeartRateStateTable() throws {
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [hrEntry]))
        let hr = try XCTUnwrap(local.entries().first)
        var ungranted = hrEntry; ungranted["grant"] = NSNull()
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [ungranted]))
        let noGrant = try XCTUnwrap(local.entries().first)
        func state(entries: [NativeEntry]? = nil, blocked: Set<String> = [], expired: Bool = false, sessions: Set<String> = ["run"],
                   sensor: Bool = true, bluetooth: String = "allowed", queued: Int = 0, connected: Bool = true) -> String {
            Diagnostics.heartRateState(entries: entries ?? [hr], blocked: blocked, expired: expired, sessions: sessions, sensor: sensor,
                                       bluetooth: bluetooth, queued: queued, connected: connected)
        }
        XCTAssertEqual(state(entries: []), "off")
        XCTAssertEqual(state(entries: [noGrant]), "off")
        XCTAssertEqual(state(blocked: [hr.key]), "off")
        XCTAssertEqual(state(expired: true), "off")
        XCTAssertEqual(state(sessions: []), "no_session")
        XCTAssertEqual(state(sensor: false), "no_sensor")
        XCTAssertEqual(state(queued: HeartRatePolicy.MAX_QUEUE), "queue_full")
        XCTAssertEqual(state(bluetooth: "off", queued: HeartRatePolicy.MAX_QUEUE), "queue_full", "iOS's line order")
        XCTAssertEqual(state(bluetooth: "off"), "bluetooth_off")
        XCTAssertEqual(state(bluetooth: "denied"), "bluetooth_denied")
        XCTAssertEqual(state(connected: false), "not_connected")
        XCTAssertEqual(state(bluetooth: "unsupported", connected: false), "not_connected")
        XCTAssertEqual(state(), "connected")
        for code in ["off", "no_session", "no_sensor", "queue_full", "bluetooth_off", "bluetooth_denied", "not_connected", "connected"] {
            XCTAssertNotNil(code.range(of: "^[a-z_]{1,24}$", options: .regularExpression), code)
        }
    }

    func testPermissionVocabulary() {
        XCTAssertEqual(Diagnostics.location(.notDetermined), "notDetermined")
        XCTAssertEqual(Diagnostics.location(.restricted), "denied")
        XCTAssertEqual(Diagnostics.location(.denied), "denied")
        XCTAssertEqual(Diagnostics.location(.authorizedWhenInUse), "whenInUse")
        XCTAssertEqual(Diagnostics.location(.authorizedAlways), "always")
        XCTAssertEqual(Diagnostics.bluetooth(.notDetermined, .unknown), "notDetermined")
        XCTAssertEqual(Diagnostics.bluetooth(.denied, .unauthorized), "denied")
        XCTAssertEqual(Diagnostics.bluetooth(.restricted, .unknown), "denied")
        XCTAssertEqual(Diagnostics.bluetooth(.allowedAlways, .poweredOff), "off")
        XCTAssertEqual(Diagnostics.bluetooth(.allowedAlways, .unsupported), "unsupported")
        XCTAssertEqual(Diagnostics.bluetooth(.allowedAlways, .poweredOn), "allowed")
        XCTAssertEqual(Diagnostics.notifications(.notDetermined), "notDetermined")
        XCTAssertEqual(Diagnostics.notifications(.denied), "denied")
        XCTAssertEqual(Diagnostics.notifications(.provisional), "allowed")
        XCTAssertEqual(Diagnostics.notifications(.authorized), "allowed")
    }

    func testFingerprintIgnoresQueueAndSyncTimes() {
        let a = Diagnostics.build(input())
        var later = input(); later.now += 5; later.queue = 99; later.lastSync = now; later.lastSyncAttempt = now; later.heartRateLastUpload = now
        XCTAssertEqual(Diagnostics.fingerprint(a), Diagnostics.fingerprint(Diagnostics.build(later)))
        XCTAssertNotEqual(Diagnostics.fingerprint(a), Diagnostics.fingerprint(Diagnostics.build(input(lastSyncError: "429"))))
    }

    func testThrottle() {
        XCTAssertTrue(Diagnostics.due(sentAt: 0, lastFingerprint: "", fingerprint: "a", now: now))
        XCTAssertFalse(Diagnostics.due(sentAt: now, lastFingerprint: "a", fingerprint: "a", now: now + 60_000), "no change")
        XCTAssertFalse(Diagnostics.due(sentAt: now, lastFingerprint: "a", fingerprint: "b", now: now + 59_999), "a change waits 60 s")
        XCTAssertTrue(Diagnostics.due(sentAt: now, lastFingerprint: "a", fingerprint: "b", now: now + 60_000))
        XCTAssertTrue(Diagnostics.due(sentAt: now, lastFingerprint: "a", fingerprint: "a", now: now + Diagnostics.REFRESH_MS), "15 minutes regardless")
    }

    // MARK: Inside sync

    func testSyncSendsOnceThenThrottles() async throws {
        let repository = try connected()
        try await repository.sync()
        XCTAssertEqual(calls, ["GET /v1/native/me", "POST /v1/native/locations", "POST /v1/native/heart-rate", "PUT /v1/native/diagnostics"], "last, after both stages")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.read(try XCTUnwrap(StubProtocol.seen.last?.httpBodyStream))) as? [String: Any])
        XCTAssertEqual(Array(body.keys), ["snapshot"])
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(local.diagnosticsLastSnapshot.utf8)) as? NSDictionary)
        XCTAssertEqual(stored, body["snapshot"] as? NSDictionary, "the exact report sent is the one shown")
        XCTAssertGreaterThan(local.diagnosticsSentAt, 0)
        XCTAssertFalse(local.diagnosticsFingerprint.isEmpty)
        StubProtocol.seen = []
        try await repository.sync()
        XCTAssertEqual(diagnosticsCalls, [], "not again within 60 s")
    }

    func testTurningOffDeletesFirstAndKeepsTheFlagUntilA2xx() async throws {
        let repository = try connected()
        try await repository.sync()
        try local.setDiagnostics(false)
        XCTAssertTrue(local.diagnosticsDeletePending)
        StubProtocol.seen = []
        respond(diagnostics: .init(), offline: true)
        do { try await repository.sync(); XCTFail("offline fails the sync") } catch {}
        XCTAssertEqual(calls.first, "DELETE /v1/native/diagnostics", "first, before anything else")
        XCTAssertTrue(local.diagnosticsDeletePending, "a network error keeps the flag")
        StubProtocol.seen = []
        respond(diagnostics: .init(json: ["deleted": true]))
        try await repository.sync()
        XCTAssertEqual(calls.first, "DELETE /v1/native/diagnostics")
        XCTAssertEqual(diagnosticsCalls, ["DELETE /v1/native/diagnostics"], "off sends no report")
        XCTAssertFalse(local.diagnosticsDeletePending)
        StubProtocol.seen = []
        try await repository.sync()
        XCTAssertEqual(diagnosticsCalls, [], "nothing pending, nothing sent")
    }

    func testTurningBackOnSendsAtOnce() async throws {
        let repository = try connected()
        try await repository.sync()
        try local.setDiagnostics(false)
        try local.setDiagnostics(true)
        XCTAssertFalse(local.diagnosticsDeletePending)
        StubProtocol.seen = []
        try await repository.sync()
        XCTAssertEqual(diagnosticsCalls, ["PUT /v1/native/diagnostics"], "the throttle is reset")
    }

    func testAServerErrorOnThePutIsInvisibleToTheSync() async throws {
        let repository = try connected(diagnostics: .init(status: 500, json: ["error": "boom"]))
        try await repository.sync()
        XCTAssertEqual(diagnosticsCalls, ["PUT /v1/native/diagnostics"])
        XCTAssertEqual(local.lastSyncError, "")
        XCTAssertEqual(local.heartRateSyncError, "")
        XCTAssertEqual(local.message, "")
        XCTAssertFalse(try local.events().contains { $0.kind == .syncFailed }, "no sync_failed row")
        XCTAssertEqual(local.diagnosticsSentAt, 0, "not recorded as sent, so the next sync tries again")
        XCTAssertEqual(local.diagnosticsLastSnapshot, "")
    }

    /// A failed upload still sends the report, and the sync's own failure is what is thrown.
    func testAFailedUploadStillSendsTheReport() async throws {
        let repository = try connected()
        let handler = StubProtocol.handler
        StubProtocol.handler = { request in
            request.url!.path == "/v1/native/locations" ? .init(status: 429, json: ["error": "Upload limit reached. Retry later."]) : handler(request)
        }
        do { try await repository.sync(); XCTFail("429 fails the sync") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 429) }
        XCTAssertEqual(calls.last, "PUT /v1/native/diagnostics")
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(local.diagnosticsLastSnapshot.utf8)) as? [String: Any])
        XCTAssertEqual((stored["sync"] as? [String: Any])?["lastError"] as? String, "Upload limit reached. Retry later.")
    }

    func testARevokedCredentialOnThePutTakesTheExpiryPath() async throws {
        let repository = try connected(diagnostics: .init(status: 401, json: ["error": "Device connection expired or was disconnected."]))
        do { try await repository.sync(); XCTFail("401 must fail") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 401) }
        XCTAssertTrue(local.expired)
        XCTAssertNil(repository.token())
    }

    func testWithoutAProviderNothingIsSentButADeleteStillGoes() async throws {
        let repository = try connected()
        repository.diagnosticsDevice = nil
        try await repository.sync()
        XCTAssertEqual(diagnosticsCalls, [])
        try local.setDiagnostics(false)
        try await repository.sync()
        XCTAssertEqual(diagnosticsCalls, ["DELETE /v1/native/diagnostics"])
    }

    func testClearingKeepsTheChoiceAndResetsTheRest() async throws {
        let repository = try connected()
        try await repository.sync()
        try local.setDiagnostics(false)
        for clear in [local.clear, local.clearForReconnect] {
            try clear()
            XCTAssertFalse(local.diagnosticsEnabled, "the user's choice")
            XCTAssertFalse(local.diagnosticsDeletePending)
            XCTAssertEqual(local.diagnosticsSentAt, 0)
            XCTAssertEqual(local.diagnosticsFingerprint, "")
            XCTAssertEqual(local.diagnosticsLastSnapshot, "")
            try local.setDiagnostics(false)
        }
        try local.setDiagnostics(true)
        try local.clear()
        XCTAssertTrue(local.diagnosticsEnabled, "on by default and kept on")
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        return data
    }
}
