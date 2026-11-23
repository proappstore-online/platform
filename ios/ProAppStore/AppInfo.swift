import Foundation

/// Version, build and source commit for the About section. All three come from Config/Version.xcconfig
/// through Info.plist; CI overrides the build number and commit.
struct AppInfo {
    let version: String
    let build: String
    let commit: String

    init(_ info: [String: Any]) {
        func value(_ key: String) -> String? { (info[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        version = value("CFBundleShortVersionString") ?? "unknown"
        build = value("CFBundleVersion") ?? "unknown"
        commit = value("PASCommit") ?? "dev"
    }

    static let current = AppInfo(Bundle.main.infoDictionary ?? [:])
}
