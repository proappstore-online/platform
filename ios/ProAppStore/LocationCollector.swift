import CoreLocation
import UIKit

/// Background route collection, the iOS counterpart of LocationService.kt. Collection runs only while a
/// credential exists, collection is not paused, an app has a grant, and precise While Using or Always access
/// is granted. Every callback re-checks those conditions.
@MainActor
final class LocationCollector: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var authorization: CLAuthorizationStatus
    @Published private(set) var fullAccuracy: Bool
    @Published private(set) var running = false

    private let manager = CLLocationManager()
    private let repository: CompanionRepository
    private var local: LocalStore { repository.local }
    private var lastFixAt: Int64 = 0
    private var lastSyncAttempt = Date.distantPast

    init(repository: CompanionRepository) {
        self.repository = repository
        authorization = manager.authorizationStatus
        fullAccuracy = manager.accuracyAuthorization == .fullAccuracy
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5                        // metres; Run's engine coalesces <3 m anyway
        manager.activityType = .fitness
        manager.pausesLocationUpdatesAutomatically = false // v1: runs until Pause all, like Android's FGS
        manager.allowsBackgroundLocationUpdates = true     // requires UIBackgroundModes=location
        manager.showsBackgroundLocationIndicator = true    // visible, like Android's notification
        // Unlock: upload the tail of a locked segment before the user reopens their app.
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.flush() }
        }
    }

    var permitted: Bool {
        (authorization == .authorizedWhenInUse || authorization == .authorizedAlways) && fullAccuracy
    }

    private func recipients(at: Int64) -> [String] {
        LocationPolicy.recipients(local.apps(), blocked: local.blocked(), at: at)
    }

    /// Starts or stops collection to match the current rules. Called on launch (including a relaunch for a
    /// location event), activation, every authorization change and every delivered fix.
    func evaluate() {
        if repository.token() != nil && !local.paused && permitted && !recipients(at: CompanionRepository.now()).isEmpty {
            if !running { manager.startUpdatingLocation(); running = true }
            // Relaunch hook after iOS terminates the app.
            if authorization == .authorizedAlways { manager.startMonitoringSignificantLocationChanges() }
        } else {
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
            if running { running = false }
        }
    }

    func flush() {
        lastSyncAttempt = Date()
        Task { try? await repository.sync() }
    }

    func requestWhenInUse() { manager.requestWhenInUseAuthorization() }
    /// Only from the explicit "Keep recording after restarts" button, after While Using is granted.
    func requestAlways() { manager.requestAlwaysAuthorization() }
    func requestFullAccuracy() { manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "RouteRecording") }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            authorization = self.manager.authorizationStatus
            fullAccuracy = self.manager.accuracyAuthorization == .fullAccuracy
            evaluate()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated { record(locations) } // delegate calls arrive on the main thread
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A transient fix failure keeps the session; a denial is caught by the authorization callback.
    }

    private func record(_ locations: [CLLocation]) {
        evaluate()
        guard running else { return }
        for location in locations {
            let at = Int64(location.timestamp.timeIntervalSince1970 * 1000)
            let point = TrackPoint(id: UUID().uuidString, at: at, lat: location.coordinate.latitude, lng: location.coordinate.longitude,
                                   accuracy: location.horizontalAccuracy, grants: recipients(at: at))
            guard LocationPolicy.valid(point, now: CompanionRepository.now(), lastFixAt: lastFixAt) else { continue }
            lastFixAt = point.at
            do {
                try local.enqueue(point) // Re-filters recipients against current consent before insert.
            } catch {
                try? local.setPaused(true)
                local.message = "Could not save location on this phone. Collection paused."
                evaluate()
                return
            }
        }
        if Date().timeIntervalSince(lastSyncAttempt) >= 15 { flush() }
    }
}
