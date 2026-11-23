import CryptoKit
import Foundation
import Security

/// Pairing, consent and upload, ported from CompanionRepository.kt. Operations run one at a time, across
/// suspension points, like Android's Mutex (an actor alone would interleave at each `await`).
actor CompanionRepository {
    let local: LocalStore
    private let secure: SecureStore
    private let api: PasApi
    private var last: Task<Void, Never> = Task {}

    init(local: LocalStore, secure: SecureStore = SecureStore(), api: PasApi = PasApi()) {
        self.local = local; self.secure = secure; self.api = api
    }

    private func exclusive<T>(_ body: @escaping () async throws -> T) async throws -> T {
        let previous = last
        let task = Task { () async throws -> T in
            await previous.value
            return try await body()
        }
        last = Task { _ = try? await task.value }
        return try await task.value
    }

    nonisolated func token() -> String? {
        do { return try secure.read()["token"].flatMap { $0.isEmpty ? nil : $0 } } catch {
            try? local.setPaused(true, stopped: "unlock_failed")
            local.message = "The device connection could not be unlocked. Reconnect your account."
            return nil
        }
    }

    /// The same code the browser shows (native-auth.ts).
    nonisolated func pairingCode() -> String {
        guard let id = try? secure.read()["pairId"] else { return "" }
        return String(id.prefix(8)).uppercased()
    }

    func startSignIn(label: String) async throws -> URL {
        try await exclusive { [self] in
            guard token() == nil else { throw CompanionError("Disconnect this account before connecting another.") }
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw CompanionError("Could not start a secure connection.") }
            let verifier = hex(bytes)
            let challenge = hex(Array(SHA256.hash(data: Data(verifier.utf8))))
            let result = try await api.request("POST", "/native/auth/start", body: json(["challenge": challenge, "label": String(label.prefix(80))]))
            guard let id = result["id"] as? String, let link = result["authorizationUrl"] as? String,
                  link.hasPrefix("\(PasApi.ORIGIN)/v1/native/auth/authorize?"), let url = URL(string: link) else {
                throw CompanionError("Unexpected response from ProAppStore.")
            }
            try secure.write(["pairId": id, "verifier": verifier])
            return url
        }
    }

    func finishSignIn() async throws -> Bool {
        try await exclusive { [self] in
            let state = try secure.read()
            guard let pairId = state["pairId"], let verifier = state["verifier"] else { return false }
            let result = try await api.request("POST", "/native/auth/complete", body: json(["id": pairId, "verifier": verifier]))
            if result["pending"] as? Bool == true { return false }
            guard let credential = result["token"] as? String else { throw CompanionError("Unexpected response from ProAppStore.") }
            let me = try await api.request("GET", "/native/me", token: credential)
            guard let userId = (me["user"] as? [String: Any])?["id"] as? String else { throw CompanionError("Unexpected response from ProAppStore.") }
            // Pairing never adopts a previous installation/account's queue or grants.
            try local.clear()
            try secure.write(["token": credential, "userId": userId])
            try updateMe(me)
            return true
        }
    }

    func enable(_ app: ConnectedApp) async throws {
        try await exclusive { [self] in
            guard let credential = token() else { throw CompanionError("Sign in first.") }
            // Finish any queued revocation before granting a new epoch.
            if local.blocked().contains(app.id) { _ = try await api.request("DELETE", "/native/apps/\(app.id)/location", token: credential) }
            _ = try await api.request("PUT", "/native/apps/\(app.id)/location", token: credential,
                                      body: json(["version": app.version, "enabled": true]))
            try updateMe(try await api.request("GET", "/native/me", token: credential))
            try local.unblock(app.id); try local.record(.enabled, appId: app.id)
            try local.resume(app.id); try local.setPaused(false); local.message = ""
        }
    }

    func disable(_ app: ConnectedApp) async throws {
        try local.block(app.id) // Immediate, durable local stop even without network; recipient removed from the queue.
        try await sync()
    }

    func disconnect() async throws {
        try await exclusive { [self] in
            try local.setPaused(true)
            if let credential = token() {
                do { _ = try await api.request("DELETE", "/native/device", token: credential) } catch let e as ApiFailure where e.status == 401 {}
            }
            try local.clear(); try secure.clear()
        }
    }

    func sync() async throws {
        try await exclusive { [self] in
            guard let credential = token() else { return }
            do {
                let blocked = local.blocked()
                for id in blocked { _ = try await api.request("DELETE", "/native/apps/\(id)/location", token: credential) }
                try updateMe(try await api.request("GET", "/native/me", token: credential))
                for id in blocked { try local.unblock(id) }
                try local.expire(now: Self.now())
                for _ in 0..<10 {
                    let batch = try local.pending()
                    if batch.isEmpty { break }
                    let result = try await api.request("POST", "/native/locations", token: credential, body: try JSONEncoder().encode(["points": batch]))
                    let ids = result["acknowledged"] as? [String] ?? []
                    guard Set(ids) == Set(batch.map(\.id)) else { throw CompanionError("Upload was not fully acknowledged. Device copy retained.") }
                    try local.acknowledge(ids)
                }
                local.lastSync = Self.now(); local.message = ""
            } catch {
                if let failure = error as? ApiFailure, failure.status == 401 { try? local.setPaused(true, stopped: "signed_out") }
                local.message = (error as? ApiFailure)?.message ?? "Waiting to sync. Location stays on this phone."
                throw error
            }
        }
    }

    private nonisolated func updateMe(_ me: [String: Any]) throws {
        let user = me["user"] as? [String: Any]
        guard let id = user?["id"] as? String, id == (try secure.read())["userId"] else { throw CompanionError("Account changed. Reconnect this device.") }
        local.userName = user?["name"] as? String ?? ""
        local.deviceLabel = (me["device"] as? [String: Any])?["label"] as? String ?? ""
        try local.saveApps(try JSONSerialization.data(withJSONObject: me["apps"] as? [Any] ?? []))
    }

    static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

private func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
private func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
