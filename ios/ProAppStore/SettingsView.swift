import CoreLocation
import SwiftUI
import UIKit

/// Account, permissions, history and About: the account block of the original single screen, moved as is.
struct SettingsView: View {
    @ObservedObject var model: CompanionModel
    @ObservedObject var collector: LocationCollector
    @Environment(\.openURL) private var openURL
    @State private var disconnectPrompt = false
    @State private var clearHistoryPrompt = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatusMessages(model: model)
                    if model.expired { ExpiredCard(model: model) }
                    if model.signedIn || model.expired { account }
                    about
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("Settings")
        }
        .alert("Disconnect this phone?", isPresented: $disconnectPrompt) {
            Button("Disconnect", role: .destructive) { model.disconnect() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Stops location sharing and deletes this phone’s pending updates and platform location copies. Saved rides in your apps are separate. An internet connection is needed to finish.")
        }
        .alert("Clear sharing history?", isPresented: $clearHistoryPrompt) {
            Button("Clear history", role: .destructive) { model.clearHistory() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Deletes the sharing map and timeline kept on this phone. Updates waiting to sync still upload.")
        }
    }

    @ViewBuilder private var account: some View {
        Text(model.name).font(.headline)
        if let days = model.expiresInDays {
            VStack(alignment: .leading, spacing: 4) {
                Text("Connection renews when you reconnect — expires in \(days) day\(days == 1 ? "" : "s")").font(.footnote).foregroundStyle(.secondary)
                Button("Reconnect") { model.reconnect() }.font(.footnote).disabled(model.busy)
            }
        }
        GroupBox("Location permission") {
            VStack(alignment: .leading, spacing: 8) {
                PermissionControls(collector: collector)
                if collector.permitted { Text("Precise location is on.").font(.footnote) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("Manage account") { open("https://dashboard.proappstore.online") }
        Button("Clear sharing history") { clearHistoryPrompt = true }
        Button("Disconnect this phone") { disconnectPrompt = true }.disabled(model.busy)
        Button("Delete account") { open(Self.deleteAccountURL) }
    }

    @ViewBuilder private var about: some View {
        Text("About").font(.title3.bold())
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Version", value: AppInfo.current.version)
                LabeledContent("Build", value: AppInfo.current.build)
                LabeledContent("Commit", value: AppInfo.current.commit)
                if model.signedIn && !model.deviceLabel.isEmpty { LabeledContent("This phone", value: model.deviceLabel) }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        Button("How your data is used") { open("https://docs.proappstore.online/native-companion-users/") }
        Button("Privacy policy") { open("https://proappstore.online/privacy") }
        // Signed out, Delete account is still reachable here (App Review 5.1.1(v)); signed in, it sits in the account block.
        if !(model.signedIn || model.expired) { Button("Delete account") { open(Self.deleteAccountURL) } }
    }

    /// App Review 5.1.1(v) / #685: account deletion starts in the app. There is no platform account-deletion API yet,
    /// so this opens the web deletion steps, the same page Android (#663) and Play Console link to.
    static let deleteAccountURL = "https://proappstore.online/privacy#data-deletion"

    private func open(_ link: String) { if let url = URL(string: link) { openURL(url) } }
}

/// The location permission explanation and the buttons that fix it, for whichever state applies.
struct PermissionControls: View {
    @ObservedObject var collector: LocationCollector
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch collector.authorization {
        case .notDetermined:
            Text("ProAppStore records your route for the apps you enable, including while your phone is locked. Choose Allow While Using App with Precise Location on.").font(.footnote)
            Button("Set up location") { collector.requestWhenInUse() }
        case .denied, .restricted:
            Text("Location access is off for ProAppStore.").font(.footnote)
            Button("Open Settings") { openSettings() }
        default:
            if !collector.fullAccuracy {
                Text("Turn on Precise Location in Settings. Approximate location is never used to record routes.").font(.footnote)
                Button("Use precise location") { collector.requestFullAccuracy() }
                Button("Open Settings") { openSettings() }
            } else if collector.authorization == .authorizedWhenInUse {
                Button("Keep recording after restarts") { collector.requestAlways() }
            }
        }
    }

    private func openSettings() { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
}
