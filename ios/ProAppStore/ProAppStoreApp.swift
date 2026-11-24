import SwiftUI
import UIKit

@main
struct ProAppStoreApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup { ContentView(model: delegate.model, collector: delegate.model.collector) }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let model = CompanionModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // ADR-020 §7: nothing restarts in the background. iOS can relaunch the app for its CLBackgroundActivitySession or
        // for Core Bluetooth restoration; the model's `live` gate is off until the companion is opened, so such a launch
        // rejoins no session, starts no updates and lets go of the strap. Persisted sessions resume on the next open.
        model.evaluate()
        return true
    }
}
