import XCTest
@testable import ProAppStore

/// The screen model's activation path (#646), against a temporary store and the stubbed API.
@MainActor
final class CompanionModelTests: XCTestCase {
    private let secure = SecureStore(service: "online.proappstore.companion.modeltests")
    private var directory: URL!
    private var local: LocalStore!
    private var repository: CompanionRepository!

    override func setUpWithError() throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        local = try LocalStore(directory: directory)
        try secure.clear()
        repository = CompanionRepository(local: local, secure: secure, api: PasApi(configuration: configuration))
        StubProtocol.seen = []
    }

    override func tearDownWithError() throws {
        try secure.clear()
        local.close()
        try? FileManager.default.removeItem(at: directory)
    }

    private let me: [String: Any] = ["user": ["id": "u1", "name": "Alex"], "device": ["id": "d1", "label": "iPhone"], "apps": [Any]()]

    /// An offline activation must not leave its error on screen once a background sync succeeds.
    func testAnOfflineActivationClearsOnceABackgroundSyncSucceeds() async throws {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        let model = CompanionModel(repository: repository)
        StubProtocol.handler = { _ in .init(offline: true) }
        await model.catchUp()
        XCTAssertEqual(model.message, "Waiting to sync. Location stays on this phone.")
        StubProtocol.handler = { [me] _ in .init(json: me) }
        try await repository.sync() // the collector's sync, not a button
        model.refresh()
        XCTAssertEqual(model.message, "")
    }

    /// #652: after a relaunch the expired state shows, with nothing enabled, the app kept for its history, and no
    /// red sync error; a later 401 from a button is not shown as an error either.
    func testAnExpiredConnectionShowsAfterRelaunchWithoutAnError() async throws {
        let apps: [[String: Any]] = [["id": "ski", "name": "Ski", "purpose": "Routes", "disclosure": "D", "version": "v", "grant": ["id": "g1", "consent_at": 1]]]
        try local.saveApps(try JSONSerialization.data(withJSONObject: apps))
        try local.markExpired(userId: "u1")
        let model = CompanionModel(repository: repository)
        XCTAssertTrue(model.expired)
        XCTAssertFalse(model.signedIn)
        let ski = try XCTUnwrap(model.apps.first)
        XCTAssertFalse(model.enabled(ski))
        XCTAssertEqual(model.state(ski, running: false), .expired)
        await model.catchUp()
        XCTAssertEqual(model.message, "")
        XCTAssertEqual(StubProtocol.seen.count, 0, "no credential, no request")
    }

    func testTheExpiryNoteShowsOnlyInTheLastWeek() throws {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        local.deviceExpiresAt = CompanionRepository.now() + 3 * 86_400_000 - 60_000
        let model = CompanionModel(repository: repository)
        XCTAssertEqual(model.expiresInDays, 3)
        local.deviceExpiresAt = CompanionRepository.now() + 30 * 86_400_000
        model.refresh()
        XCTAssertNil(model.expiresInDays)
    }

    /// #676: under Pause all, an enabled heart-rate entry with no location app is enough to Resume all.
    func testResumeAllCountsAHeartRateOnlyApp() throws {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        let model = CompanionModel(repository: repository)
        XCTAssertTrue(model.paused)
        XCTAssertFalse(model.canResumeAll, "nothing enabled, nothing to resume")
        let run: [String: Any] = ["appId": "run", "appName": "Run", "capability": "heart_rate.ble", "name": "Heart rate", "purpose": "p",
                                  "disclosure": "d", "version": "hv", "grant": ["id": "hr1", "consent_at": 1]]
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [run]))
        model.refresh()
        XCTAssertTrue(model.paused)
        XCTAssertTrue(model.apps.isEmpty)
        XCTAssertTrue(model.canResumeAll)
    }

    /// A rejected pairing is reported once; the next activation shows nothing and sends nothing.
    func testARejectedPairingIsShownOnceThenCleared() async throws {
        try secure.write(["pairId": String(repeating: "a", count: 64), "verifier": String(repeating: "b", count: 64)])
        let model = CompanionModel(repository: repository)
        XCTAssertEqual(model.pairingCode, "AAAAAAAA")
        StubProtocol.handler = { _ in .init(status: 403, json: ["error": "Invalid or expired connection."]) }
        await model.catchUp()
        XCTAssertEqual(model.message, "Invalid or expired connection.")
        XCTAssertEqual(model.pairingCode, "")
        await model.catchUp()
        XCTAssertEqual(model.message, "")
        XCTAssertEqual(StubProtocol.seen.count, 1)
    }
}
