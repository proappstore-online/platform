import XCTest
@testable import ProAppStore

/// Serves canned responses so PasApi and CompanionRepository run against no network.
final class StubProtocol: URLProtocol {
    struct Stub {
        var status = 200; var json: Any = [String: Any](); var redirect: URL?; var offline = false
        /// Sent as is instead of `json` (the catalogue tests need raw and malformed bodies), with `headers`.
        var body: Data?; var headers: [String: String] = [:]
    }
    nonisolated(unsafe) static var handler: (URLRequest) -> Stub = { _ in Stub() }
    nonisolated(unsafe) static var seen: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Self.seen.append(request)
        let stub = Self.handler(request)
        if stub.offline { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return }
        let headers = stub.headers.merging(stub.redirect.map { ["Location": $0.absoluteString] } ?? [:]) { $1 }
        let response = HTTPURLResponse(url: request.url!, statusCode: stub.status, httpVersion: "HTTP/1.1", headerFields: headers)!
        if let target = stub.redirect { client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response) }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body ?? (try! JSONSerialization.data(withJSONObject: stub.json)))
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class PasApiTests: XCTestCase {
    private let secure = SecureStore(service: "online.proappstore.companion.apitests")
    private var directory: URL!
    private var local: LocalStore!
    private var api: PasApi!
    private let me: [String: Any] = [
        "user": ["id": "u1", "name": "Alex"], "device": ["id": "d1", "label": "iPhone (iOS 18.0)", "expiresAt": 1],
        "apps": [["id": "ski", "name": "Ski", "capability": "location.background", "version": "v", "purpose": "Routes",
                  "disclosure": "Disclosure", "grant": ["id": "g1", "app_id": "ski", "consent_at": 1, "contract_version": "v", "publisher_id": "p"]]],
    ]

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

    /// Signed in, one granted app, collection on, two queued points.
    private func connected() async throws -> CompanionRepository {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        try local.saveApps(try JSONSerialization.data(withJSONObject: me["apps"]!))
        try local.setPaused(false)
        let now = CompanionRepository.now() // sync expires anything older than 7 days first
        try local.enqueue(TrackPoint(id: "a", at: now - 1_000, lat: 1, lng: 2, accuracy: 5, grants: ["g1"]))
        try local.enqueue(TrackPoint(id: "b", at: now, lat: 1, lng: 2, accuracy: 5, grants: ["g1"]))
        return CompanionRepository(local: local, secure: secure, api: api)
    }

    private func respond(me meStatus: Int = 200, locations: StubProtocol.Stub) {
        StubProtocol.handler = { [me] request in
            switch request.url!.path {
            case "/v1/native/me": return meStatus == 200 ? .init(json: me) : .init(status: meStatus, json: ["error": "Device connection expired or was disconnected."])
            case "/v1/native/locations": return locations
            default: return .init(status: 404)
            }
        }
    }

    func testOnlyNativePathsOnTheFixedOriginAreAllowed() {
        XCTAssertEqual(PasApi.endpoint("/native/me")?.absoluteString, "https://api.proappstore.online/v1/native/me")
        XCTAssertNil(PasApi.endpoint("/apps/ski/native/locations"))
        XCTAssertNil(PasApi.endpoint("/auth/session"))
        XCTAssertNil(PasApi.endpoint("native/me"))
    }

    func testRedirectIsRefused() async throws {
        StubProtocol.handler = { _ in .init(status: 302, redirect: URL(string: "https://attacker.example/steal")!) }
        do {
            _ = try await api.request("GET", "/native/me", token: "ndev_test")
            XCTFail("A redirect must not succeed")
        } catch let failure as ApiFailure {
            XCTAssertEqual(failure.status, 302)
        }
        XCTAssertEqual(StubProtocol.seen.map { $0.url!.host }, ["api.proappstore.online"])
    }

    func testPendingCompleteLeavesPairingPending() async throws {
        try secure.write(["pairId": String(repeating: "a", count: 64), "verifier": String(repeating: "b", count: 64)])
        StubProtocol.handler = { _ in .init(status: 202, json: ["pending": true]) }
        let repository = CompanionRepository(local: local, secure: secure, api: api)
        let finished = try await repository.finishSignIn()
        XCTAssertFalse(finished)
        XCTAssertNil(repository.token())
        XCTAssertEqual(repository.pairingCode(), "AAAAAAAA")
        XCTAssertEqual(StubProtocol.seen.map(\.url!.path), ["/v1/native/auth/complete"])
    }

    /// #645: a proof the server rejected is forgotten, so the next activation neither re-requests nor shows a stale code.
    func testRejectedPairingProofIsCleared() async throws {
        for status in [403, 409] {
            try secure.write(["pairId": String(repeating: "a", count: 64), "verifier": String(repeating: "b", count: 64)])
            StubProtocol.seen = []
            StubProtocol.handler = { _ in .init(status: status, json: ["error": "Invalid or expired connection."]) }
            let repository = CompanionRepository(local: local, secure: secure, api: api)
            do { _ = try await repository.finishSignIn(); XCTFail("\(status) must fail") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, status) }
            XCTAssertEqual(try secure.read(), [:])
            XCTAssertEqual(repository.pairingCode(), "")
            let finished = try await repository.finishSignIn()
            XCTAssertFalse(finished)
            XCTAssertEqual(StubProtocol.seen.count, 1, "no second request")
        }
    }

    /// A network failure or a server error keeps the proof: the pairing may still complete.
    func testTransientCompleteFailureKeepsThePairingProof() async throws {
        try secure.write(["pairId": String(repeating: "a", count: 64), "verifier": String(repeating: "b", count: 64)])
        let repository = CompanionRepository(local: local, secure: secure, api: api)
        for stub in [StubProtocol.Stub(offline: true), StubProtocol.Stub(status: 503), StubProtocol.Stub(status: 429)] {
            StubProtocol.handler = { _ in stub }
            do { _ = try await repository.finishSignIn(); XCTFail("must fail") } catch {}
            XCTAssertEqual(repository.pairingCode(), "AAAAAAAA")
        }
    }

    func testFullAcknowledgementEmptiesTheQueue() async throws {
        let repository = try await connected()
        respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
        try await repository.sync()
        XCTAssertEqual(StubProtocol.seen.map(\.url!.path), ["/v1/native/me", "/v1/native/locations"])
        XCTAssertEqual(try local.count(), 0)
        XCTAssertGreaterThan(local.lastSync, 0)
        XCTAssertEqual(local.userName, "Alex")
        XCTAssertEqual(local.deviceLabel, "iPhone (iOS 18.0)")
    }

    func testAckMismatchKeepsTheQueueAndSetsTheMessage() async throws {
        let repository = try await connected()
        respond(locations: .init(json: ["acknowledged": ["a"]]))
        do {
            try await repository.sync()
            XCTFail("A partial acknowledgement must fail the sync")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Upload was not fully acknowledged. Device copy retained.")
        }
        XCTAssertEqual(try local.count(), 2)
        XCTAssertEqual(local.message, "Waiting to sync. Location stays on this phone.")
        XCTAssertEqual(local.lastSync, 0)
    }

    // MARK: Connection expired (#652)

    private func assertExpired(_ repository: CompanionRepository, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertTrue(local.expired, file: file, line: line)
        XCTAssertEqual(local.expiredUser, "u1", file: file, line: line)
        XCTAssertNil(repository.token(), "the credential is dropped, so collection stops", file: file, line: line)
        XCTAssertEqual(try secure.read(), [:], file: file, line: line)
        XCTAssertEqual(local.message, "", "the expired card says it, not a sync error", file: file, line: line)
    }

    func testUnauthorizedMeExpiresTheConnectionAndKeepsEverything() async throws {
        let repository = try await connected()
        respond(me: 401, locations: .init())
        do { try await repository.sync(); XCTFail("401 must fail the sync") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 401) }
        try assertExpired(repository)
        XCTAssertEqual(try local.count(), 2, "kept until Reconnect")
        XCTAssertEqual(local.apps().map(\.id), ["ski"], "kept so the history still shows the app")
        XCTAssertEqual(try logged([.expired, .syncFailed, .stopped]), ["expired:"])
        // Nothing more is sent: there is no credential.
        StubProtocol.seen = []
        try await repository.sync()
        XCTAssertEqual(StubProtocol.seen.count, 0)
    }

    func testUnauthorizedUploadExpiresTheConnection() async throws {
        let repository = try await connected()
        respond(locations: .init(status: 401, json: ["error": "Device connection expired or was disconnected."]))
        do { try await repository.sync(); XCTFail("401 must fail the sync") } catch {}
        try assertExpired(repository)
    }

    func testUnauthorizedGrantChangeExpiresTheConnection() async throws {
        let repository = try await connected()
        StubProtocol.handler = { _ in .init(status: 401, json: ["error": "Device connection expired or was disconnected."]) }
        let app = local.apps()[0]
        do { try await repository.enable(app); XCTFail("401 must fail") } catch {}
        try assertExpired(repository)
        try secure.write(["token": "ndev_test", "userId": "u1"])
        try local.clearForReconnect()
        try local.saveApps(try JSONSerialization.data(withJSONObject: me["apps"]!))
        try local.block("ski") // the queued DELETE
        do { try await repository.sync(); XCTFail("401 must fail") } catch {}
        XCTAssertNil(repository.token())
        XCTAssertTrue(local.expired)
    }

    /// Network errors, 429 and 5xx are sync failures: the connection stays.
    func testTransientFailuresNeverExpireTheConnection() async throws {
        let repository = try await connected()
        for stub in [StubProtocol.Stub(offline: true), StubProtocol.Stub(status: 429), StubProtocol.Stub(status: 500), StubProtocol.Stub(status: 503), StubProtocol.Stub(status: 403)] {
            StubProtocol.handler = { _ in stub }
            do { try await repository.sync(); XCTFail("must fail") } catch {}
            XCTAssertFalse(local.expired, "\(stub.status)")
            XCTAssertEqual(repository.token(), "ndev_test")
        }
        XCTAssertEqual(try local.count(), 2)
    }

    func testExpiredSurvivesARelaunch() async throws {
        let repository = try await connected()
        respond(me: 401, locations: .init())
        do { try await repository.sync() } catch {}
        local.close()
        local = try LocalStore(directory: directory)
        let relaunched = CompanionRepository(local: local, secure: SecureStore(service: secure.service), api: api)
        XCTAssertTrue(local.expired)
        XCTAssertNil(relaunched.token())
        XCTAssertEqual(try local.count(), 2)
    }

    /// The pairing exchange for `userId`, after which `/native/me` reports no grants (they belonged to the old device).
    private func pairAgain(userId: String) async throws -> Bool {
        try secure.write(["pairId": String(repeating: "a", count: 64), "verifier": String(repeating: "b", count: 64)])
        var fresh = me
        fresh["user"] = ["id": userId, "name": "Alex"]
        fresh["apps"] = [["id": "ski", "name": "Ski", "version": "v", "purpose": "Routes", "disclosure": "Disclosure", "grant": NSNull()]]
        StubProtocol.handler = { [fresh] request in
            request.url!.path == "/v1/native/auth/complete" ? .init(json: ["token": "ndev_new"]) : .init(json: fresh)
        }
        return try await CompanionRepository(local: local, secure: secure, api: api).finishSignIn()
    }

    func testReconnectKeepsHistoryAndClearsTheQueueAndGrants() async throws {
        let repository = try await connected()
        respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
        try await repository.sync()
        try local.enqueue(TrackPoint(id: "c", at: CompanionRepository.now(), lat: 1, lng: 2, accuracy: 5, grants: ["g1"]))
        try local.record(.enabled, appId: "ski")
        respond(me: 401, locations: .init())
        do { try await repository.sync() } catch {}
        XCTAssertTrue(local.expired)
        let finished = try await pairAgain(userId: "u1")
        XCTAssertTrue(finished)
        XCTAssertEqual(repository.token(), "ndev_new")
        XCTAssertFalse(local.expired)
        XCTAssertEqual(try local.count(), 0, "points tagged with the old grants can never upload")
        XCTAssertNil(local.apps().first?.grantId)
        XCTAssertEqual(try local.events().map(\.kind), [.resumedAll, .enabled, .expired], "no grant_lost noise for the old device's grants")
        XCTAssertEqual(try local.track(appId: "ski", from: 0, to: .max).count, 2, "uploaded history kept, the unsent point dropped")
        XCTAssertTrue(local.paused)
    }

    /// A different account after an expiry never sees the previous account's history.
    func testReconnectWithAnotherAccountClearsEverything() async throws {
        let repository = try await connected()
        respond(me: 401, locations: .init())
        do { try await repository.sync() } catch {}
        let finished = try await pairAgain(userId: "u2")
        XCTAssertTrue(finished)
        XCTAssertEqual(try local.events(), [])
        XCTAssertEqual(try local.count(), 0)
        XCTAssertFalse(local.expired)
    }

    func testRenewingEarlyUploadsFirstThenKeepsHistory() async throws {
        let repository = try await connected()
        respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
        try await repository.renew()
        XCTAssertEqual(StubProtocol.seen.map(\.url!.path), ["/v1/native/me", "/v1/native/locations"])
        try assertExpired(repository)
        XCTAssertEqual(try logged([.expired]), ["expired:renew"])
        XCTAssertEqual(try local.track(appId: "ski", from: 0, to: .max).count, 2)
    }

    func testDisconnectStillWipesEverything() async throws {
        for expire in [false, true] {
            let repository = try await connected()
            respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
            try await repository.sync()
            if expire { respond(me: 401, locations: .init()); do { try await repository.sync() } catch {} }
            StubProtocol.handler = { _ in .init(json: ["disconnected": true]) }
            try await repository.disconnect()
            XCTAssertEqual(try local.events(), [], "expired: \(expire)")
            XCTAssertEqual(try local.track(appId: "ski", from: 0, to: .max), [])
            XCTAssertEqual(try local.count(), 0)
            XCTAssertEqual(local.apps(), [])
            XCTAssertFalse(local.expired)
            XCTAssertNil(repository.token())
        }
    }

    func testExpiryWarningOnlyInTheLastSevenDays() {
        let day: Int64 = 86_400_000
        XCTAssertNil(CompanionRepository.expiresInDays(0, now: 1))
        XCTAssertNil(CompanionRepository.expiresInDays(10 * day, now: 0))
        XCTAssertNil(CompanionRepository.expiresInDays(7 * day, now: 0))
        XCTAssertEqual(CompanionRepository.expiresInDays(7 * day - 1, now: 0), 7)
        XCTAssertEqual(CompanionRepository.expiresInDays(day, now: 0), 1)
        XCTAssertEqual(CompanionRepository.expiresInDays(1, now: 0), 1)
        XCTAssertNil(CompanionRepository.expiresInDays(5, now: 5))
    }

    func testMeStoresTheDeviceExpiry() async throws {
        let repository = try await connected()
        respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
        try await repository.sync()
        XCTAssertEqual(local.deviceExpiresAt, 1)
    }

    func testQuotaKeepsTheQueue() async throws {
        let repository = try await connected()
        respond(locations: .init(status: 429, json: ["error": "Upload limit reached. Retry later."]))
        do { try await repository.sync(); XCTFail("429 must fail the sync") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 429) }
        XCTAssertEqual(try local.count(), 2)
        XCTAssertFalse(local.paused)
        XCTAssertEqual(local.message, "Upload limit reached. Retry later.")
    }

    /// #622: a failure is kept for the sync health line until the next success, without touching lastSync.
    func testSyncHealthRecordsTheFailureUntilTheNextSuccess() async throws {
        let repository = try await connected()
        respond(locations: .init(status: 429, json: ["error": "Upload limit reached. Retry later."]))
        do { try await repository.sync(); XCTFail("429 must fail the sync") } catch {}
        XCTAssertEqual(local.lastSyncError, "Upload limit reached. Retry later.")
        XCTAssertGreaterThan(local.lastSyncAttempt, 0)
        XCTAssertEqual(local.lastSync, 0)
        respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
        try await repository.sync()
        XCTAssertEqual(local.lastSyncError, "")
        XCTAssertEqual(local.lastSyncAttempt, local.lastSync)
    }

    // MARK: Activity log (#624)

    private func logged(_ kinds: Set<ShareEvent.Kind> = [.syncFailed, .syncRecovered, .uploadRejected, .quota, .stopped]) throws -> [String] {
        try local.events().filter { kinds.contains($0.kind) }.map { "\($0.kind.rawValue):\($0.detail)" }
    }

    func testAnOfflineRunLogsOneFailureAndOneRecovery() async throws {
        let repository = try await connected()
        StubProtocol.handler = { _ in .init(offline: true) }
        for _ in 0..<3 { do { try await repository.sync(); XCTFail("offline must fail") } catch {} }
        respond(locations: .init(json: ["acknowledged": ["a", "b"]]))
        try await repository.sync()
        let log = try logged()
        XCTAssertEqual(log.count, 2, "\(log)")
        XCTAssertTrue(log[0].hasPrefix("sync_failed:0 "), log[0])
        XCTAssertEqual(log[1], "sync_recovered:after 3 attempts")
    }

    func testQuotaIsLogged() async throws {
        let repository = try await connected()
        respond(locations: .init(status: 429, json: ["error": "Upload limit reached. Retry later."]))
        do { try await repository.sync() } catch {}
        XCTAssertEqual(try logged(), ["sync_failed:429 Upload limit reached. Retry later.", "quota:429"])
    }

    func testAckMismatchIsLoggedAsRejected() async throws {
        let repository = try await connected()
        respond(locations: .init(json: ["acknowledged": ["a"]]))
        do { try await repository.sync() } catch {}
        XCTAssertEqual(try logged([.uploadRejected]), ["upload_rejected:partial_ack"])
    }

    // MARK: Heart rate (#631)

    private let hrEntry: [String: Any] = ["appId": "run", "appName": "Run", "capability": "heart_rate.ble", "name": "Heart rate", "purpose": "p",
                                          "disclosure": "d", "version": "hv", "grant": ["id": "hr1", "consent_at": 1]]

    /// `connected()` plus Run's heart-rate grant and one queued sample; `/native/me` lists it under `capabilities`.
    private func connectedWithHeartRate(heartRate: StubProtocol.Stub) async throws -> CompanionRepository {
        let repository = try await connected()
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [hrEntry]))
        try local.enqueueHeartRate(HeartRateSample(id: "h", at: CompanionRepository.now(), bpm: 140, grants: ["hr1"]))
        var withCapabilities = me
        withCapabilities["capabilities"] = [hrEntry]
        StubProtocol.handler = { [withCapabilities] request in
            switch request.url!.path {
            case "/v1/native/me": return .init(json: withCapabilities)
            case "/v1/native/locations": return .init(json: ["acknowledged": ["a", "b"]])
            case "/v1/native/heart-rate": return heartRate
            default: return .init(json: ["grant": ["id": "hr1"], "revoked": true])
            }
        }
        return repository
    }

    func testCapabilityPathsStayUnderNative() {
        for key in ["run", "run/heart_rate.ble"] { XCTAssertNotNil(PasApi.endpoint(CompanionRepository.grantPath(key)), key) }
        XCTAssertNil(PasApi.endpoint("/apps/run/native/heart-rate"))
    }

    func testHeartRateUploadsAfterPointsAndStoresCapabilities() async throws {
        let repository = try await connectedWithHeartRate(heartRate: .init(json: ["acknowledged": ["h"]]))
        try await repository.sync()
        XCTAssertEqual(StubProtocol.seen.map(\.url!.path), ["/v1/native/me", "/v1/native/locations", "/v1/native/heart-rate"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(StubProtocol.seen.last?.httpBodyStream.map(Self.read))) as? [String: Any])
        XCTAssertEqual((body["samples"] as? [[String: Any]])?.first?["bpm"] as? Int, 140)
        XCTAssertEqual(Set((body["samples"] as? [[String: Any]])?.first?.keys.map { $0 } ?? []), ["id", "at", "bpm", "grants"], "no sensor identity")
        XCTAssertEqual(try local.heartRateCount(), 0)
        XCTAssertEqual(local.entries().map(\.key), ["run/heart_rate.ble"])
        XCTAssertEqual(local.heartRateSyncError, "")
    }

    func testARejectedHeartRateBatchIsLoggedAsHeartRateAndKept() async throws {
        let repository = try await connectedWithHeartRate(heartRate: .init(status: 400, json: ["error": "Invalid heart-rate sample."]))
        do { try await repository.sync(); XCTFail("400 must fail the sync") } catch {}
        XCTAssertEqual(try local.count(), 0, "points went first")
        XCTAssertEqual(try local.heartRateCount(), 1)
        XCTAssertEqual(local.heartRateSyncError, "Invalid heart-rate sample.")
        XCTAssertEqual(try logged([.uploadRejected, .heartRateProblem]), ["heart_rate_problem:400"])
    }

    func testEnablingHeartRateUsesItsCapabilityPathAndDisablingRevokesOnlyIt() async throws {
        let repository = try await connectedWithHeartRate(heartRate: .init(json: ["acknowledged": ["h"]]))
        let entry = try XCTUnwrap(local.entries().first)
        StubProtocol.seen = []
        try await repository.enable(entry)
        XCTAssertEqual(StubProtocol.seen.map { "\($0.httpMethod!) \($0.url!.path)" }, ["PUT /v1/native/apps/run/capabilities/heart_rate.ble", "GET /v1/native/me"])
        XCTAssertEqual(try logged([.heartRate]), ["heart_rate:enabled"])
        StubProtocol.seen = []
        try await repository.disable(entry)
        XCTAssertEqual(StubProtocol.seen.first.map { "\($0.httpMethod!) \($0.url!.path)" }, "DELETE /v1/native/apps/run/capabilities/heart_rate.ble")
        XCTAssertFalse(StubProtocol.seen.contains { $0.url!.path.hasSuffix("/location") }, "Run's location grant is untouched")
    }

    /// Signed in on a fresh store (Pause all on, as after pairing), `/native/me` granting Run's heart rate.
    private func freshWithHeartRate() throws -> (CompanionRepository, NativeEntry) {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [hrEntry]))
        var withCapabilities = me
        withCapabilities["capabilities"] = [hrEntry]
        StubProtocol.handler = { [withCapabilities] request in
            request.url!.path == "/v1/native/me" ? .init(json: withCapabilities) : .init(json: ["grant": ["id": "hr1"]])
        }
        return (CompanionRepository(local: local, secure: secure, api: api), try XCTUnwrap(local.entries().first))
    }

    /// #676: heart rate alone must be able to start after a fresh pairing.
    func testEnablingHeartRateEndsPauseAll() async throws {
        let (repository, entry) = try freshWithHeartRate()
        XCTAssertTrue(local.paused, "a fresh pairing starts under Pause all")
        try await repository.enable(entry)
        XCTAssertFalse(local.paused)
        try local.enqueueHeartRate(HeartRateSample(id: "h", at: CompanionRepository.now(), bpm: 140, grants: ["hr1"]))
        XCTAssertEqual(try local.heartRateCount(), 1)
    }

    /// #676: enabling heart rate never resumes a paused Run, whose pause covers its location too.
    func testEnablingHeartRateKeepsRunsOwnPause() async throws {
        let (repository, entry) = try freshWithHeartRate()
        try local.pause("run")
        try await repository.enable(entry)
        XCTAssertFalse(local.paused)
        XCTAssertTrue(local.pausedApps().contains("run"))
        try local.enqueueHeartRate(HeartRateSample(id: "h", at: CompanionRepository.now(), bpm: 140, grants: ["hr1"]))
        XCTAssertEqual(try local.heartRateCount(), 0)
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        return data
    }

    /// #621: the sharing history is local only. Clearing, expiring and seeding it make no request.
    func testHistoryMaintenanceMakesNoRequest() async throws {
        _ = try await connected()
        StubProtocol.seen = []
        try local.seedIfEmpty()
        try local.expire(now: CompanionRepository.now())
        try local.clearHistory()
        XCTAssertEqual(StubProtocol.seen.count, 0)
        XCTAssertEqual(try local.count(), 2)
    }
}
