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
        // A relaunch after iOS terminated the app arrives with launchOptions[.location] (significant-change
        // delivery, Always only). The collector exists from here on and resumes only if a credential exists,
        // collection is not paused and an app still has a grant.
        model.collector.evaluate()
        return true
    }
}
