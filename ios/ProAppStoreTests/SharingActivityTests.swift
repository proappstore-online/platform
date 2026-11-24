import XCTest
@testable import ProAppStore

/// #625: what the Lock Screen activity says, from the sessions alone.
final class SharingActivityTests: XCTestCase {
    func testNoSessionMeansNoActivity() {
        XCTAssertNil(SharingActivity.content([], names: ["run": "Run"]))
    }

    /// Names in session order, and the elapsed time from the oldest session's start.
    func testAppsAreNamedOldestFirstAndTimedFromTheFirstStart() throws {
        let sessions = [Session(appId: "ski", startedAt: 2_000, lastMovedAt: 2_000), Session(appId: "run", startedAt: 1_000, lastMovedAt: 1_000)]
        let state = try XCTUnwrap(SharingActivity.content(sessions, names: ["run": "Run", "ski": "Ski"]))
        XCTAssertEqual(state.apps, ["Run", "Ski"])
        XCTAssertEqual(state.since, Date(timeIntervalSince1970: 1))
    }

    /// An app missing from the stored list still shows, by its id, rather than vanishing from a running session.
    func testAnUnknownAppShowsItsId() {
        XCTAssertEqual(SharingActivity.content([Session(appId: "ride", startedAt: 1, lastMovedAt: 1)], names: [:])?.apps, ["ride"])
    }
}
