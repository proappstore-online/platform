import XCTest
@testable import ProAppStore

final class SharingStateTests: XCTestCase {
    func testEveryChip() {
        let cases: [(granted: Bool, blocked: Bool, appPaused: Bool, pausedAll: Bool, running: Bool, SharingState)] = [
            (true, false, false, false, true, .sharing),
            (true, false, true, false, true, .paused),
            (true, false, true, true, false, .pausedAll),     // Pause all wins over the app's own pause
            (true, false, false, true, false, .pausedAll),
            (false, false, false, false, true, .off),
            (false, true, false, false, true, .off),          // revocation finished, grant gone
            (true, true, false, false, true, .turningOff),    // DELETE still pending
            (true, true, true, true, false, .turningOff),
            (true, false, false, false, false, .notRecording), // e.g. permission lost
        ]
        for c in cases {
            XCTAssertEqual(SharingState.of(granted: c.granted, blocked: c.blocked, appPaused: c.appPaused, pausedAll: c.pausedAll, running: c.running), c.5, "\(c)")
        }
    }
}
