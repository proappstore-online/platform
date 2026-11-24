import XCTest
@testable import ProAppStore

final class SharingStateTests: XCTestCase {
    func testEveryChip() {
        let cases: [(granted: Bool, blocked: Bool, session: Bool, running: Bool, SharingState)] = [
            (true, false, true, true, .sharing),
            (true, false, false, true, .notSharing),          // ADR-020: granted, no session (another app's runs)
            (true, false, false, false, .notSharing),
            (false, false, false, true, .off),
            (false, true, false, true, .off),                 // revocation finished, grant gone
            (true, true, false, true, .turningOff),           // DELETE still pending
            (true, true, true, false, .turningOff),
            (true, false, true, false, .notRecording),        // e.g. permission lost
        ]
        for c in cases {
            XCTAssertEqual(SharingState.of(granted: c.granted, blocked: c.blocked, session: c.session, running: c.running), c.4, "\(c)")
        }
    }
}
