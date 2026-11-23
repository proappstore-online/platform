import CoreLocation
import MapKit
import SwiftUI

/// One app's track on a map.
struct MapTrack: Identifiable, Equatable {
    let id: String          // app id
    let color: Color
    let segments: [TrackShape.Segment]

    static func == (a: MapTrack, b: MapTrack) -> Bool { a.id == b.id && a.segments == b.segments }
}

/// Stable per-app colour by position in `/native/me`, whose order is stable. System colours, not new tokens.
enum TrackPalette {
    static let colors: [Color] = [.blue, .orange, .green, .pink]
    static func color(for appId: String, in apps: [ConnectedApp]) -> Color {
        colors[(apps.firstIndex { $0.id == appId } ?? 0) % colors.count]
    }
}

/// Draws shared tracks from the phone's own history. The live dot comes from the collector's last accepted fix,
/// never from MapKit's user location, which would start a second location consumer.
struct SharingMapView: View {
    let tracks: [MapTrack]
    /// The collector's last fix while it is running, or nil.
    let liveFix: CLLocationCoordinate2D?
    let liveFixAt: Date?
    var interactive = true
    var emptyText: String?
    @State private var position: MapCameraPosition = .automatic

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            let live = liveFixAt.map { context.date.timeIntervalSince($0) < 30 } == true ? liveFix : nil
            VStack(alignment: .leading, spacing: 4) {
                ZStack(alignment: .topTrailing) {
                    Map(position: $position, interactionModes: interactive ? .all : []) {
                        ForEach(tracks) { track in
                            ForEach(Array(track.segments.enumerated()), id: \.offset) { _, segment in
                                MapPolyline(coordinates: segment.samples.map(\.coordinate))
                                    .stroke(track.color, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round, dash: segment.pending ? [6, 6] : []))
                            }
                        }
                        if let live {
                            Annotation("Now", coordinate: live) {
                                Circle().fill(.blue).frame(width: 16, height: 16).overlay(Circle().stroke(.white, lineWidth: 3)).shadow(radius: 2)
                            }
                        } else if let last = lastSample {
                            Annotation(Self.time(last.at), coordinate: last.coordinate) {
                                Circle().stroke(.secondary, lineWidth: 3).background(Circle().fill(.background)).frame(width: 14, height: 14)
                            }
                        }
                    }
                    .onChange(of: tracks) { if !interactive { position = .automatic } }
                    if interactive {
                        Button { withAnimation { position = .automatic } } label: {
                            Label("Recenter", systemImage: "scope").labelStyle(.iconOnly).padding(8)
                        }
                        .background(.regularMaterial, in: Circle())
                        .padding(8)
                        .accessibilityLabel("Recenter")
                    }
                }
                .overlay(alignment: .bottom) {
                    if let text = isEmpty ? emptyText : (live == nil ? "Not sharing now" : nil) {
                        Text(text).font(.caption).padding(.horizontal, 10).padding(.vertical, 6)
                            .background(.regularMaterial, in: Capsule()).padding(8)
                    }
                }
                Text("Solid: uploaded · Dashed: waiting to upload").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var isEmpty: Bool { tracks.allSatisfy { $0.segments.isEmpty } }

    private var lastSample: TrackSample? {
        tracks.compactMap { $0.segments.last?.samples.last }.max { $0.at < $1.at }
    }

    static func time(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .omitted, time: .shortened)
    }
}

/// Loads tracks off the main actor: a day of walking can be over 10,000 points.
enum TrackLoader {
    static func load(_ local: LocalStore, apps: [ConnectedApp], all: [ConnectedApp], range: ClosedRange<Int64>) async -> [MapTrack] {
        await Task.detached(priority: .userInitiated) {
            apps.map { app in
                let samples = (try? local.track(appId: app.id, from: range.lowerBound, to: range.upperBound)) ?? []
                return MapTrack(id: app.id, color: TrackPalette.color(for: app.id, in: all), segments: TrackShape.segments(samples))
            }
        }.value
    }
}
