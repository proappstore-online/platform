import AuthenticationServices
import CoreLocation
import SwiftUI
import UIKit

/// Screen state and actions, the iOS counterpart of MainActivity.kt.
@MainActor
final class CompanionModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    let repository: CompanionRepository
    let collector: LocationCollector
    private var local: LocalStore { repository.local }

    @Published private(set) var signedIn = false
    @Published private(set) var name = ""
    @Published private(set) var deviceLabel = ""
    @Published private(set) var apps: [ConnectedApp] = []
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
    private var error = ""
    private var authSession: ASWebAuthenticationSession?
    private var refreshTask: Task<Void, Never>?

    override convenience init() {
        let local: LocalStore
        do { local = try LocalStore() } catch { fatalError("ProAppStore could not open its storage.") }
        self.init(repository: CompanionRepository(local: local))
    }

    /// Tests pass a repository with a temporary store and a stubbed API.
    init(repository: CompanionRepository) {
        self.repository = repository
        collector = LocationCollector(repository: repository)
        super.init()
        if repository.token() != nil { try? local.seedIfEmpty() }
        refresh()
    }

    func enabled(_ app: ConnectedApp) -> Bool { app.grantId != nil && !blocked.contains(app.id) }
    /// Enabled, not paused for this app, and Pause all is off.
    func sharing(_ app: ConnectedApp) -> Bool { enabled(app) && !pausedApps.contains(app.id) && !paused }

    func refresh() {
        signedIn = repository.token() != nil
        name = local.userName; deviceLabel = local.deviceLabel; apps = local.apps(); blocked = local.blocked(); pausedApps = local.pausedApps(); paused = local.paused
        queued = (try? local.count()) ?? 0; lastSync = local.lastSync; pairingCode = repository.pairingCode()
        lastSyncAttempt = local.lastSyncAttempt; lastSyncError = local.lastSyncError
        events = (try? local.events()) ?? []
        pendingByApp = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, (try? local.pendingCount($0.id)) ?? 0) })
        lastUploadByApp = apps.reduce(into: [:]) { $0[$1.id] = (try? local.lastUpload($1.id)) ?? nil }
        message = error.isEmpty ? local.message : error
    }

    func becameActive() {
        refresh(); collector.evaluate()
        refreshTask?.cancel()
        refreshTask = Task {
            do {
                _ = try await repository.finishSignIn()
                if repository.token() != nil { try await repository.sync() }
            } catch { self.error = error.localizedDescription }
            refresh(); collector.evaluate()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                refresh()
            }
        }
    }

    func resignActive() { refreshTask?.cancel() }

    private func act(_ action: @escaping () async throws -> Void) {
        if busy { return }
        busy = true; error = ""
        Task {
            do { try await action() } catch { self.error = error.localizedDescription }
            busy = false; refresh(); collector.evaluate()
        }
    }

    func connect() {
        act { [self] in
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
    }

    func completeSignIn() { act { [self] in _ = try await repository.finishSignIn() } }

    /// Links never grant anything: they finish a pending connection or bring a disclosure forward.
    func handle(_ url: URL) {
        guard url.scheme == "proappstore", url.host == "native" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts == ["connected"] { completeSignIn() }
        else if parts.count == 2, parts[0] == "apps", let app = apps.first(where: { $0.id == parts[1] }), !enabled(app) { consent = app }
    }

    func enable(_ app: ConnectedApp) {
        act { [self] in
            try await repository.enable(app)
            if collector.authorization == .notDetermined { collector.requestWhenInUse() }
        }
    }
    func disable(_ app: ConnectedApp) { act { [self] in try await repository.disable(app) } }
    func sync() { act { [self] in try await repository.sync() } }
    func disconnect() {
        act { [self] in
            try local.setPaused(true); collector.evaluate()
            try await repository.disconnect()
        }
    }
    func setPaused(_ value: Bool) {
        do { try local.setPaused(value) } catch { self.error = error.localizedDescription }
        if !value && collector.authorization == .notDetermined { collector.requestWhenInUse() }
        refresh(); collector.evaluate()
    }

    /// Local only: the queue, and so pending uploads, are kept.
    func clearHistory() {
        do { try local.clearHistory() } catch { self.error = error.localizedDescription }
        refresh()
    }

    /// Local writes, not `act`: pausing works offline and instantly.
    func pause(_ app: ConnectedApp) {
        do { try local.pause(app.id) } catch { self.error = error.localizedDescription }
        refresh(); collector.evaluate()
    }
    func resume(_ app: ConnectedApp) {
        do { try local.resume(app.id) } catch { self.error = error.localizedDescription }
        refresh(); collector.evaluate()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}

/// The tab shell. Sheets, deep links and the scene phase live here so they work from every tab.
struct ContentView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @Environment(\.scenePhase) private var phase
    @State var tab = Tab.sharing

    /// The Storefront tab (its own issue) goes first, ahead of Sharing.
    enum Tab { case sharing, settings }

    var body: some View {
        TabView(selection: $tab) {
            SharingDashboardView(model: model, collector: collector)
                .tabItem { Label("Sharing", systemImage: "location.circle") }
                .tag(Tab.sharing)
            SettingsView(model: model, collector: collector)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .onChange(of: phase, initial: true) { _, phase in
            if phase == .active { model.becameActive() } else { model.resignActive() }
        }
        .onOpenURL { model.handle($0) }
        .sheet(item: $model.consent) { app in disclosure(app) }
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
