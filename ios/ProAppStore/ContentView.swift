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
    @Published private(set) var busy = false
    @Published var consent: ConnectedApp?
    private var error = ""
    private var authSession: ASWebAuthenticationSession?
    private var refreshTask: Task<Void, Never>?

    override init() {
        let local: LocalStore
        do { local = try LocalStore() } catch { fatalError("ProAppStore could not open its storage.") }
        repository = CompanionRepository(local: local)
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

struct ContentView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @Environment(\.scenePhase) private var phase
    @Environment(\.openURL) private var openURL
    @State private var disconnectPrompt = false
    @State private var clearHistoryPrompt = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("ProAppStore").font(.largeTitle.bold())
                Text("Your apps, connected to your phone")
                if !model.signedIn { signIn } else { account }
                if model.busy { ProgressView().frame(maxWidth: .infinity) }
                if !model.message.isEmpty { Text(model.message).foregroundStyle(.red) }
                about
            }
            .padding(24)
        }
        .onChange(of: phase, initial: true) { _, phase in
            if phase == .active { model.becameActive() } else { model.resignActive() }
        }
        .onOpenURL { model.handle($0) }
        .sheet(item: $model.consent) { app in disclosure(app) }
        .alert("Disconnect this phone?", isPresented: $disconnectPrompt) {
            Button("Disconnect", role: .destructive) { model.disconnect() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Stops location sharing and deletes this phone’s pending updates and platform location copies. Saved rides in your apps are separate. An internet connection is needed to finish.")
        }
        .alert("Clear sharing history?", isPresented: $clearHistoryPrompt) {
            Button("Clear history", role: .destructive) { model.clearHistory() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Deletes the sharing map and timeline kept on this phone. Updates waiting to sync still upload.")
        }
    }

    @ViewBuilder private var signIn: some View {
        Text("Enable background features for the PAS apps you use. You stay in control of what each app can access.")
        Button("Sign in to ProAppStore") { model.connect() }.buttonStyle(.borderedProminent).disabled(model.busy)
        if !model.pairingCode.isEmpty { Text("Match this code in your browser: \(model.pairingCode)") }
    }

    @ViewBuilder private var account: some View {
        Text(model.name).font(.headline)
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text(status).font(.title3.bold())
                permission
                if model.paused {
                    Button("Resume location") { model.setPaused(false) }
                        .buttonStyle(.borderedProminent).disabled(model.busy || !model.apps.contains(where: model.enabled))
                } else {
                    Button("Pause all") { model.setPaused(true) }.buttonStyle(.bordered)
                }
                Text("\(model.queued) updates waiting to sync").font(.subheadline)
                if model.lastSync > 0 {
                    Text("Last sync: \(Date(timeIntervalSince1970: Double(model.lastSync) / 1000).formatted(date: .omitted, time: .shortened))").font(.footnote)
                }
                Button("Sync now") { model.sync() }.disabled(model.busy)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        Text("App permissions").font(.title3.bold())
        if model.apps.isEmpty { Text("No supported native features are available for your apps yet.") }
        ForEach(model.apps) { app in
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text(app.name).font(.headline)
                    Text("Background location").font(.subheadline)
                    Text(!model.enabled(app) ? "Off" : model.pausedApps.contains(app.id) ? "Paused" : "Sharing").foregroundStyle(.tint)
                    if model.blocked.contains(app.id) {
                        Text("Disabled on this phone. Server revocation will finish when connected.").font(.footnote)
                    }
                    HStack {
                        if model.enabled(app) {
                            if model.pausedApps.contains(app.id) {
                                Button("Resume") { model.resume(app) }.disabled(model.paused)
                            } else {
                                Button("Pause") { model.pause(app) }
                            }
                        }
                        Button(model.enabled(app) ? "Disable" : "Enable") {
                            if model.enabled(app) { model.disable(app) } else { model.consent = app }
                        }.disabled(model.busy)
                    }
                    if model.paused && model.enabled(app) && model.pausedApps.contains(app.id) {
                        Text("All sharing is paused. Resume location to continue.").font(.footnote)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        Button("Manage account") { open("https://dashboard.proappstore.online") }
        Button("Clear sharing history") { clearHistoryPrompt = true }
        Button("Disconnect this phone") { disconnectPrompt = true }.disabled(model.busy)
    }

    @ViewBuilder private var about: some View {
        Text("About").font(.title3.bold())
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Version", value: AppInfo.current.version)
                LabeledContent("Build", value: AppInfo.current.build)
                LabeledContent("Commit", value: AppInfo.current.commit)
                if model.signedIn && !model.deviceLabel.isEmpty { LabeledContent("This phone", value: model.deviceLabel) }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("How your data is used") { open("https://docs.proappstore.online/native-companion-users/") }
        Button("Privacy policy") { open("https://proappstore.online/privacy") }
    }

    private var status: String {
        if model.paused { return "Location paused" }
        let enabledApps = model.apps.filter(model.enabled)
        if !enabledApps.isEmpty && enabledApps.allSatisfy({ model.pausedApps.contains($0.id) }) { return "All apps paused" }
        if !collector.permitted { return "Location permission needed" }
        return collector.running ? "Location sharing is on" : "Location is not running"
    }

    @ViewBuilder private var permission: some View {
        switch collector.authorization {
        case .notDetermined:
            Text("ProAppStore records your route for the apps you enable, including while your phone is locked. Choose Allow While Using App with Precise Location on.").font(.footnote)
            Button("Set up location") { collector.requestWhenInUse() }
        case .denied, .restricted:
            Text("Location access is off for ProAppStore.").font(.footnote)
            Button("Open Settings") { open(UIApplication.openSettingsURLString) }
        default:
            if !collector.fullAccuracy {
                Text("Turn on Precise Location in Settings. Approximate location is never used to record routes.").font(.footnote)
                Button("Use precise location") { collector.requestFullAccuracy() }
                Button("Open Settings") { open(UIApplication.openSettingsURLString) }
            } else if collector.authorization == .authorizedWhenInUse {
                Button("Keep recording after restarts") { collector.requestAlways() }
            }
        }
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

    private func open(_ link: String) { if let url = URL(string: link) { openURL(url) } }
}
