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
            let result: [String: Any]
            do {
                result = try await api.request("POST", "/native/auth/complete", body: json(["id": pairId, "verifier": verifier]))
            } catch let failure as ApiFailure where [400, 403, 409].contains(failure.status) {
                // Expired, invalid or already used: this proof can never succeed. Only a proof is stored in this state.
                try secure.clear()
                throw failure
            }
            if result["pending"] as? Bool == true { return false }
            guard let credential = result["token"] as? String else { throw CompanionError("Unexpected response from ProAppStore.") }
            let me = try await api.request("GET", "/native/me", token: credential)
            guard let userId = (me["user"] as? [String: Any])?["id"] as? String else { throw CompanionError("Unexpected response from ProAppStore.") }
            // Pairing never adopts a previous installation/account's queue or grants. The same account after an
            // expiry keeps the on-device history (#652).
            if local.expiredUser == userId { try local.clearForReconnect() } else { try local.clear() }
            try secure.write(["token": credential, "userId": userId])
            try updateMe(me)
            return true
        }
    }

    func enable(_ app: ConnectedApp) async throws {
        try await exclusive { [self] in
            guard let credential = token() else { throw CompanionError("Sign in first.") }
            // Finish any queued revocation before granting a new epoch.
            if local.blocked().contains(app.id) { _ = try await device("DELETE", "/native/apps/\(app.id)/location", credential) }
            _ = try await device("PUT", "/native/apps/\(app.id)/location", credential, body: json(["version": app.version, "enabled": true]))
            try updateMe(try await device("GET", "/native/me", credential))
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
            var uploading = false, partial = false
            do {
                let blocked = local.blocked()
                for id in blocked { _ = try await device("DELETE", "/native/apps/\(id)/location", credential) }
                try updateMe(try await device("GET", "/native/me", credential))
                for id in blocked { try local.unblock(id) }
                try local.expire(now: Self.now())
                for _ in 0..<10 {
                    let batch = try local.pending()
                    if batch.isEmpty { break }
                    uploading = true
                    let result = try await device("POST", "/native/locations", credential, body: try JSONEncoder().encode(["points": batch]))
                    let ids = result["acknowledged"] as? [String] ?? []
                    guard Set(ids) == Set(batch.map(\.id)) else {
                        partial = true
                        throw CompanionError("Upload was not fully acknowledged. Device copy retained.")
                    }
                    try local.acknowledge(ids)
                }
                local.lastSync = Self.now(); local.lastSyncAttempt = local.lastSync; local.message = ""; local.lastSyncError = ""
                try? local.syncSucceeded()
            } catch {
                if (error as? ApiFailure)?.status == 401 { throw error } // expired: the expired card says so, not a sync failure
                local.message = (error as? ApiFailure)?.message ?? "Waiting to sync. Location stays on this phone."
                local.lastSyncAttempt = Self.now(); local.lastSyncError = error.localizedDescription
                // Activity log: status (0 = network) plus the server's `error` text only.
                let status = (error as? ApiFailure)?.status ?? (error is URLError ? 0 : nil)
                if (try? local.syncFailed(status.map { "\($0) \(error.localizedDescription)" } ?? error.localizedDescription)) == true {
                    if status == 429 { try? local.record(.quota, detail: "429") }
                    if uploading, let status, status == 400 || status == 413 { try? local.record(.uploadRejected, detail: "\(status)") }
                    if partial { try? local.record(.uploadRejected, detail: "partial_ack") }
                }
                throw error
            }
        }
    }

    /// Reconnecting before the connection expires (#652): uploads what it can, then takes the same path as an
    /// expiry, which keeps the history. The old credential is only forgotten: revoking it would delete the
    /// platform copies already shared, and it lapses on its own within days.
    func renew() async throws {
        guard token() != nil else { return }
        try? await sync()
        try await exclusive { [self] in if token() != nil { try expire(detail: "renew") } }
    }

    /// A device-authenticated request. 401 means the credential expired or was revoked (#652); network errors,
    /// 429 and 5xx never expire the connection.
    private func device(_ method: String, _ path: String, _ credential: String, body: Data? = nil) async throws -> [String: Any] {
        do { return try await api.request(method, path, token: credential, body: body) } catch let failure as ApiFailure where failure.status == 401 {
            try expire()
            throw failure
        }
    }

    /// Drops the credential, so collection stops, and keeps everything on the phone for Reconnect.
    private nonisolated func expire(detail: String = "") throws {
        try local.markExpired(userId: try secure.read()["userId"] ?? "", detail: detail)
        try secure.clear()
    }

    /// The days left when `device.expiresAt` is under 7 days away, else nil (#652).
    static func expiresInDays(_ expiresAt: Int64, now: Int64 = now()) -> Int? {
        let left = expiresAt - now
        guard expiresAt > 0, left > 0, left < 7 * 86_400_000 else { return nil }
        return Int((left + 86_399_999) / 86_400_000)
    }

    private nonisolated func updateMe(_ me: [String: Any]) throws {
        let user = me["user"] as? [String: Any]
        guard let id = user?["id"] as? String, id == (try secure.read())["userId"] else { throw CompanionError("Account changed. Reconnect this device.") }
        local.userName = user?["name"] as? String ?? ""
        let device = me["device"] as? [String: Any]
        local.deviceLabel = device?["label"] as? String ?? ""
        local.deviceExpiresAt = (device?["expiresAt"] as? NSNumber)?.int64Value ?? 0
        try local.saveApps(try JSONSerialization.data(withJSONObject: me["apps"] as? [Any] ?? []))
    }

    static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

private func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
private func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
