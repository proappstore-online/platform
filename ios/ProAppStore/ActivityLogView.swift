import SwiftUI

/// The on-device activity log: sharing changes and problems, newest first, grouped by day. No export: it stays
/// on the phone with the rest of the sharing history, and Clear sharing history clears it.
struct ActivityLogView: View {
    @ObservedObject var model: CompanionModel
    /// Filters to this app plus device-wide events, since a device-wide failure affects every app.
    var appId: String?
    @State private var filter = Filter.all

    enum Filter: String, CaseIterable { case all = "All", sharing = "Sharing changes", problems = "Problems" }

    private var events: [ShareEvent] {
        model.events.reversed().filter { event in
            (appId == nil || event.appId == nil || event.appId == appId) && {
                switch filter {
                case .all: true
                case .sharing: ActivityText.category(event.kind) == .sharing
                case .problems: ActivityText.category(event.kind) == .problem
                }
            }()
        }
    }

    private var days: [(day: Date, events: [ShareEvent])] {
        let calendar = Calendar.current
        var groups: [(day: Date, events: [ShareEvent])] = []
        for event in events {
            let day = calendar.startOfDay(for: Date(timeIntervalSince1970: Double(event.at) / 1000))
            if groups.last?.day == day { groups[groups.count - 1].events.append(event) } else { groups.append((day, [event])) }
        }
        return groups
    }

    var body: some View {
        List {
            if events.isEmpty { Text("Nothing recorded on this phone for this filter.").foregroundStyle(.secondary) }
            ForEach(days, id: \.day) { group in
                Section(group.day.formatted(date: .complete, time: .omitted)) {
                    ForEach(group.events, id: \.id) { event in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Image(systemName: ActivityText.symbol(event.kind))
                                .foregroundStyle(ActivityText.category(event.kind) == .problem ? Color.orange : Color.accentColor)
                                .frame(width: 24)
                            Text(ActivityText.sentence(for: event, appName: model.apps.first { $0.id == event.appId }?.name))
                            Spacer()
                            Text(SharingMapView.time(event.at)).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle(appId.flatMap { id in model.apps.first { $0.id == id }?.name }.map { "\($0) activity" } ?? "Activity")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Menu {
                Picker("Show", selection: $filter) { ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
            } label: { Label("Filter", systemImage: "line.3.horizontal.decrease.circle") }
        }
    }
}
