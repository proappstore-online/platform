import Combine
import CoreLocation
import Network
import SwiftUI
import UIKit

/// One app row's state chip. Pure, so every combination is table-tested.
enum SharingState: Equatable {
    case sharing, notSharing, off, turningOff, notRecording, expired

    /// `blocked` with a grant still held means the server `DELETE` has not gone through yet. `session`: the app has a
    /// collection session (ADR-020).
    static func of(granted: Bool, blocked: Bool, session: Bool, running: Bool) -> SharingState {
        if blocked { return granted ? .turningOff : .off }
        if !granted { return .off }
        if !session { return .notSharing }
        return running ? .sharing : .notRecording
    }

    var label: String {
        switch self {
        case .sharing: "Sharing"
        case .notSharing: "Not sharing"
        case .off: "Off"
        case .turningOff: "Turning off…"
        case .notRecording: "Not recording"
        case .expired: "Connection expired"
        }
    }

    var color: Color {
        switch self {
        case .sharing: .green
        case .turningOff: .orange
        case .notSharing, .off, .expired: .secondary
        case .notRecording: .red
        }
    }
}

/// Device conditions that can silently stop or thin out collection. Observed, never polled.
@MainActor
final class DeviceStatus: ObservableObject {
    @Published private(set) var online = true
    @Published private(set) var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
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
    }

    deinit { monitor.cancel() }
}

/// ADR-020: Start, or Stop with the elapsed time while the app has a session. Stop never touches the grant; Start needs
/// no new disclosure. Start is off while location is denied or approximate: PermissionControls shows the fix.
struct StartStopButton: View {
    let app: ConnectedApp
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector

    var body: some View {
        if let session = model.sessions[app.id] {
            HStack {
                Button("Stop") { model.stop(app) }.buttonStyle(.bordered)
                Text("Sharing · \(AppSharingView.duration(CompanionRepository.now() - session.startedAt))").font(.footnote)
            }
        } else {
            Button("Start") { model.start(app) }.buttonStyle(.borderedProminent)
                .disabled(model.busy || !(collector.permitted || collector.authorization == .notDetermined))
        }
    }
}

struct SharingDashboardView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @StateObject private var device = DeviceStatus()
    /// Apps hidden from the overview map. Not persisted.
    @State private var hidden: Set<String> = []
    @State private var tracks: [MapTrack] = []
    @State private var fullMap = false

    /// The pushed app pages. A link to an app whose session runs opens its page (ADR-020 §2).
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatusMessages(model: model)
                    if model.expired { ExpiredCard(model: model) }
                    if model.signedIn || model.expired { dashboard } else { signIn }
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Sharing")
            .toolbar {
                if model.signedIn || model.expired {
                    NavigationLink { ActivityLogView(model: model) } label: { Label("Activity", systemImage: "list.bullet.rectangle") }
                }
            }
            .navigationDestination(for: String.self) { id in
                if let app = model.apps.first(where: { $0.id == id }) { AppSharingView(app: app, model: model, collector: collector) }
            }
        }
        .onChange(of: model.openApp, initial: true) { _, id in
            guard let id else { return }
            path = [id]; model.openApp = nil
        }
        .task(id: TrackKey(range: SharingTimeline.todayTrack(), queued: model.queued, lastSync: model.lastSync)) {
            tracks = await TrackLoader.load(model.repository.local, apps: granted, all: model.apps, range: SharingTimeline.todayTrack())
        }
        .fullScreenCover(isPresented: $fullMap) {
            NavigationStack {
                overviewMap(interactive: true)
                    .ignoresSafeArea(edges: .bottom)
                    .navigationTitle("Today")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button("Done") { fullMap = false } }
            }
        }
    }

    private var liveFix: CLLocationCoordinate2D? { collector.running ? collector.lastFix : nil }

    private func overviewMap(interactive: Bool) -> some View {
        SharingMapView(tracks: tracks.filter { !hidden.contains($0.id) }, liveFix: liveFix, liveFixAt: collector.lastFixAt, interactive: interactive)
    }

    /// Today's track for every app with a grant, plus the live dot. Tap to open full screen.
    @ViewBuilder private var overview: some View {
        overviewMap(interactive: false)
            .frame(height: UIScreen.main.bounds.height * 0.4)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
            .onTapGesture { fullMap = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Today's sharing map. Opens full screen.")
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(granted) { app in
                    let on = !hidden.contains(app.id)
                    let color = TrackPalette.color(for: app.id, in: model.apps)
                    Button {
                        if on { hidden.insert(app.id) } else { hidden.remove(app.id) }
                    } label: {
                        Label(app.name, systemImage: on ? "checkmark.circle.fill" : "circle")
                            .font(.subheadline).padding(.horizontal, 10).padding(.vertical, 5)
                            .background(color.opacity(on ? 0.2 : 0.06), in: Capsule()).foregroundStyle(on ? color : .secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(on ? "Shown" : "Hidden")
                }
            }
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
        if !granted.isEmpty { overview }
        if !model.expired { header }
        if model.apps.isEmpty && !model.expired { Text("No supported native features are available for your apps yet.") }
        ForEach(granted) { app in row(app) }
        if !available.isEmpty && !model.expired {
            Text("Available").font(.title3.bold())
            ForEach(available) { app in
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(app.name).font(.headline)
                        Text("Background location: \(app.purpose)").font(.subheadline)
                        Button("Enable") { model.consent = app }.disabled(model.busy)
                        heartRateLines(app)
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
                // ADR-020: sharing runs only in sessions started with Start on an app; Stop all ends every one.
                if model.sessions.isEmpty {
                    Text("Tap Start on an app to share while you record. Sharing stops when you tap Stop, after 30 minutes without moving, or after 12 hours.")
                        .font(.footnote)
                } else {
                    Button("Stop all") { model.stopAll() }.buttonStyle(.bordered)
                }
                Text("\(model.queued) updates waiting to sync").font(.subheadline)
                syncHealth.font(.footnote)
                Button("Sync now") { model.sync() }.disabled(model.busy)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var status: String {
        if model.sessions.isEmpty { return "Not sharing location" }
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
        let state = model.state(app, running: collector.running)
        let today = SharingTimeline.today()
        let shared = SharingTimeline.sessions(model.events, appId: app.id).reduce(0) { $0 + $1.sharedMs(within: today) }
        return GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                NavigationLink(value: app.id) {
                    HStack {
                        Circle().fill(TrackPalette.color(for: app.id, in: model.apps)).frame(width: 10, height: 10)
                        Text(app.name).font(.headline)
                        Spacer()
                        Text(state.label).font(.caption.bold()).padding(.horizontal, 8).padding(.vertical, 3)
                            .background(state.color.opacity(0.15), in: Capsule()).foregroundStyle(state.color)
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                if state == .turningOff {
                    Text("Disabled on this phone. Server revocation will finish when connected.").font(.footnote)
                }
                LabeledContent("Shared today", value: duration(shared))
                LabeledContent("Last upload", value: model.lastUploadByApp[app.id].map(relative) ?? "None yet")
                LabeledContent("Waiting to upload", value: "\(model.pendingByApp[app.id] ?? 0)")
                if model.enabled(app) {
                    HStack {
                        StartStopButton(app: app, model: model, collector: collector)
                        Spacer()
                        // Not a one-tap button beside Stop: turning off deletes the app's platform copy.
                        Menu {
                            Button("Turn off sharing with \(app.name)", role: .destructive) { model.disable(app) }
                        } label: { Label("More", systemImage: "ellipsis.circle").labelStyle(.iconOnly) }
                            .disabled(model.busy)
                            .accessibilityLabel("More options for \(app.name)")
                    }
                }
                heartRateLines(app)
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// #631: the app's heart rate, one line under its row; it follows the app's session.
    @ViewBuilder private func heartRateLines(_ app: ConnectedApp) -> some View {
        ForEach(model.otherEntries(app.id).filter { $0.capability == HeartRate.CAPABILITY }) { entry in
            Divider()
            HeartRateLine(entry: entry, model: model, heartRate: model.heartRate)
            // Location turned off during a session (#677): the row has no Stop, and the kept session must still end.
            if !model.enabled(app) && model.sessions[app.id] != nil { StartStopButton(app: app, model: model, collector: collector) }
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

    // MARK: Formatting

    private func relative(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.relative(presentation: .named))
    }

    private func duration(_ ms: Int64) -> String { AppSharingView.duration(ms) }
}
