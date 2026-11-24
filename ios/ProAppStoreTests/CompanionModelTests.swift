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

    private func runApp(granted: Bool) -> [String: Any] {
        ["id": "run", "name": "Run", "purpose": "Runs", "disclosure": "D", "version": "v", "grant": granted ? ["id": "run-g", "consent_at": 1] : NSNull()]
    }
    private func runHeartRate(granted: Bool) -> [String: Any] {
        ["appId": "run", "appName": "Run", "capability": "heart_rate.ble", "name": "Heart rate", "purpose": "p", "disclosure": "d", "version": "hv",
         "grant": granted ? ["id": "hr1", "consent_at": 1] : NSNull()]
    }
    /// Models outlive their test. A CLLocationManager released milliseconds after it was created crashes the simulator
    /// inside LocationSupport (EXC_BAD_ACCESS in a block release); the app holds its one model for its lifetime.
    private static var alive: [CompanionModel] = []

    /// Signed in, with Run's location and heart rate granted as given, and a model over that store.
    private func makeModel(location: Bool, heartRate: Bool) throws -> CompanionModel {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        try local.saveApps(try JSONSerialization.data(withJSONObject: [runApp(granted: location)]))
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [runHeartRate(granted: heartRate)]))
        let model = CompanionModel(repository: repository)
        Self.alive.append(model)
        return model
    }

    /// ADR-020 decision 11 (replaces #676's "Resume all counts a heart-rate-only app"): heart rate's Enable is hidden
    /// while Run's location is off, and the line says what to do.
    func testHeartRateEnableIsHiddenWhileLocationIsOff() throws {
        let model = try makeModel(location: false, heartRate: false)
        let entry = try XCTUnwrap(model.entries.first)
        XCTAssertFalse(model.offersEnable(entry))
        XCTAssertEqual(model.heartRateGate(entry), "Off · turn on location for Run first")
        try local.saveApps(try JSONSerialization.data(withJSONObject: [runApp(granted: true)]))
        model.refresh()
        XCTAssertTrue(model.offersEnable(entry))
        XCTAssertEqual(model.heartRateGate(entry), "Off")
    }

    /// Decision 11: a phone that already holds a heart-rate-only grant keeps it, with the "turn on location" line and no
    /// Start; with location on and no session it reads "tap Start"; in a session the sensor's own state shows.
    func testAnEnabledHeartRateLineFollowsLocationAndTheSession() throws {
        let model = try makeModel(location: false, heartRate: true)
        let entry = try XCTUnwrap(model.entries.first)
        XCTAssertTrue(model.enabled(entry))
        XCTAssertEqual(model.heartRateGate(entry), "Not sharing · turn on location for Run to start")
        try local.saveApps(try JSONSerialization.data(withJSONObject: [runApp(granted: true)]))
        model.refresh()
        XCTAssertEqual(model.heartRateGate(entry), "Not sharing · tap Start")
        model.startSession(try XCTUnwrap(model.apps.first))
        XCTAssertNil(model.heartRateGate(entry))
    }

    /// #620's guarantees for Start: a local write, with zero API requests and no disclosure.
    func testStartSendsNoRequestAndShowsNoDisclosure() throws {
        let model = try makeModel(location: true, heartRate: true)
        let run = try XCTUnwrap(model.apps.first)
        StubProtocol.seen = []
        model.startSession(run)
        XCTAssertEqual(StubProtocol.seen.count, 0)
        XCTAssertNil(model.consent)
        XCTAssertNil(model.entryConsent)
        XCTAssertEqual(Set(model.sessions.keys), ["run"])
        XCTAssertEqual(model.state(run, running: false), .notRecording, "no location permission in the simulator")
        model.stop(run)
        XCTAssertEqual(StubProtocol.seen.count, 0)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertEqual(try local.events().filter { $0.kind == .sessionEnded }.map(\.detail), ["user"])
    }

    /// ADR-020 §7: a model built over a store holding a session (a background relaunch) has no recipients until the
    /// companion is opened.
    func testAPersistedSessionCollectsNothingUntilTheCompanionIsOpened() throws {
        try local.startSession("run")
        let model = try makeModel(location: true, heartRate: true)
        let now = CompanionRepository.now()
        XCTAssertEqual(model.collector.recipients(at: now), [])
        XCTAssertEqual(model.heartRate.recipients(at: now), [])
        XCTAssertFalse(model.live)
        StubProtocol.handler = { [me] _ in .init(json: me) }
        model.becameActive()
        defer { model.resignActive() }
        XCTAssertTrue(model.live)
        XCTAssertEqual(model.collector.recipients(at: now), ["run-g"])
        XCTAssertEqual(model.heartRate.recipients(at: now), ["hr1"])
    }

    /// #625: the Lock Screen activity's Stop is Stop all (ADR-020 §5). It ends every session with the `all` detail and
    /// sends no request, like the button, so it never touches a grant, consent or the queue.
    func testTheLockScreenStopEndsEverySessionWithoutARequest() async throws {
        let model = try makeModel(location: true, heartRate: true)
        model.startSession(try XCTUnwrap(model.apps.first))
        XCTAssertEqual(Set(model.sessions.keys), ["run"])
        StubProtocol.seen = []
        _ = try await StopSharingIntent().perform()
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertTrue(local.sessions().isEmpty)
        XCTAssertEqual(try local.events().filter { $0.kind == .sessionEnded }.map(\.detail), ["all"])
        XCTAssertNotNil(model.apps.first?.grantId, "the grant stays")
        XCTAssertEqual(StubProtocol.seen.count, 0)
    }

    /// ADR-020 §2: a link never starts anything.
    func testAnAppLinkOpensConsentTheStartPromptOrThePage() throws {
        let link = URL(string: "proappstore://native/apps/run")!
        let model = try makeModel(location: false, heartRate: false)
        model.handle(link)
        XCTAssertEqual(model.consent?.id, "run", "not enabled: its consent")
        model.consent = nil

        try local.saveApps(try JSONSerialization.data(withJSONObject: [runApp(granted: true)]))
        model.refresh()
        model.handle(link)
        XCTAssertEqual(model.startPrompt?.id, "run", "enabled, no session: the Start prompt")
        model.startPrompt = nil // Not now
        XCTAssertTrue(local.sessions().isEmpty)
        XCTAssertFalse(try local.events().contains { $0.kind == .sessionStarted }, "Not now writes nothing")

        model.startSession(try XCTUnwrap(model.apps.first))
        model.handle(link)
        XCTAssertNil(model.startPrompt)
        XCTAssertTrue(model.showSharing)
        XCTAssertEqual(model.openApp, "run", "sharing: its page")

        model.showSharing = false; model.openApp = nil
        model.handle(URL(string: "proappstore://native/apps/unknown")!)
        XCTAssertTrue(model.showSharing, "unknown: the Sharing tab")
        XCTAssertNil(model.openApp)
        XCTAssertNil(model.consent)
        XCTAssertEqual(StubProtocol.seen.count, 0)
    }

    /// Decision 11: a heart-rate link for an app whose location is off opens the location consent first.
    func testAHeartRateLinkAsksForLocationFirst() throws {
        let link = URL(string: "proappstore://native/apps/run/heart_rate.ble")!
        let model = try makeModel(location: false, heartRate: false)
        model.handle(link)
        XCTAssertEqual(model.consent?.id, "run")
        XCTAssertNil(model.entryConsent)
        model.consent = nil
        try local.saveApps(try JSONSerialization.data(withJSONObject: [runApp(granted: true)]))
        model.refresh()
        model.handle(link)
        XCTAssertEqual(model.entryConsent?.key, "run/heart_rate.ble", "location on: the heart-rate consent")
        XCTAssertNil(model.consent)
    }

    /// #682: the first launch after an upgrade has no entries until `catchUp()`'s sync, and the link arrives before it.
    func testARunHeartRateLinkBeforeTheFirstSyncIsHandledAfterIt() async throws {
        try secure.write(["token": "ndev_test", "userId": "u1"])
        let model = CompanionModel(repository: repository)
        model.handle(URL(string: "proappstore://native/apps/run/heart_rate.ble")!)
        XCTAssertNil(model.entryConsent)
        var withCapabilities = me
        withCapabilities["apps"] = [runApp(granted: true)]
        withCapabilities["capabilities"] = [runHeartRate(granted: false)]
        StubProtocol.handler = { [withCapabilities] _ in .init(json: withCapabilities) }
        await model.catchUp()
        XCTAssertEqual(model.entryConsent?.key, "run/heart_rate.ble")
        model.entryConsent = nil
        await model.catchUp()
        XCTAssertNil(model.entryConsent, "handled once")
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
