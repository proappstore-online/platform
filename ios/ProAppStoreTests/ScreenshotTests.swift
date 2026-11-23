import SQLite3
import SwiftUI
import XCTest
@testable import ProAppStore

/// Renders the real screens against a seeded store and a stubbed API, for the acceptance screenshots.
/// Skipped unless PAS_SCREENSHOTS names an output directory:
///   TEST_RUNNER_PAS_SCREENSHOTS=/path xcodebuild … test -only-testing:ProAppStoreTests/ScreenshotTests
@MainActor
final class ScreenshotTests: XCTestCase {
    private let secure = SecureStore(service: "online.proappstore.companion.screenshots")
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? secure.clear()
        try? FileManager.default.removeItem(at: directory)
    }

    func testCaptureScreens() async throws {
        guard let output = ProcessInfo.processInfo.environment["PAS_SCREENSHOTS"] else { throw XCTSkip("PAS_SCREENSHOTS not set") }
        let now = CompanionRepository.now()
        let start = Int64(Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000)
        let consent = max(start, now - 3 * 3_600_000)
        let apps: [[String: Any]] = [
            ["id": "ski", "name": "Ski", "purpose": "Records your ski runs", "disclosure": "Disclosure", "version": "v", "grant": ["id": "g-ski", "consent_at": consent]],
            ["id": "run", "name": "Run", "purpose": "Records runs and walks", "disclosure": "Disclosure", "version": "v", "grant": ["id": "g-run", "consent_at": consent]],
            ["id": "rideshare", "name": "Rideshare", "purpose": "Shares your pickup location", "disclosure": "Disclosure", "version": "v", "grant": NSNull()],
        ]
        let me: [String: Any] = ["user": ["id": "u1", "name": "Serge"], "device": ["id": "d1", "label": "iPhone (iOS 18.0)"], "apps": apps]
        try secure.write(["token": "ndev_screenshot", "userId": "u1"])
        let local = try LocalStore(directory: directory)
        try local.saveApps(try JSONSerialization.data(withJSONObject: apps))
        try local.seedIfEmpty(now: consent) // before anything else is recorded, as on an upgrade
        try local.setPaused(false)
        try backdate(.resumedAll, to: consent, in: local) // a fresh store starts paused; resume at consent
        // A walk: both apps for the first part, then Run paused.
        let pauseAt = now - 20 * 60_000
        for (i, t) in stride(from: consent, to: now - 60_000, by: 60_000).enumerated() {
            let grants = t < pauseAt ? ["g-ski", "g-run"] : ["g-ski"]
            try local.enqueue(TrackPoint(id: "p\(i)", at: t, lat: 37.3349 + Double(i) * 0.00005, lng: -122.009 + Double(i) * 0.00004, accuracy: 5, grants: grants))
        }
        try local.pause("run")
        try backdate(.paused, to: pauseAt, in: local)
        // #624: a recovered offline stretch and a permission change for the activity log.
        try local.syncFailed("0 The Internet connection appears to be offline.")
        try local.syncFailed("0 The Internet connection appears to be offline.")
        try local.record(.permission, detail: "precise→approximate")
        try local.record(.permission, detail: "approximate→precise")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        StubProtocol.handler = { request in
            switch request.url!.path {
            case "/v1/native/me": return .init(json: me)
            case "/v1/native/locations":
                let body = request.httpBodyStream.map { stream -> Data in
                    stream.open(); defer { stream.close() }
                    var data = Data(); var buffer = [UInt8](repeating: 0, count: 65_536)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                    return data
                } ?? request.httpBody ?? Data()
                let points = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["points"] as? [[String: Any]] ?? []
                let ids = points.compactMap { $0["id"] as? String }
                return .init(json: ["acknowledged": ids])
            default: return .init(status: 404)
            }
        }
        let model = CompanionModel(repository: CompanionRepository(local: local, secure: secure, api: PasApi(configuration: configuration)))
        model.becameActive() // syncs against the stub
        try await Task.sleep(for: .seconds(2))
        // Then a few more fixes that have not synced yet.
        for k in 0..<4 {
            try local.enqueue(TrackPoint(id: "late\(k)", at: now + Int64(k) * 100, lat: 37.336, lng: -122.008, accuracy: 5, grants: ["g-ski"]))
        }

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let name = style == .dark ? "dark" : "light"
            for tab in [ContentView.Tab.sharing, .settings] {
                let window = UIWindow(windowScene: scene)
                window.overrideUserInterfaceStyle = style
                window.rootViewController = UIHostingController(rootView: ContentView(model: model, collector: model.collector, tab: tab))
                window.makeKeyAndVisible()
                try await Task.sleep(for: .seconds(3))
                try save(window, to: "\(output)/\(tab == .sharing ? "sharing" : "settings")-\(name).png")
                window.isHidden = true
            }
            // #623: Run's detail with its session expanded.
            let run = try XCTUnwrap(model.apps.first { $0.id == "run" })
            let session = try XCTUnwrap(SharingTimeline.sessions(model.events, appId: "run").last)
            let detail = UIWindow(windowScene: scene)
            detail.overrideUserInterfaceStyle = style
            detail.rootViewController = UIHostingController(rootView: NavigationStack {
                AppSharingView(app: run, model: model, collector: model.collector, expanded: [session.start])
            })
            detail.makeKeyAndVisible()
            try await Task.sleep(for: .seconds(4))
            try save(detail, to: "\(output)/run-detail-\(name).png")
            detail.isHidden = true
            let log = UIWindow(windowScene: scene)
            log.overrideUserInterfaceStyle = style
            log.rootViewController = UIHostingController(rootView: NavigationStack { ActivityLogView(model: model) })
            log.makeKeyAndVisible()
            try await Task.sleep(for: .seconds(2))
            try save(log, to: "\(output)/activity-\(name).png")
            log.isHidden = true
            // The whole dashboard, past the fold.
            let tall = UIWindow(windowScene: scene)
            tall.frame = CGRect(x: 0, y: 0, width: scene.screen.bounds.width, height: 1_900)
            tall.overrideUserInterfaceStyle = style
            tall.rootViewController = UIHostingController(rootView: SharingDashboardView(model: model, collector: model.collector))
            tall.makeKeyAndVisible()
            try await Task.sleep(for: .seconds(3))
            try save(tall, to: "\(output)/sharing-full-\(name).png")
            tall.isHidden = true
        }
        model.resignActive()
    }

    /// pause() records at the real clock; the walk needs the pause in the past.
    private func backdate(_ kind: ShareEvent.Kind, to at: Int64, in local: LocalStore) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(local.fileURL.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, "UPDATE share_events SET at = \(at) WHERE kind = '\(kind.rawValue)'", nil, nil, nil), SQLITE_OK)
    }

    private func save(_ window: UIWindow, to path: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: path))
    }
}
