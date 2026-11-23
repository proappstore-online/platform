import SwiftUI

/// Whether Open first shows the Add to Home Screen guide (#628). Device UI preferences in UserDefaults, not
/// `LocalStore`: they survive `LocalStore.clear()` on pairing and disconnect.
struct InstallGuide {
    static let offKey = "installGuide.off", seenKey = "installGuide.seen"
    var defaults: UserDefaults = .standard

    func shouldShow(_ id: String) -> Bool { !off && !seen.contains(id) }

    var off: Bool {
        get { defaults.bool(forKey: Self.offKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.offKey) }
    }

    private var seen: [String] { defaults.stringArray(forKey: Self.seenKey) ?? [] }

    func markSeen(_ id: String) { if !seen.contains(id) { defaults.set(seen + [id], forKey: Self.seenKey) } }

    /// Open from the guide. "Don't show this again" (for every app) is saved only here, never on Cancel.
    func opened(_ id: String, dontShowAgain: Bool) {
        markSeen(id)
        if dontShowAgain { off = true }
    }
}

/// iOS cannot add a web app to the Home Screen for the user, so the first Open of each app explains how.
/// Illustrations are SF Symbols only.
struct InstallGuideSheet: View {
    let app: CatalogueApp
    var guide = InstallGuide()
    let open: () -> Void
    let cancel: () -> Void
    @State private var dontShow = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 14) {
                        AppIcon(app: app, size: 56)
                        Text("Add \(app.name) to your Home Screen").font(.title2.bold())
                    }
                    Text("It opens like an app, full screen, and stays signed in.").foregroundStyle(.secondary)
                    step(1, "safari", "Open \(app.name) in Safari.")
                    step(2, "square.and.arrow.up", "Tap Share in the toolbar. On newer iOS, it may be under •••.")
                    step(3, "plus.app", "Choose Add to Home Screen, then Add.")
                    Button {
                        guide.opened(app.id, dontShowAgain: dontShow)
                        open()
                    } label: {
                        Text("Open \(app.name)").font(.body.bold()).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    Toggle("Don't show this again", isOn: $dontShow)
                }
                .padding(24)
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) } }
        }
        .presentationDetents([.medium, .large])
    }

    private func step(_ number: Int, _ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
                .background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            Text(text).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Step \(number). \(text)")
    }
}
