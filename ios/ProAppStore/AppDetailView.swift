import SwiftUI

/// One app's page: hero, header with Open, description, About, Pro features, website, and the companion toggle
/// for apps on the reviewed recipient list.
struct AppDetailView: View {
    let app: CatalogueApp
    @ObservedObject var model: CompanionModel
    let open: (CatalogueApp) -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                hero
                header
                if let connected = model.apps.first(where: { $0.id == app.id }) { companion(connected) }
                if let description = app.description { Text(description).font(.body) }
                if let about = app.about { aboutSection(about) }
                if let features = app.proFeatures, !features.isEmpty { featureSection(features) }
                if let website = app.websiteUrl {
                    Button { openURL(website) } label: { Label("Website", systemImage: "safari") }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(app.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The hero image at 1.91:1, or an `iconBg` band. Never the icon scaled up.
    @ViewBuilder private var hero: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        if let url = app.heroImageUrl {
            Color.clear
                .aspectRatio(1.91, contentMode: .fit)
                .overlay { RemoteImage(url: url) { app.tileColor } }
                .clipShape(shape)
                .accessibilityHidden(true)
        } else {
            shape.fill(app.tileColor.gradient).frame(height: 88).accessibilityHidden(true)
        }
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 16) { AppIcon(app: app, size: 96); titles; Spacer(minLength: 0) }
            VStack(alignment: .leading, spacing: 12) { AppIcon(app: app, size: 96); titles }
        }
    }

    private var titles: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(app.name).font(.title2.bold())
            Text(app.categoryName).font(.subheadline).foregroundStyle(.secondary)
            OpenButton(app: app, prominent: true, open: open).padding(.top, 6)
        }
    }

    /// The toggle only asks: on opens the existing disclosure sheet (`model.consent`), whose button alone enables.
    @ViewBuilder private func companion(_ connected: ConnectedApp) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                if model.signedIn {
                    Toggle(isOn: Binding(get: { model.enabled(connected) }, set: { on in
                        if on { model.consent = connected } else { model.disable(connected) }
                    })) {
                        Label("Use with companion", systemImage: "location.circle")
                    }
                    .disabled(model.busy)
                } else {
                    Label("Use with companion", systemImage: "location.circle").font(.headline)
                    Button("Sign in to use with ProAppStore") { model.connect() }.buttonStyle(.bordered).disabled(model.busy)
                }
                Text("Background location: \(connected.purpose)").font(.footnote).foregroundStyle(.secondary)
                if model.blocked.contains(connected.id) {
                    Text("Disabled on this phone. Server revocation will finish when connected.").font(.footnote)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func aboutSection(_ about: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("About").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            ForEach(Array(paragraphs(about).enumerated()), id: \.offset) { _, paragraph in Text(paragraph) }
        }
    }

    private func featureSection(_ features: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pro features").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            ForEach(features, id: \.self) { feature in
                Label { Text(feature) } icon: { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) }
            }
        }
    }

    private func paragraphs(_ text: String) -> [String] {
        text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}
