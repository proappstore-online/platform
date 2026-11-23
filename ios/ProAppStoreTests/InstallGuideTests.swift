import XCTest
@testable import ProAppStore

final class InstallGuideTests: XCTestCase {
    private let suite = "online.proappstore.companion.installguide.tests"
    private var guide: InstallGuide!

    override func setUp() {
        UserDefaults().removePersistentDomain(forName: suite)
        guide = InstallGuide(defaults: UserDefaults(suiteName: suite)!)
    }

    override func tearDown() { UserDefaults().removePersistentDomain(forName: suite) }

    func testShownOncePerApp() {
        XCTAssertTrue(guide.shouldShow("run"))
        guide.markSeen("run") // the primary action
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertTrue(guide.shouldShow("ski"))
    }

    func testDontShowAgainCoversEveryApp() {
        guide.opened("run", dontShowAgain: true)
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertFalse(guide.shouldShow("ski"))
    }

    /// The toggle alone saves nothing: Cancel after turning it on leaves the guide on for every app.
    func testDontShowAgainPersistsOnlyOnOpen() {
        guide.opened("run", dontShowAgain: false)
        XCTAssertFalse(guide.off)
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertTrue(guide.shouldShow("ski"))
    }

    func testCancelMarksNothing() {
        XCTAssertTrue(guide.shouldShow("run"))
        XCTAssertTrue(guide.shouldShow("run"))
    }

    func testSurvivesLocalStoreClear() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let local = try LocalStore(directory: directory)
        guide.markSeen("run"); guide.off = false
        try local.clear()
        local.close()
        XCTAssertFalse(guide.shouldShow("run"))
        XCTAssertTrue(guide.shouldShow("ski"))
    }
}
