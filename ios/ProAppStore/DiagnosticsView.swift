import SwiftUI

/// Settings → Diagnostics (#660, ADR-019): the switch, when the last report was sent, the exact report, and how to read it
/// with Claude. Its state lives in the store; the model's periodic refresh redraws it.
struct DiagnosticsView: View {
    @ObservedObject var model: CompanionModel
    @State private var offPrompt = false
    @State private var showReport = false
    private var local: LocalStore { model.repository.local }

    var body: some View {
        let enabled = local.diagnosticsEnabled
        GroupBox("Diagnostics") {
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Share diagnostics", isOn: Binding(get: { enabled }, set: { on in if on { set(true) } else { offPrompt = true } }))
                Text("Helps you and ProAppStore see why sharing stopped. Never includes locations or heart rate.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text(status(enabled)).font(.footnote)
                if !local.diagnosticsLastSnapshot.isEmpty { Button("View last report") { showReport = true } }
                Text("Connect Claude: add https://mcp.proappstore.online/mcp and sign in with this account to read your phones, app access, last 7 days of data and these reports.")
                    .font(.footnote).textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .alert("Stop sending diagnostics and delete the copy on ProAppStore?", isPresented: $offPrompt) {
            Button("Turn off", role: .destructive) { set(false) }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showReport) { DiagnosticsReport(json: local.diagnosticsLastSnapshot) }
    }

    private func status(_ enabled: Bool) -> String {
        if !enabled { return local.diagnosticsDeletePending ? "Off. Deleting the copy on ProAppStore when online" : "Off. The copy on ProAppStore is deleted" }
        let sentAt = local.diagnosticsSentAt
        guard sentAt > 0 else { return "Not sent yet" }
        return "Last sent \(Date(timeIntervalSince1970: Double(sentAt) / 1000).formatted(.relative(presentation: .named)))"
    }

    /// Durable first, then a sync: off deletes the server copy, on sends at once.
    private func set(_ on: Bool) {
        do { try local.setDiagnostics(on) } catch { return }
        model.refresh()
        model.sync()
    }
}

/// The exact report last sent, pretty-printed: what an assistant connected to the account sees.
private struct DiagnosticsReport: View {
    let json: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(pretty).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            .navigationTitle("Last report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
    }

    private var pretty: String {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return json }
        return String(decoding: data, as: UTF8.self)
    }
}
