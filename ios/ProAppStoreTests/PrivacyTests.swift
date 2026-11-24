import XCTest
@testable import ProAppStore

/// #685: what App Review checks in the bundle and in Settings.
final class PrivacyTests: XCTestCase {
    /// The privacy manifest ships in the app (a resource that silently falls out of the target is the failure mode).
    func testPrivacyManifestShipsInTheApp() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"), "PrivacyInfo.xcprivacy not in the .app")
        let manifest = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        let types = (manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]] ?? []).compactMap { $0["NSPrivacyCollectedDataType"] as? String }
        XCTAssertTrue(types.contains("NSPrivacyCollectedDataTypePreciseLocation"), "\(types)")
        let apis = manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]] ?? []
        let defaults = apis.first { $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults" }
        XCTAssertEqual(defaults?["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1"])
    }

    /// The deletion page the app, Android (#663) and the store consoles all link to; the anchor must not drift.
    func testDeleteAccountOpensTheDeletionSection() {
        XCTAssertEqual(SettingsView.deleteAccountURL, "https://proappstore.online/privacy#data-deletion")
    }
}
