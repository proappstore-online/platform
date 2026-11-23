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
