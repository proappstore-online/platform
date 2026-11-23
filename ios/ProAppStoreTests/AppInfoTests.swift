import XCTest
@testable import ProAppStore

final class AppInfoTests: XCTestCase {
    func testReadsVersionBuildAndCommit() {
        let info = AppInfo(["CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "42", "PASCommit": "abc1234"])
        XCTAssertEqual([info.version, info.build, info.commit], ["1.2.3", "42", "abc1234"])
    }

    func testMissingOrEmptyValuesFallBack() {
        let missing = AppInfo([:])
        XCTAssertEqual([missing.version, missing.build, missing.commit], ["unknown", "unknown", "dev"])
        XCTAssertEqual(AppInfo(["PASCommit": ""]).commit, "dev")
    }

    /// The host app's Info.plist must carry the substituted xcconfig values, not the `$(…)` placeholders.
    func testBuiltBundleHasSubstitutedValues() {
        let info = AppInfo.current
        XCTAssertNotNil(info.version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression), info.version)
        XCTAssertNotNil(Int(info.build), info.build)
        XCTAssertFalse(info.commit.contains("$("), info.commit)
        XCTAssertFalse(info.commit.isEmpty)
    }
}
