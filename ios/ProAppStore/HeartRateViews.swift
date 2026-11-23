import Charts
import CoreBluetooth
import SwiftUI

/// The reviewed disclosure for a non-location entry (#631), shown before its grant.
struct HeartRateDisclosure: View {
    let entry: NativeEntry
    @ObservedObject var model: CompanionModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Enable \(entry.name.lowercased()) for \(entry.appName)?").font(.title2.bold())
                Text(entry.disclosure)
                Button("Enable for \(entry.appName)") { model.entryConsent = nil; model.enable(entry) }.buttonStyle(.borderedProminent)
                Button("Cancel") { model.entryConsent = nil }
            }
            .padding(24)
        }
        .presentationDetents([.medium, .large])
    }
}

/// One heart-rate line under its app's row: Enable, Choose sensor, state, Forget sensor, Turn off.
struct HeartRateLine: View {
    let entry: NativeEntry
    @ObservedObject var model: CompanionModel
    @ObservedObject var heartRate: HeartRateCollector
    @State private var choosing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("Heart rate", value: state)
            if !model.enabled(entry) {
                if !model.blocked.contains(entry.key) || entry.grantId == nil {
                    Button("Enable") { model.entryConsent = entry }.disabled(model.busy || model.expired)
                }
            } else {
                // The control room's figures for the heart-rate stream (#622's, for location).
                LabeledContent("Heart rate waiting to upload", value: "\(model.queuedHeartRate)")
                LabeledContent("Heart rate last upload", value: model.heartRateLastUpload > 0 ? relative(model.heartRateLastUpload) : "None yet")
                LabeledContent("Last reading", value: model.lastHeartRateByApp[entry.appId].map { "\($0.bpm) bpm, \(relative($0.at))" } ?? "None yet")
                if !model.heartRateSyncError.isEmpty {
                    Label("Heart-rate upload failed: \(model.heartRateSyncError)", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                        .font(.footnote).foregroundStyle(.orange)
                }
                HStack {
                    Button(model.repository.local.heartRateSensor == nil ? "Choose sensor" : "Change sensor") { choosing = true }
                        .buttonStyle(.bordered)
                    Spacer()
                    Menu {
                        if model.repository.local.heartRateSensor != nil { Button("Forget sensor") { heartRate.forget(); model.refresh() } }
                        Button("Turn off heart rate for \(entry.appName)", role: .destructive) { model.disable(entry) }
                    } label: { Label("More", systemImage: "ellipsis.circle").labelStyle(.iconOnly) }
                        .disabled(model.busy)
                        .accessibilityLabel("More heart-rate options for \(entry.appName)")
                }
            }
        }
        .sheet(isPresented: $choosing) { ChooseSensorSheet(heartRate: heartRate) { model.refresh() } }
    }

    private var state: String {
        if model.blocked.contains(entry.key) { return entry.grantId != nil ? "Turning off…" : "Off" }
        guard model.enabled(entry) else { return "Off" }
        if model.paused || model.pausedApps.contains(entry.appId) { return "Paused" }
        if model.repository.local.heartRateSensor == nil { return "No sensor chosen" }
        switch heartRate.bluetooth {
        case .poweredOff: return "Bluetooth is off"
        case .unauthorized: return "Bluetooth permission needed"
        default: break
        }
        guard heartRate.connected else { return "Not connected" }
        var parts = ["Connected"]
        if let bpm = heartRate.lastBpm { parts.append("\(bpm) bpm") }
        if model.heartRateLastUpload > 0 { parts.append("uploaded \(relative(model.heartRateLastUpload))") }
        return parts.joined(separator: " · ")
    }

    private func relative(_ ms: Int64) -> String { Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.relative(presentation: .named)) }
}

/// The only place ProAppStore scans: while this sheet is open, for the standard Heart Rate Service only. Names stay on
/// this phone.
struct ChooseSensorSheet: View {
    @ObservedObject var heartRate: HeartRateCollector
    let chosen: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if heartRate.discovered.isEmpty {
                        Label("Looking for heart-rate sensors. Put your strap on so it wakes up.", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    ForEach(heartRate.discovered) { sensor in
                        Button(sensor.name) { heartRate.choose(sensor); chosen(); dismiss() }
                    }
                } footer: {
                    Text("Only standard Bluetooth heart-rate sensors are listed. The sensor's name and identifier stay on this phone.")
                }
            }
            .navigationTitle("Choose sensor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Cancel") { dismiss() } }
        }
        .onAppear { heartRate.startScan() }
        .onDisappear { heartRate.stopScan() }
    }
}

/// Heart rate over the selected range, on the same time axis as the track: the mean line with its min-max band.
struct HeartRateChartView: View {
    let buckets: [HeartRateBucket]
    let range: ClosedRange<Int64>

    private static func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

    var body: some View {
        GroupBox("Heart rate") {
            Chart(buckets) { b in
                AreaMark(x: .value("Time", Self.date(b.start)), yStart: .value("Min", b.min), yEnd: .value("Max", b.max),
                         series: .value("Segment", b.segment))
                    .foregroundStyle(.red.opacity(0.15))
                LineMark(x: .value("Time", Self.date(b.start)), y: .value("bpm", b.mean), series: .value("Segment", b.segment))
                    .foregroundStyle(.red)
            }
            .chartXScale(domain: Self.date(range.lowerBound)...Self.date(range.upperBound))
            .chartYAxisLabel("bpm")
            .frame(height: 140)
            .accessibilityLabel("Heart rate from \(buckets.map(\.min).min() ?? 0) to \(buckets.map(\.max).max() ?? 0) bpm")
        }
    }
}
