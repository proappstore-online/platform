import Combine
import CoreLocation
import Network
import SwiftUI
import UIKit

/// One app row's state chip. Pure, so every combination is table-tested.
enum SharingState: Equatable {
    case sharing, paused, pausedAll, off, turningOff, notRecording

    /// `blocked` with a grant still held means the server `DELETE` has not gone through yet.
    static func of(granted: Bool, blocked: Bool, appPaused: Bool, pausedAll: Bool, running: Bool) -> SharingState {
        if blocked { return granted ? .turningOff : .off }
        if !granted { return .off }
        if pausedAll { return .pausedAll }
        if appPaused { return .paused }
        return running ? .sharing : .notRecording
    }

    var label: String {
        switch self {
        case .sharing: "Sharing"
        case .paused: "Paused"
        case .pausedAll: "Paused (all)"
        case .off: "Off"
        case .turningOff: "Turning off…"
        case .notRecording: "Not recording"
        }
    }

    var color: Color {
        switch self {
        case .sharing: .green
        case .paused, .pausedAll, .turningOff: .orange
        case .off: .secondary
        case .notRecording: .red
        }
    }
}

/// Device conditions that can silently stop or thin out collection. Observed, never polled.
@MainActor
final class DeviceStatus: ObservableObject {
    @Published private(set) var online = true
    @Published private(set) var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    @Published private(set) var backgroundRefresh = UIApplication.shared.backgroundRefreshStatus
    private let monitor = NWPathMonitor()
    private var observers: [AnyCancellable] = []

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.online = online }
        }
        monitor.start(queue: DispatchQueue(label: "online.proappstore.companion.path"))
        observers.append(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange).receive(on: RunLoop.main).sink { [weak self] _ in
            self?.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        })
        observers.append(NotificationCenter.default.publisher(for: UIApplication.backgroundRefreshStatusDidChangeNotification).receive(on: RunLoop.main).sink { [weak self] _ in
            self?.backgroundRefresh = UIApplication.shared.backgroundRefreshStatus
        })
    }

    deinit { monitor.cancel() }
}

struct SharingDashboardView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @StateObject private var device = DeviceStatus()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatusMessages(model: model)
                    if model.signedIn { dashboard } else { signIn }
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Sharing")
        }
    }

    @ViewBuilder private var signIn: some View {
        Text("Your apps, connected to your phone").font(.headline)
        Text("Enable background features for the PAS apps you use. You stay in control of what each app can access.")
        Button("Sign in to ProAppStore") { model.connect() }.buttonStyle(.borderedProminent).disabled(model.busy)
        if !model.pairingCode.isEmpty { Text("Match this code in your browser: \(model.pairingCode)") }
    }

    private var granted: [ConnectedApp] { model.apps.filter { $0.grantId != nil } }
    private var available: [ConnectedApp] { model.apps.filter { $0.grantId == nil && !model.blocked.contains($0.id) } }

    @ViewBuilder private var dashboard: some View {
        header
        if model.apps.isEmpty { Text("No supported native features are available for your apps yet.") }
        ForEach(granted) { app in row(app) }
        if !available.isEmpty {
            Text("Available").font(.title3.bold())
            ForEach(available) { app in
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(app.name).font(.headline)
                        Text("Background location: \(app.purpose)").font(.subheadline)
                        Button("Enable") { model.consent = app }.disabled(model.busy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        deviceCard
    }

    // MARK: Header

    @ViewBuilder private var header: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text(status).font(.title3.bold())
                if model.paused {
                    Button("Resume all") { model.setPaused(false) }
                        .buttonStyle(.borderedProminent).disabled(model.busy || !model.apps.contains(where: model.enabled))
                } else {
                    Button("Pause all") { model.setPaused(true) }.buttonStyle(.bordered)
                }
                Text("\(model.queued) updates waiting to sync").font(.subheadline)
                syncHealth.font(.footnote)
                Button("Sync now") { model.sync() }.disabled(model.busy)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var status: String {
        if model.paused { return "Location paused" }
        let enabledApps = model.apps.filter(model.enabled)
        if !enabledApps.isEmpty && enabledApps.allSatisfy({ model.pausedApps.contains($0.id) }) { return "All apps paused" }
        if !collector.permitted { return "Location permission needed" }
        return collector.running ? "Location sharing is on" : "Location is not running"
    }

    /// The most severe state that applies. Retries happen only on a fix, on unlock and on opening the app:
    /// there is no timer, so the text says which of those will retry.
    @ViewBuilder private var syncHealth: some View {
        if !device.online {
            Label("Offline. Location is kept on this phone and uploads when you're back online.", systemImage: "wifi.slash")
        } else if !model.lastSyncError.isEmpty {
            Label {
                Text("Sync failed \(relative(model.lastSyncAttempt)): \(model.lastSyncError) ") +
                    Text(collector.running ? "Retrying with the next location update." : "Retries when you open ProAppStore.")
            } icon: { Image(systemName: "exclamationmark.arrow.triangle.2.circlepath") }
            .foregroundStyle(.orange)
        } else if model.lastSync > 0 {
            Label("Synced \(relative(model.lastSync))", systemImage: "checkmark.icloud")
        } else {
            Label("Not synced yet", systemImage: "icloud")
        }
    }

    // MARK: App rows

    private func row(_ app: ConnectedApp) -> some View {
        let state = SharingState.of(granted: app.grantId != nil, blocked: model.blocked.contains(app.id),
                                    appPaused: model.pausedApps.contains(app.id), pausedAll: model.paused, running: collector.running)
        let today = SharingTimeline.today()
        let shared = SharingTimeline.sessions(model.events, appId: app.id).reduce(0) { $0 + $1.sharedMs(within: today) }
        return GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(app.name).font(.headline)
                    Spacer()
                    Text(state.label).font(.caption.bold()).padding(.horizontal, 8).padding(.vertical, 3)
                        .background(state.color.opacity(0.15), in: Capsule()).foregroundStyle(state.color)
                }
                if state == .turningOff {
                    Text("Disabled on this phone. Server revocation will finish when connected.").font(.footnote)
                }
                LabeledContent("Shared today", value: duration(shared))
                LabeledContent("Last upload", value: model.lastUploadByApp[app.id].map(relative) ?? "None yet")
                LabeledContent("Waiting to upload", value: "\(model.pendingByApp[app.id] ?? 0)")
                if model.enabled(app) {
                    HStack {
                        if model.pausedApps.contains(app.id) {
                            Button("Resume") { model.resume(app) }.buttonStyle(.borderedProminent).disabled(model.paused)
                        } else {
                            Button("Pause") { model.pause(app) }.buttonStyle(.bordered)
                        }
                        Spacer()
                        // Not a one-tap button beside Pause: turning off deletes the app's platform copy.
                        Menu {
                            Button("Turn off sharing with \(app.name)", role: .destructive) { model.disable(app) }
                        } label: { Label("More", systemImage: "ellipsis.circle").labelStyle(.iconOnly) }
                            .disabled(model.busy)
                            .accessibilityLabel("More options for \(app.name)")
                    }
                    if model.paused && model.pausedApps.contains(app.id) {
                        Text("All sharing is paused. Resume location to continue.").font(.footnote)
                    }
                }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Device card

    @ViewBuilder private var deviceCard: some View {
        Text("This phone").font(.title3.bold())
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Location permission", value: authorizationLabel)
                PermissionControls(collector: collector)
                LabeledContent("Precise location", value: collector.fullAccuracy ? "On" : "Off")
                if !collector.fullAccuracy { Text("Off stops recording.").font(.footnote).foregroundStyle(.orange) }
                LabeledContent("Low Power Mode", value: device.lowPower ? "On" : "Off")
                if device.lowPower { Text("iOS may deliver fewer location updates.").font(.footnote).foregroundStyle(.orange) }
                LabeledContent("Background App Refresh", value: refreshLabel)
                // It gates only the significant-change relaunch, which needs Always.
                if collector.authorization == .authorizedAlways && device.backgroundRefresh != .available {
                    Text("ProAppStore can't restart recording after iOS closes it.").font(.footnote).foregroundStyle(.orange)
                }
                recorder
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var recorder: some View {
        if collector.running, let fix = collector.lastFixAt {
            LabeledContent("Recorder") { Text("Recording. Last fix \(Text(fix, style: .relative)) ago") }
        } else {
            LabeledContent("Recorder", value: collector.running ? "Recording. Waiting for a fix" : "Not recording")
        }
    }

    private var authorizationLabel: String {
        switch collector.authorization {
        case .notDetermined: "Not set"
        case .authorizedWhenInUse: "While Using"
        case .authorizedAlways: "Always"
        case .denied: "Denied"
        case .restricted: "Restricted"
        @unknown default: "Unknown"
        }
    }

    private var refreshLabel: String {
        switch device.backgroundRefresh {
        case .available: "On"
        case .denied: "Off"
        case .restricted: "Restricted"
        @unknown default: "Unknown"
        }
    }

    // MARK: Formatting

    private func relative(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.relative(presentation: .named))
    }

    /// "1 h 12 min", "8 min".
    private func duration(_ ms: Int64) -> String {
        let minutes = ms / 60_000
        return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(minutes) min"
    }
}
