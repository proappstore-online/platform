import SwiftUI

/// A stretch of one session: shared, or inactive for a cause.
struct SharingPeriod: Equatable, Identifiable {
    let start: Int64
    let end: Int64
    let cause: InactiveCause?   // nil = shared
    var id: Int64 { start }
}

extension SharingSession {
    /// The session cut into shared and inactive stretches, in order. Open ends run to `now`.
    func periods(now: Int64) -> [SharingPeriod] {
        var periods: [SharingPeriod] = []
        var cursor = start
        for interval in inactive {
            if interval.start > cursor { periods.append(SharingPeriod(start: cursor, end: interval.start, cause: nil)) }
            let end = interval.end ?? end ?? now
            periods.append(SharingPeriod(start: interval.start, end: end, cause: interval.cause))
            cursor = end
        }
        let last = end ?? now
        if last > cursor { periods.append(SharingPeriod(start: cursor, end: last, cause: nil)) }
        return periods
    }
}

/// One app's map, summary and session timeline. Everything comes from the phone; opening it makes no PAS request.
struct AppSharingView: View {
    let app: ConnectedApp
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @State private var selection = Selection.today
    @State var expanded: Set<Int64> = []
    @State private var track: [MapTrack] = []

    enum Selection: Hashable {
        case today, session, custom(ClosedRange<Int64>)
    }

    private var now: Int64 { CompanionRepository.now() }
    private var sessions: [SharingSession] { SharingTimeline.sessions(model.events, appId: app.id) }
    private var current: SharingSession? { sessions.last }

    /// The track's range. Open ends run to `Int64.max`, not `now`, so the task key is stable (#648).
    private var range: ClosedRange<Int64> {
        switch selection {
        case .today: SharingTimeline.todayTrack()
        case .session: current.map { $0.start...($0.end ?? .max) } ?? SharingTimeline.todayTrack()
        case .custom(let range): range
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Range", selection: $selection) {
                    Text("Today").tag(Selection.today)
                    Text("Session").tag(Selection.session)
                    if case .custom = selection { Text("Selected").tag(selection) }
                }
                .pickerStyle(.segmented)
                SharingMapView(tracks: track, liveFix: model.sharing(app) && collector.running ? collector.lastFix : nil,
                               liveFixAt: collector.lastFixAt, emptyText: "No location was shared with \(app.name) in this period.")
                    .frame(height: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                summary
                NavigationLink { ActivityLogView(model: model, appId: app.id) } label: {
                    HStack { Label("Activity", systemImage: "list.bullet.rectangle"); Spacer(); Image(systemName: "chevron.right").foregroundStyle(.secondary) }
                }
                .buttonStyle(.plain)
                timeline
            }
            .padding(24)
        }
        .navigationTitle(app.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: TrackKey(range: range, queued: model.queued, lastSync: model.lastSync)) {
            track = await TrackLoader.load(model.repository.local, apps: [app], all: model.apps, range: range)
        }
    }

    // MARK: Summary

    @ViewBuilder private var summary: some View {
        let state = SharingState.of(granted: app.grantId != nil, blocked: model.blocked.contains(app.id),
                                    appPaused: model.pausedApps.contains(app.id), pausedAll: model.paused, running: collector.running)
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(state.label).font(.headline).foregroundStyle(state.color)
                    Spacer()
                    if model.enabled(app) {
                        if model.pausedApps.contains(app.id) {
                            Button("Resume") { model.resume(app) }.buttonStyle(.borderedProminent).disabled(model.paused)
                        } else {
                            Button("Pause") { model.pause(app) }.buttonStyle(.bordered)
                        }
                    }
                }
                LabeledContent("Shared today", value: Self.duration(sessions.reduce(0) { $0 + $1.sharedMs(within: SharingTimeline.today()) }))
                if let current, current.end == nil {
                    LabeledContent("Shared in this session", value: Self.duration(current.sharedMs(within: current.start...now)))
                    LabeledContent("Session started", value: Self.dateTime(current.start))
                }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Sessions

    @ViewBuilder private var timeline: some View {
        Text("Sessions").font(.title3.bold())
        if sessions.isEmpty { Text("No sharing recorded on this phone yet.").font(.subheadline) }
        ForEach(sessions.reversed(), id: \.start) { session in
            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        selection = .custom(session.start...(session.end ?? now))
                        if expanded.contains(session.start) { expanded.remove(session.start) } else { expanded.insert(session.start) }
                    } label: {
                        HStack {
                            Text(sessionLine(session)).multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: expanded.contains(session.start) ? "chevron.up" : "chevron.down")
                        }
                    }
                    .buttonStyle(.plain)
                    if session.start < now - LocationPolicy.HISTORY_MS {
                        Text("Started before \(Self.dateTime(now - LocationPolicy.HISTORY_MS)); older history is not kept.").font(.footnote)
                    }
                    if expanded.contains(session.start) {
                        ForEach(session.periods(now: now)) { period in
                            Button { selection = .custom(period.start...period.end) } label: {
                                Text("\(Self.time(period.start))–\(Self.time(period.end)) \(Self.label(period.cause))")
                                    .foregroundStyle(period.cause == nil ? Color.primary : Color.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                        if let kind = session.endKind { Text("Ended: \(Self.label(kind))").foregroundStyle(.secondary) }
                    }
                }
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func sessionLine(_ session: SharingSession) -> String {
        let end = session.end.map { " · Ended \(Self.time($0))" } ?? " · Ongoing"
        return "Started \(Self.dateTime(session.start))\(end) · Shared \(Self.duration(session.sharedMs(within: session.start...(session.end ?? now))))"
    }

    // MARK: Text

    static func label(_ cause: InactiveCause?) -> String {
        switch cause {
        case nil: "shared"
        case .you: "paused by you"
        case .all: "Pause all"
        case .system(let detail):
            "stopped: " + (["signed_out": "signed out", "storage_failed": "storage", "unlock_failed": "unlock"][detail] ?? detail)
        }
    }

    static func label(_ end: ShareEvent.Kind) -> String {
        switch end {
        case .disabled: "turned off"
        case .grantLost: "revoked by ProAppStore"
        case .historyCleared: "history cleared"
        default: end.rawValue
        }
    }

    static func duration(_ ms: Int64) -> String {
        let minutes = ms / 60_000
        return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(minutes) min"
    }

    static func time(_ ms: Int64) -> String { SharingMapView.time(ms) }

    static func dateTime(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }
}

/// Reload the track when the range changes or new points arrive or upload.
struct TrackKey: Equatable {
    let range: ClosedRange<Int64>
    let queued: Int
    let lastSync: Int64
}
