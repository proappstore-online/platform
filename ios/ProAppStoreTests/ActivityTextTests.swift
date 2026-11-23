import XCTest
@testable import ProAppStore

final class ActivityTextTests: XCTestCase {
    private func sentence(_ kind: ShareEvent.Kind, _ detail: String = "", app: String? = "run") -> String {
        ActivityText.sentence(for: ShareEvent(id: 1, at: 0, appId: app, kind: kind, detail: detail), appName: app == nil ? nil : "Run")
    }

    func testEveryKind() {
        let table: [(ShareEvent.Kind, String, String?, String)] = [
            (.enabled, "", "run", "Run sharing turned on"),
            (.disabled, "", "run", "Run sharing turned off"),
            (.paused, "", "run", "Run paused by you"),
            (.resumed, "", "run", "Run resumed by you"),
            (.pausedAll, "", nil, "All sharing paused by you"),
            (.resumedAll, "", nil, "All sharing resumed"),
            (.stopped, "signed_out", nil, "Sharing stopped: this phone was signed out"),
            (.grantLost, "revoked", "run", "Run access revoked by ProAppStore (the app changed owner or its disclosure)"),
            (.grantRestored, "", "run", "Run access restored"),
            (.historyCleared, "", nil, "History cleared"),
            (.syncFailed, "429 Upload limit reached. Retry later.", nil, "Upload failed: Upload limit reached. Retry later. (429)"),
            (.syncFailed, "0 The Internet connection appears to be offline.", nil, "Upload failed (offline)"),
            (.syncRecovered, "after 3 attempts", nil, "Uploads working again after 3 attempts"),
            (.uploadRejected, "partial_ack", nil, "Upload not fully acknowledged: the copy on this phone was kept"),
            (.uploadRejected, "413", nil, "Upload rejected by ProAppStore (413)"),
            (.quota, "429", nil, "Upload limit reached (429)"),
            (.permission, "precise→approximate", nil, "Precise Location turned off: recording stopped"),
            (.permission, "whenInUse→denied", nil, "Location permission changed: While Using → Denied"),
            (.queueFull, "", nil, "Storage queue full: recording stopped until uploads catch up"),
        ]
        XCTAssertEqual(Set(table.map(\.0)), Set(ShareEvent.Kind.allCases), "every kind has a sentence")
        for (kind, detail, app, expected) in table { XCTAssertEqual(sentence(kind, detail, app: app), expected) }
    }

    func testCategories() {
        XCTAssertEqual(ActivityText.category(.paused), .sharing)
        XCTAssertEqual(ActivityText.category(.syncFailed), .problem)
    }
}
