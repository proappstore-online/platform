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

    func testUnauthorizedPausesCollection() async throws {
        let repository = try await connected()
        respond(me: 401, locations: .init())
        do { try await repository.sync(); XCTFail("401 must fail the sync") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 401) }
        XCTAssertTrue(local.paused)
        XCTAssertEqual(local.message, "Device connection expired or was disconnected.")
        XCTAssertEqual(try local.count(), 2)
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

    func testUnauthorizedLogsTheStopAndTheFailureAndStillThrows() async throws {
        let repository = try await connected()
        respond(me: 401, locations: .init())
        do { try await repository.sync(); XCTFail("401 must still throw") } catch let failure as ApiFailure { XCTAssertEqual(failure.status, 401) }
        XCTAssertEqual(try logged(), ["stopped:signed_out", "sync_failed:401 Device connection expired or was disconnected."])
        XCTAssertEqual(local.message, "Device connection expired or was disconnected.")
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
