import ActivityKit
import SwiftUI
import WidgetKit

/// The extension: one Live Activity and no home-screen widget (#625).
@main
struct SharingActivityBundle: WidgetBundle {
    var body: some Widget { SharingActivityWidget() }
}

/// "Sharing with Run, Ski" with the elapsed time and one Stop, on the Lock Screen and in the Dynamic Island. Started
/// only by the app in the foreground; no push updates.
struct SharingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SharingActivityAttributes.self) { context in
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(title(context.state), systemImage: "location.fill").font(.headline).lineLimit(2)
                    Text(context.state.since, style: .timer).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer()
                stop
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "location.fill") }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.since, style: .timer).monospacedDigit().frame(maxWidth: 80)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack { Text(title(context.state)).lineLimit(1); Spacer(); stop }
                }
            } compactLeading: {
                Image(systemName: "location.fill")
            } compactTrailing: {
                Text(context.state.since, style: .timer).monospacedDigit().frame(maxWidth: 48)
            } minimal: {
                Image(systemName: "location.fill")
            }
        }
    }

    private var stop: some View {
        Button(intent: StopSharingIntent()) { Label("Stop", systemImage: "stop.fill") }.buttonStyle(.bordered)
    }

    private func title(_ state: SharingActivityAttributes.ContentState) -> String {
        "Sharing with " + state.apps.formatted(.list(type: .and))
    }
}
