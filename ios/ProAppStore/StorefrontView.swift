import SwiftUI

/// The native, browse-only storefront (ADR-017): featured, Yours, categories and All apps, or search results.
struct StorefrontView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var store: CatalogueStore
    @Environment(\.openURL) private var openURL
    @State var query = ""
    @State private var guideFor: CatalogueApp?
    var guide = InstallGuide()

    var body: some View {
        NavigationStack {
            ScrollView {
                if store.catalogue.apps.isEmpty { empty } else if query.trimmingCharacters(in: .whitespaces).isEmpty { browse } else { results }
            }
            .navigationTitle("Storefront")
            .searchable(text: $query, prompt: "Apps, categories and features")
            .refreshable { await store.refresh() }
            .navigationDestination(for: CatalogueApp.self) { app in AppDetailView(app: app, model: model, open: openApp) }
        }
        .sheet(item: $guideFor) { app in
            InstallGuideSheet(app: app, guide: guide, open: {
                guide.markSeen(app.id); guideFor = nil; openURL(app.appUrl)
            }, cancel: { guideFor = nil })
        }
    }

    /// Every Open button goes through here: the first time per app, the Add to Home Screen guide (#628).
    func openApp(_ app: CatalogueApp) {
        if guide.shouldShow(app.id) { guideFor = app } else { openURL(app.appUrl) }
    }

    private var catalogue: Catalogue { store.catalogue }

    /// Catalogue apps this phone has enabled for a companion feature.
    private var yours: [CatalogueApp] {
        let ids = Set(model.apps.filter(model.enabled).map(\.id))
        return model.signedIn ? catalogue.apps.filter { ids.contains($0.id) } : []
    }

    @ViewBuilder private var empty: some View {
        if store.loading {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
        } else {
            ContentUnavailableView {
                Label("Connect to the internet to load the store", systemImage: "wifi.slash")
            } description: {
                Text("The store works offline once it has loaded.")
            } actions: {
                Button("Retry") { Task { await store.refresh() } }.buttonStyle(.borderedProminent)
            }
            .padding(.top, 60)
        }
    }

    private var browse: some View {
        LazyVStack(alignment: .leading, spacing: 28) {
            if store.stale {
                Label("Showing the last downloaded copy.", systemImage: "icloud.slash")
                    .font(.footnote).foregroundStyle(.secondary).padding(.horizontal)
            }
            FeaturedBanner(apps: catalogue.featured)
            if !yours.isEmpty { shelf("Yours", apps: yours) }
            ForEach(catalogue.categories, id: \.name) { category in shelf(category.name, apps: category.apps) }
            VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: "All apps", detail: "\(catalogue.apps.count)")
                ForEach(catalogue.byName) { app in
                    AppRow(app: app, open: openApp)
                    if app.id != catalogue.byName.last?.id { Divider().padding(.leading, 76) }
                }
            }
        }
        .padding(.vertical, 8)
    }

    private func shelf(_ title: String, apps: [CatalogueApp]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: title, detail: apps.count > 1 ? "\(apps.count)" : nil)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(apps) { app in AppTile(app: app) }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
        }
    }

    @ViewBuilder private var results: some View {
        let found = catalogue.search(query)
        if found.isEmpty {
            ContentUnavailableView("No apps match “\(query.trimmingCharacters(in: .whitespaces))”", systemImage: "magnifyingglass")
                .padding(.top, 60)
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(found) { app in
                    AppRow(app: app, open: openApp)
                    if app.id != found.last?.id { Divider().padding(.leading, 76) }
                }
            }
            .padding(.vertical, 8)
        }
    }
}

private struct SectionHeader: View {
    let title: String
    let detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title2.bold())
            if let detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
        }
        .padding(.horizontal)
        .accessibilityAddTraits(.isHeader)
        .accessibilityElement(children: .combine)
    }
}

/// Paged cards, no autoplay: the hero image (or an `iconBg` panel with the emoji) over a caption strip, so text never
/// sits on an image it cannot be read against.
private struct FeaturedBanner: View {
    let apps: [CatalogueApp]

    var body: some View {
        TabView {
            ForEach(apps) { app in
                NavigationLink(value: app) { card(app) }
                    .buttonStyle(.plain)
                    .padding(.horizontal)
                    .padding(.bottom, 32)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Featured: \(app.name)")
                    .accessibilityHint(app.description ?? "")
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .always))
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .aspectRatio(1.25, contentMode: .fit)
    }

    private func card(_ app: CatalogueApp) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return VStack(spacing: 0) {
            // Takes what the caption leaves: about 1.91:1 at default text sizes.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    if let hero = app.heroImageUrl {
                        RemoteImage(url: hero) { panel(app) }
                    } else { panel(app) }
                }
                .clipped()
            HStack(spacing: 12) {
                AppIcon(app: app, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.categoryName.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(app.name).font(.headline).lineLimit(1)
                    Text(app.description ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .fixedSize(horizontal: false, vertical: true)
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(shape)
        .overlay { shape.strokeBorder(.primary.opacity(0.08), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
    }

    /// No hero: the app's colour with its emoji, never the icon image scaled up.
    private func panel(_ app: CatalogueApp) -> some View {
        Rectangle().fill(app.tileColor.gradient).overlay { Text(app.glyph).font(.system(size: 72)).accessibilityHidden(true) }
    }
}

/// A shelf tile: 64 pt icon, name, and one line of description.
private struct AppTile: View {
    let app: CatalogueApp
    @ScaledMetric(relativeTo: .subheadline) private var width: CGFloat = 132

    var body: some View {
        NavigationLink(value: app) {
            VStack(alignment: .leading, spacing: 8) {
                AppIcon(app: app, size: 64)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text(app.description ?? app.categoryName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(width: width, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

/// An All apps / search row: 48 pt icon, name, category, and Open.
struct AppRow: View {
    let app: CatalogueApp
    let open: (CatalogueApp) -> Void

    var body: some View {
        HStack(spacing: 12) {
            NavigationLink(value: app) {
                HStack(spacing: 12) {
                    AppIcon(app: app, size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.name).font(.body.weight(.semibold)).foregroundStyle(.primary)
                        Text(app.categoryName).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            OpenButton(app: app, prominent: false, open: open)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
    }
}

struct OpenButton: View {
    let app: CatalogueApp
    let prominent: Bool
    let open: (CatalogueApp) -> Void

    var body: some View {
        Group {
            if prominent {
                Button { open(app) } label: { Text("Open").font(.body.bold()).frame(minWidth: 72) }.buttonStyle(.borderedProminent)
            } else {
                Button { open(app) } label: { Text("Open").font(.subheadline.bold()).frame(minWidth: 52) }.buttonStyle(.bordered)
            }
        }
        .buttonBorderShape(.capsule)
        .accessibilityLabel("Open \(app.name)")
    }
}
