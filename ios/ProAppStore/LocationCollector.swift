import CoreLocation
import UIKit

/// Background route collection, the iOS counterpart of LocationService.kt. Collection runs only while a credential
/// exists, precise While Using (or a leftover Always) access is granted, and an app with a grant has a session the user
/// started (ADR-020). Every callback re-checks those conditions and ends the sessions that are due.
@MainActor
final class LocationCollector: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var authorization: CLAuthorizationStatus
    @Published private(set) var fullAccuracy: Bool
    @Published private(set) var running = false
    /// Time and place of the last accepted fix, in memory only: the map's live dot. Never a second location
    /// source (no MapKit user location).
    @Published private(set) var lastFixAt: Date?
    @Published private(set) var lastFix: CLLocationCoordinate2D?
    /// The apps whose sessions may collect now, set by `CompanionModel`: none until the companion has been opened in this
    /// process (its `live` gate, ADR-020 §7), so a background relaunch collects nothing.
    var sessions: () -> Set<String> = { [] }
    /// Called after every authorization change, for a Start waiting on the While Using prompt.
    var authorizationChanged: () -> Void = {}
    /// Called at the end of every `evaluate()`, for the Lock Screen activity (#625).
    var evaluated: () -> Void = {}

    private let manager = CLLocationManager()
    private let repository: CompanionRepository
    private var local: LocalStore { repository.local }
    private var lastAcceptedAt: Int64 = 0
    private var emitter = EmitFilter()
    /// CoreLocation's motion state while collecting (#639): stationary turns GPS off and holds back jitter.
    private var stationary = false
    private var motion: Task<Void, Never>?
    private var activity: CLBackgroundActivitySession?
    /// Ends due sessions while running, including with the phone locked: the app is not suspended while background
    /// location updates run.
    private var dueCheck: Timer?

    init(repository: CompanionRepository) {
        self.repository = repository
        authorization = manager.authorizationStatus
        fullAccuracy = manager.accuracyAuthorization == .fullAccuracy
        super.init()
        manager.delegate = self
        apply(stationary: false)                          // best accuracy, 5 m distance filter
        manager.activityType = .fitness
        manager.pausesLocationUpdatesAutomatically = false // sessions end by ADR-020's rules, not iOS's
        manager.allowsBackgroundLocationUpdates = true     // requires UIBackgroundModes=location
        manager.showsBackgroundLocationIndicator = true    // visible, like Android's notification (ADR-020 §5)
        // Unlock: upload the tail of a locked segment before the user reopens their app.
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.flush() }
        }
    }

    var permitted: Bool {
        (authorization == .authorizedWhenInUse || authorization == .authorizedAlways) && fullAccuracy
    }

    /// The location grants for a fix taken at `at`.
    func recipients(at: Int64) -> [String] {
        LocationPolicy.recipients(local.apps(), blocked: local.blocked(), sessions: sessions(), at: at)
    }

    /// Starts or stops collection to match the current rules. Called on activation, a Start or Stop, every
    /// authorization change and every delivered fix. Never on a background launch: with no session live yet there are
    /// no recipients, so nothing starts.
    func evaluate() {
        if repository.token() != nil && permitted && !recipients(at: CompanionRepository.now()).isEmpty {
            if !running {
                emitter = EmitFilter() // a new session starts with a point, not a heartbeat later
                manager.startUpdatingLocation(); running = true
                watchMotion()
                dueCheck = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.endDueSessions(); self?.evaluate() }
                }
            }
        } else {
            manager.stopUpdatingLocation()
            if running { running = false }
            motion?.cancel(); motion = nil
            activity?.invalidate(); activity = nil
            dueCheck?.invalidate(); dueCheck = nil
            apply(stationary: false)
        }
        evaluated()
    }

    /// Ends the sessions that are due (ADR-020 §3): precise or location permission withdrawn, or the stationary and
    /// 12-hour rules. `.notDetermined` holds no session (Start asks first), so it ends nothing.
    func endDueSessions() {
        if authorization != .notDetermined && !permitted { try? local.endAllSessions("permission") }
        repository.endDueSessions()
    }

    /// Motion state only: points still come from `manager`. `liveUpdates` pauses itself while the phone is still,
    /// and the background activity session keeps its updates coming while locked, under While Using too. Created only
    /// here, from a session the user started in the foreground, never rejoined on a background launch (ADR-020 §7).
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
    func requestFullAccuracy() { manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "RouteRecording") }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            let old = (authorization, fullAccuracy)
            authorization = self.manager.authorizationStatus
            fullAccuracy = self.manager.accuracyAuthorization == .fullAccuracy
            // Activity log: changes only, never the first report.
            if old.0 != authorization { try? local.record(.permission, detail: "\(Self.name(old.0))→\(Self.name(authorization))") }
            if old.1 != fullAccuracy { try? local.record(.permission, detail: fullAccuracy ? "approximate→precise" : "precise→approximate") }
            endDueSessions()
            evaluate()
            authorizationChanged()
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
        endDueSessions()
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
                try local.enqueue(point) // Re-filters recipients against current consent and sessions before insert.
                if SharingSessions.isMovement(reason) { try local.moved(now: point.at) }
            } catch {
                try? local.stop("storage_failed")
                local.message = Self.saveFailureMessage(error)
                evaluate()
                return
            }
        }
        repository.syncIfDue()
    }

    nonisolated static func saveFailureMessage(_ error: Error) -> String {
        error is QueueFullError ? error.localizedDescription : "Could not save location on this phone. Sharing stopped."
    }
}
