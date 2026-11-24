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
    /// Time and place of the last accepted fix, in memory only: the map's live dot. Never a second location
    /// source (no MapKit user location).
    @Published private(set) var lastFixAt: Date?
    @Published private(set) var lastFix: CLLocationCoordinate2D?

    private let manager = CLLocationManager()
    private let repository: CompanionRepository
    private var local: LocalStore { repository.local }
    private var lastAcceptedAt: Int64 = 0
    private var emitter = EmitFilter()
    /// CoreLocation's motion state while collecting (#639): stationary turns GPS off and holds back jitter.
    private var stationary = false
    private var motion: Task<Void, Never>?
    private var activity: CLBackgroundActivitySession?

    init(repository: CompanionRepository) {
        self.repository = repository
        authorization = manager.authorizationStatus
        fullAccuracy = manager.accuracyAuthorization == .fullAccuracy
        super.init()
        manager.delegate = self
        apply(stationary: false)                          // best accuracy, 5 m distance filter
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
        LocationPolicy.recipients(local.apps(), blocked: local.excluded(), at: at)
    }

    /// Starts or stops collection to match the current rules. Called on launch (including a relaunch for a
    /// location event), activation, every authorization change and every delivered fix.
    func evaluate() {
        if repository.token() != nil && !local.paused && permitted && !recipients(at: CompanionRepository.now()).isEmpty {
            if !running {
                emitter = EmitFilter() // a resumed session starts with a point, not a heartbeat later
                manager.startUpdatingLocation(); running = true
                watchMotion()
            }
            // Relaunch hook after iOS terminates the app.
            if authorization == .authorizedAlways { manager.startMonitoringSignificantLocationChanges() }
        } else {
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
            if running { running = false }
            motion?.cancel(); motion = nil
            activity?.invalidate(); activity = nil
            apply(stationary: false)
        }
    }

    /// Motion state only: points still come from `manager`. `liveUpdates` pauses itself while the phone is still,
    /// and the background activity session keeps its updates coming while locked, under While Using too.
    private func watchMotion() {
        activity = CLBackgroundActivitySession()
        motion = Task { [weak self] in
            do {
                for try await update in CLLocationUpdate.liveUpdates(.fitness) {
                    guard !Task.isCancelled else { return }
                    self?.apply(stationary: update.isStationary)
                }
            } catch {}
        }
    }

    private func apply(stationary value: Bool) {
        if stationary && !value { emitter.motionResumed() }
        stationary = value
        let tracking = LocationPolicy.tracking(stationary: value)
        if manager.desiredAccuracy != tracking.accuracy { manager.desiredAccuracy = tracking.accuracy }
        if manager.distanceFilter != tracking.distanceFilter { manager.distanceFilter = tracking.distanceFilter }
    }

    func flush() {
        Task { try? await repository.sync() }
    }

    func requestWhenInUse() { manager.requestWhenInUseAuthorization() }
    /// Only from the explicit "Keep recording after restarts" button, after While Using is granted.
    func requestAlways() { manager.requestAlwaysAuthorization() }
    func requestFullAccuracy() { manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "RouteRecording") }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            let old = (authorization, fullAccuracy)
            authorization = self.manager.authorizationStatus
            fullAccuracy = self.manager.accuracyAuthorization == .fullAccuracy
            // Activity log: changes only, never the first report.
            if old.0 != authorization { try? local.record(.permission, detail: "\(Self.name(old.0))→\(Self.name(authorization))") }
            if old.1 != fullAccuracy { try? local.record(.permission, detail: fullAccuracy ? "approximate→precise" : "precise→approximate") }
            evaluate()
        }
    }

    private static func name(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: "notDetermined"
        case .authorizedWhenInUse: "whenInUse"
        case .authorizedAlways: "always"
        case .denied: "denied"
        case .restricted: "restricted"
        @unknown default: "unknown"
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
            guard LocationPolicy.valid(point, now: CompanionRepository.now(), lastFixAt: lastAcceptedAt) else { continue }
            lastAcceptedAt = point.at
            lastFixAt = location.timestamp; lastFix = location.coordinate
            // #639: only a move beyond the fixes' accuracy, or the heartbeat, becomes a point.
            guard let reason = emitter.accept(location, stationary: stationary) else { continue }
            if stationary && reason == .moved { apply(stationary: false) } // motion updates missed the start of a move
            do {
                try local.enqueue(point) // Re-filters recipients against current consent before insert.
            } catch {
                try? local.setPaused(true, stopped: "storage_failed")
                local.message = Self.saveFailureMessage(error)
                evaluate()
                return
            }
        }
        repository.syncIfDue()
    }

    nonisolated static func saveFailureMessage(_ error: Error) -> String {
        error is QueueFullError ? error.localizedDescription : "Could not save location on this phone. Collection paused."
    }
}
