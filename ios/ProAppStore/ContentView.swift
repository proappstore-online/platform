import AuthenticationServices
import CoreLocation
import SwiftUI
import UIKit

/// Screen state and actions, the iOS counterpart of MainActivity.kt.
@MainActor
final class CompanionModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    let repository: CompanionRepository
    let collector: LocationCollector
    let heartRate: HeartRateCollector
    private var local: LocalStore { repository.local }

    @Published private(set) var signedIn = false
    /// The device connection expired or was revoked (#652): history stays readable, Reconnect pairs again.
    @Published private(set) var expired = false
    /// Days until the connection expires, only when under 7 (#652).
    @Published private(set) var expiresInDays: Int?
    @Published private(set) var name = ""
    @Published private(set) var deviceLabel = ""
    @Published private(set) var apps: [ConnectedApp] = []
    /// Every reviewed (app, capability) entry (#631); `apps` stays location's.
    @Published private(set) var entries: [NativeEntry] = []
    @Published private(set) var queuedHeartRate = 0
    @Published private(set) var heartRateLastUpload: Int64 = 0
    @Published private(set) var heartRateSyncError = ""
    /// The newest heart-rate sample per app, from the on-device history.
    @Published private(set) var lastHeartRateByApp: [String: HeartRatePoint] = [:]
    @Published private(set) var blocked: Set<String> = []
    @Published private(set) var pausedApps: Set<String> = []
    @Published private(set) var paused = true
    @Published private(set) var queued = 0
    @Published private(set) var message = ""
    @Published private(set) var pairingCode = ""
    @Published private(set) var lastSync: Int64 = 0
    @Published private(set) var lastSyncAttempt: Int64 = 0
    @Published private(set) var lastSyncError = ""
    @Published private(set) var events: [ShareEvent] = []
    @Published private(set) var pendingByApp: [String: Int] = [:]
    @Published private(set) var lastUploadByApp: [String: Int64] = [:]
    @Published private(set) var busy = false
    @Published var consent: ConnectedApp?
    @Published var entryConsent: NativeEntry?
    private var error = ""
    private var authSession: ASWebAuthenticationSession?
    private var refreshTask: Task<Void, Never>?
    /// A link that matched nothing before the first sync stored the entries (#682), handled once more after it.
    private var pendingLink: URL?

    override convenience init() {
        let local: LocalStore
        do { local = try LocalStore() } catch { fatalError("ProAppStore could not open its storage.") }
        self.init(repository: CompanionRepository(local: local))
    }

    /// Tests pass a repository with a temporary store and a stubbed API.
    init(repository: CompanionRepository) {
        self.repository = repository
        collector = LocationCollector(repository: repository)
        heartRate = HeartRateCollector(repository: repository)
        super.init()
        if repository.token() != nil { try? local.seedIfEmpty() }
        refresh()
    }

    /// An expired connection's grants are gone on the server: nothing is enabled until the user re-enables it.
    func enabled(_ app: ConnectedApp) -> Bool { !expired && app.grantId != nil && !blocked.contains(app.id) }
    /// Enabled, not paused for this app, and Pause all is off.
    func sharing(_ app: ConnectedApp) -> Bool { enabled(app) && !pausedApps.contains(app.id) && !paused }
    /// A non-location entry is on: granted, not disabled, connection not expired.
    func enabled(_ entry: NativeEntry) -> Bool { !expired && entry.grantId != nil && !blocked.contains(entry.key) }
    /// Resume all can start something: a location app or any entry is enabled (#676). `apps` stays in: `entries` is
    /// empty until the first `/native/me` after an upgrade.
    var canResumeAll: Bool { apps.contains(where: enabled) || entries.contains(where: enabled) }
    /// This app's non-location entries, shown under its row.
    func otherEntries(_ appId: String) -> [NativeEntry] { entries.filter { $0.appId == appId && $0.capability != NativeEntry.LOCATION } }
    /// Both collectors follow the same rules: called wherever the screen changes what may be collected.
    func evaluate() { collector.evaluate(); heartRate.evaluate() }

    /// The app's state chip; `running` is the collector's.
    func state(_ app: ConnectedApp, running: Bool) -> SharingState {
        if expired { return .expired }
        return SharingState.of(granted: app.grantId != nil, blocked: blocked.contains(app.id), appPaused: pausedApps.contains(app.id), pausedAll: paused, running: running)
    }

    func refresh() {
        signedIn = repository.token() != nil
        expired = local.expired
        expiresInDays = signedIn ? CompanionRepository.expiresInDays(local.deviceExpiresAt) : nil
        entries = local.entries(); queuedHeartRate = (try? local.heartRateCount()) ?? 0; heartRateLastUpload = local.heartRateLastUpload
        heartRateSyncError = local.heartRateSyncError
        lastHeartRateByApp = Set(entries.filter { $0.capability == HeartRate.CAPABILITY }.map(\.appId))
            .reduce(into: [:]) { $0[$1] = (try? local.lastHeartRate($1)) ?? nil }
        name = local.userName; deviceLabel = local.deviceLabel; apps = local.apps(); blocked = local.blocked(); pausedApps = local.pausedApps(); paused = local.paused
        queued = (try? local.count()) ?? 0; lastSync = local.lastSync; pairingCode = repository.pairingCode()
        lastSyncAttempt = local.lastSyncAttempt; lastSyncError = local.lastSyncError
        events = (try? local.events()) ?? []
        pendingByApp = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, (try? local.pendingCount($0.id)) ?? 0) })
        lastUploadByApp = apps.reduce(into: [:]) { $0[$1.id] = (try? local.lastUpload($1.id)) ?? nil }
        message = error.isEmpty ? local.message : error
    }

    func becameActive() {
        refresh(); evaluate()
        refreshTask?.cancel()
        refreshTask = Task {
            await catchUp()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                refresh()
            }
        }
    }

    func resignActive() { refreshTask?.cancel() }

    /// Finishes a pending connection, then syncs. A connection error is shown until the next activation; sync
    /// failures are left to `local.message`, which every later successful sync clears, background ones included.
    func catchUp() async {
        do {
            _ = try await repository.finishSignIn()
            error = ""
        } catch { self.error = error.localizedDescription }
        if repository.token() != nil { try? await repository.sync() }
        refresh(); evaluate()
        if let link = pendingLink { handle(link); pendingLink = nil }
    }

    private func act(_ action: @escaping () async throws -> Void) {
        if busy { return }
        busy = true; error = ""
        Task {
            do { try await action() }
            catch let failure as ApiFailure where failure.status == 401 {} // the expired card says it
            catch { self.error = error.localizedDescription }
            busy = false; refresh(); evaluate()
        }
    }

    func connect() { act { [self] in try await pair() } }

    /// Pairs again without wiping the history (#652): after an expiry, or early from the Settings warning.
    func reconnect() {
        act { [self] in
            try await repository.renew()
            refresh(); evaluate()
            try await pair()
        }
    }

    private func pair() async throws {
        let label = "\(UIDevice.current.model) (iOS \(UIDevice.current.systemVersion))"
        let url = try await repository.startSignIn(label: label)
        refresh()
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "proappstore") { [weak self] _, _ in
            // Callback or cancel: the exchange itself decides whether the browser approved.
            Task { @MainActor in self?.completeSignIn() }
        }
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = self
        authSession = session
        session.start()
    }

    func completeSignIn() { act { [self] in _ = try await repository.finishSignIn() } }

    /// Links never grant anything: they finish a pending connection or bring a disclosure forward.
    /// `native/apps/<id>` keeps meaning location; `native/apps/<id>/<capability>` is that entry (ADR-018 §9).
    func handle(_ url: URL) {
        guard url.scheme == "proappstore", url.host == "native" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts == ["connected"] { completeSignIn() }
        else if parts.count == 2, parts[0] == "apps" {
            guard let app = apps.first(where: { $0.id == parts[1] }) else { return keep(url) }
            if !enabled(app) { consent = app }
        } else if parts.count == 3, parts[0] == "apps", parts[2] != NativeEntry.LOCATION {
            guard let entry = entries.first(where: { $0.appId == parts[1] && $0.capability == parts[2] }) else { return keep(url) }
            if !enabled(entry) { entryConsent = entry }
        }
    }

    /// Signed in, an unknown app or entry may only be missing until the first `/native/me` after an upgrade (#682).
    private func keep(_ url: URL) { if signedIn { pendingLink = url } }

    func enable(_ app: ConnectedApp) {
        act { [self] in
            try await repository.enable(app)
            if collector.authorization == .notDetermined { collector.requestWhenInUse() }
        }
    }
    func disable(_ app: ConnectedApp) { act { [self] in try await repository.disable(app) } }
    func enable(_ entry: NativeEntry) { act { [self] in try await repository.enable(entry) } }
    func disable(_ entry: NativeEntry) { act { [self] in try await repository.disable(entry) } }
    func sync() { act { [self] in try await repository.sync() } }
    func disconnect() {
        act { [self] in
            try local.setPaused(true); evaluate()
            try await repository.disconnect()
        }
    }
    func setPaused(_ value: Bool) {
        do { try local.setPaused(value) } catch { self.error = error.localizedDescription }
        if !value && collector.authorization == .notDetermined { collector.requestWhenInUse() }
        refresh(); evaluate()
    }

    /// Local only: the queue, and so pending uploads, are kept.
    func clearHistory() {
        do { try local.clearHistory() } catch { self.error = error.localizedDescription }
        refresh()
    }

    /// Local writes, not `act`: pausing works offline and instantly.
    func pause(_ app: ConnectedApp) {
        do { try local.pause(app.id) } catch { self.error = error.localizedDescription }
        refresh(); evaluate()
    }
    func resume(_ app: ConnectedApp) {
        do { try local.resume(app.id) } catch { self.error = error.localizedDescription }
        refresh(); evaluate()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}

/// The tab shell. Sheets, deep links and the scene phase live here so they work from every tab.
struct ContentView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @StateObject private var catalogue: CatalogueStore
    @Environment(\.scenePhase) private var phase
    @State private var tab: Tab

    enum Tab { case storefront, sharing, settings }

    /// Opens on Sharing when any app has a grant or the connection expired, otherwise on Storefront. Tests pass a tab
    /// and a catalogue store.
    @MainActor init(model: CompanionModel, collector: LocationCollector, tab: Tab? = nil, catalogue: CatalogueStore? = nil) {
        self.model = model; self.collector = collector
        _catalogue = StateObject(wrappedValue: catalogue ?? CatalogueStore())
        _tab = State(initialValue: tab ?? (model.expired || model.apps.contains { $0.grantId != nil } ? .sharing : .storefront))
    }

    var body: some View {
        TabView(selection: $tab) {
            StorefrontView(model: model, store: catalogue)
                .tabItem { Label("Storefront", systemImage: "square.grid.2x2") }
                .tag(Tab.storefront)
            SharingDashboardView(model: model, collector: collector)
                .tabItem { Label("Sharing", systemImage: "location.circle") }
                .tag(Tab.sharing)
            SettingsView(model: model, collector: collector)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .onChange(of: phase, initial: true) { _, phase in
            if phase == .active {
                model.becameActive()
                Task { await catalogue.refresh() } // foreground only: never from location callbacks
            } else { model.resignActive() }
        }
        .onOpenURL { model.handle($0) }
        .sheet(item: $model.consent) { app in disclosure(app) }
        .sheet(item: $model.entryConsent) { entry in HeartRateDisclosure(entry: entry, model: model) }
    }

    private func disclosure(_ app: ConnectedApp) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Enable location for \(app.name)?").font(.title2.bold())
            Text(app.disclosure)
            Button("Enable for \(app.name)") { model.consent = nil; model.enable(app) }.buttonStyle(.borderedProminent)
            Button("Cancel") { model.consent = nil }
            Spacer()
        }
        .padding(24)
        .presentationDetents([.medium, .large])
    }
}

/// Busy spinner and the last error, shown at the top of each tab.
struct StatusMessages: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        if model.busy { ProgressView().frame(maxWidth: .infinity) }
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.red) }
    }
}

/// The expired connection (#652): one way back that keeps the history.
struct ExpiredCard: View {
    @ObservedObject var model: CompanionModel

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Label("Connection expired", systemImage: "link.badge.plus").font(.title3.bold())
                Text("This phone is no longer connected to ProAppStore, so sharing has stopped. Your sharing history stays on this phone. Reconnect, then turn sharing back on for each app.")
                    .font(.subheadline)
                Button("Reconnect") { model.reconnect() }.buttonStyle(.borderedProminent).disabled(model.busy)
                if !model.pairingCode.isEmpty { Text("Match this code in your browser: \(model.pairingCode)").font(.footnote) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
    }
}
