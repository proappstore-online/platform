import Foundation
import SQLite3

/// Durable queue and settings in one SQLite file, ported from android LocalStore.kt.
/// The file stays writable while the phone is locked (completeUntilFirstUserAuthentication) and is excluded
/// from backup. Settings share the database so `block()` and its queue rewrite are one transaction.
final class LocalStore: @unchecked Sendable {
    static let fileName = "pas-native.sqlite"
    /// Applied to the directory and the db, -wal and -shm files: writable while locked, unlike `.complete`.
    static let fileProtection = FileProtectionType.completeUntilFirstUserAuthentication
    static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("pas-native", isDirectory: true)
    }

    let fileURL: URL
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()

    init(directory: URL = LocalStore.defaultDirectory) throws {
        let protection: [FileAttributeKey: Any] = [.protectionKey: Self.fileProtection]
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: protection)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        fileURL = directory.appendingPathComponent(Self.fileName)
        guard sqlite3_open_v2(fileURL.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(db); db = nil
            throw CompanionError("Could not open the location queue on this phone.")
        }
        try exec("PRAGMA journal_mode=WAL")
        try exec("PRAGMA synchronous=FULL")
        try exec("CREATE TABLE IF NOT EXISTS points(id TEXT PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)")
        try exec("CREATE INDEX IF NOT EXISTS points_at ON points(at)")
        try exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        // On-device sharing history (#621): never uploaded, same protected file as the queue.
        try exec("""
            CREATE TABLE IF NOT EXISTS share_events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, app_id TEXT,
              kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')
            """)
        try exec("CREATE INDEX IF NOT EXISTS share_events_app_at ON share_events(app_id, at)")
        try exec("""
            CREATE TABLE IF NOT EXISTS share_points(app_id TEXT NOT NULL, point_id TEXT NOT NULL, at INTEGER NOT NULL,
              lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL NOT NULL, sent_at INTEGER, PRIMARY KEY(app_id, point_id))
            """)
        try exec("CREATE INDEX IF NOT EXISTS share_points_app_at ON share_points(app_id, at)")
        // acknowledge() by point id, refresh()'s per-app last upload and pending count, expire() by age (#647).
        try exec("CREATE INDEX IF NOT EXISTS share_points_point ON share_points(point_id)")
        try exec("CREATE INDEX IF NOT EXISTS share_points_app_sent ON share_points(app_id, sent_at)")
        try exec("CREATE INDEX IF NOT EXISTS share_points_at ON share_points(at)")
        for path in [fileURL.path, fileURL.path + "-wal", fileURL.path + "-shm"] where FileManager.default.fileExists(atPath: path) {
            try FileManager.default.setAttributes(protection, ofItemAtPath: path)
        }
    }

    deinit { close() }

    func close() {
        lock.lock(); defer { lock.unlock() }
        if db != nil { sqlite3_close(db); db = nil }
    }

    // MARK: Settings

    var paused: Bool { setting("paused").map { $0 == "1" } ?? true }
    /// Durable: a failed write throws, like Android's `check(commit())`. A change is recorded as `paused_all` /
    /// `resumed_all`, or as `stopped` with `reason` when the system forces the stop.
    func setPaused(_ value: Bool, stopped reason: String? = nil) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            if value != paused { try record(value ? (reason == nil ? .pausedAll : .stopped) : .resumedAll, detail: reason ?? "") }
            try setSetting("paused", value ? "1" : "0")
        }
    }
    var lastSync: Int64 {
        get { setting("lastSync").flatMap { Int64($0) } ?? 0 }
        set { try? setSetting("lastSync", String(newValue)) }
    }
    /// When the last sync was tried, and its failure text (`""` after a success). `message` stays as it is.
    var lastSyncAttempt: Int64 {
        get { setting("lastSyncAttempt").flatMap { Int64($0) } ?? 0 }
        set { try? setSetting("lastSyncAttempt", String(newValue)) }
    }
    var lastSyncError: String {
        get { setting("lastSyncError") ?? "" }
        set { try? setSetting("lastSyncError", newValue) }
    }
    var message: String {
        get { setting("message") ?? "" }
        set { try? setSetting("message", newValue) }
    }
    var userName: String {
        get { setting("userName") ?? "" }
        set { try? setSetting("userName", newValue) }
    }
    var deviceLabel: String {
        get { setting("deviceLabel") ?? "" }
        set { try? setSetting("deviceLabel", newValue) }
    }

    func blocked() -> Set<String> { ids("blocked") }

    func block(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            if !blocked().contains(appId) { try record(.disabled, appId: appId) }
            try saveIds("blocked", blocked().union([appId]))
            // A disabled app is not "paused": re-enabling it starts sharing.
            try saveIds("pausedApps", pausedApps().subtracting([appId]))
            // Never shared, and now never will be.
            try exec("DELETE FROM share_points WHERE app_id = ? AND sent_at IS NULL", [appId])
            // Discard only this recipient. Other enabled apps retain their own queued copy.
            guard let revoked = apps().first(where: { $0.id == appId })?.grantId else { return }
            for p in try pending(limit: LocationPolicy.MAX_QUEUE) where p.grants.contains(revoked) {
                let keep = p.with(grants: p.grants.filter { $0 != revoked })
                if keep.grants.isEmpty { try exec("DELETE FROM points WHERE id = ?", [p.id]) }
                else { try exec("UPDATE points SET payload = ? WHERE id = ?", [try json(keep), p.id]) }
            }
        }
    }

    func unblock(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try saveIds("blocked", blocked().subtracting([appId]))
    }

    /// Apps the user paused on this phone. A local recipient filter only: the grant, consent and platform
    /// copy are untouched, and resuming needs no new disclosure.
    func pausedApps() -> Set<String> { ids("pausedApps") }

    /// Never rewrites the queue: points recorded before the pause were authorized when taken and still upload.
    func pause(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard !pausedApps().contains(appId) else { return }
        try transaction {
            try record(.paused, appId: appId)
            try saveIds("pausedApps", pausedApps().union([appId]))
        }
    }

    func resume(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard pausedApps().contains(appId) else { return }
        try transaction {
            try record(.resumed, appId: appId)
            try saveIds("pausedApps", pausedApps().subtracting([appId]))
        }
    }

    /// Apps that must not receive new fixes: revoked, or paused by the user.
    func excluded() -> Set<String> { blocked().union(pausedApps()) }

    func apps() -> [ConnectedApp] {
        guard let raw = setting("apps")?.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([ConnectedApp].self, from: raw)) ?? []
    }

    /// The `apps` array of `GET /native/me`, stored as received. A held grant that the server dropped or
    /// replaced (publisher change, disclosure revision, app-account deletion) is recorded as `grant_lost`.
    func saveApps(_ json: Data) throws {
        lock.lock(); defer { lock.unlock() }
        let incoming = (try? JSONDecoder().decode([ConnectedApp].self, from: json)) ?? []
        try transaction {
            let blocked = blocked()
            let previous = apps()
            for old in previous where old.grantId != nil && !blocked.contains(old.id) {
                let grant = incoming.first(where: { $0.id == old.id })?.grantId
                if grant != old.grantId { try record(.grantLost, appId: old.id, detail: grant == nil ? "revoked" : "replaced") }
            }
            // A grant back after `grant_lost`, for example after re-consent on another path.
            for new in incoming where new.grantId != nil && !blocked.contains(new.id) && previous.first(where: { $0.id == new.id })?.grantId == nil {
                let last = try query("""
                    SELECT kind FROM share_events WHERE app_id = ? AND kind IN ('enabled', 'disabled', 'grant_lost', 'grant_restored')
                    ORDER BY at DESC, id DESC LIMIT 1
                    """, [new.id]) { String(cString: sqlite3_column_text($0, 0)) }.first
                if last == ShareEvent.Kind.grantLost.rawValue { try record(.grantRestored, appId: new.id) }
            }
            try setSetting("apps", String(decoding: json, as: UTF8.self))
        }
    }

    // MARK: Queue

    func enqueue(_ point: TrackPoint) throws {
        lock.lock(); defer { lock.unlock() }
        let apps = apps()
        let allowed = Set(LocationPolicy.recipients(apps, blocked: excluded(), at: point.at))
        let retained = point.with(grants: point.grants.filter { allowed.contains($0) })
        if paused || retained.grants.isEmpty { return }
        guard try count() < LocationPolicy.MAX_QUEUE else {
            try? record(.queueFull)
            throw QueueFullError()
        }
        try transaction {
            try exec("INSERT INTO points(id, at, payload) VALUES (?, ?, ?)", [retained.id, retained.at, try json(retained)])
            // History is keyed by app id: grant ids change with every new consent.
            for app in apps where app.grantId.map(retained.grants.contains) == true {
                try exec("INSERT OR IGNORE INTO share_points(app_id, point_id, at, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?, ?)",
                         [app.id, retained.id, retained.at, retained.lat, retained.lng, retained.accuracy])
            }
        }
    }

    func pending(limit: Int = 100) throws -> [TrackPoint] {
        try query("SELECT payload FROM points ORDER BY at, id LIMIT ?", [Int64(limit)]) { row in
            try JSONDecoder().decode(TrackPoint.self, from: Data(String(cString: sqlite3_column_text(row, 0)).utf8))
        }
    }

    /// `sent_at` means the server acknowledged it, which includes points it discarded for a revoked recipient.
    func acknowledge(_ ids: [String], now: Int64 = CompanionRepository.now()) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            for id in ids {
                try exec("DELETE FROM points WHERE id = ?", [id])
                try exec("UPDATE share_points SET sent_at = ? WHERE point_id = ? AND sent_at IS NULL", [now, id])
            }
        }
    }

    func expire(now: Int64) throws {
        lock.lock(); defer { lock.unlock() }
        let cutoff = now - LocationPolicy.HISTORY_MS
        try transaction {
            try exec("DELETE FROM points WHERE at < ?", [now - LocationPolicy.RETENTION_MS])
            try exec("DELETE FROM share_points WHERE sent_at IS NULL AND at < ?", [now - LocationPolicy.RETENTION_MS]) // its queue copy just expired
            try exec("DELETE FROM share_points WHERE at < ?", [cutoff])
            try exec("DELETE FROM share_points WHERE rowid IN (SELECT rowid FROM share_points ORDER BY at DESC LIMIT -1 OFFSET ?)",
                     [Int64(LocationPolicy.HISTORY_MAX_POINTS)])
            // Keep the newest event of each (app, kind) before the cutoff, so state at the window start is known.
            try exec("""
                DELETE FROM share_events WHERE at < ? AND id NOT IN
                  (SELECT MAX(id) FROM share_events WHERE at < ? GROUP BY app_id, kind)
                """, [cutoff, cutoff])
        }
    }

    func count() throws -> Int { try query("SELECT COUNT(*) FROM points") { Int(sqlite3_column_int64($0, 0)) }.first ?? 0 }

    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            try exec("DELETE FROM points")
            try exec("DELETE FROM settings")
            try exec("DELETE FROM share_events")
            try exec("DELETE FROM share_points")
        }
    }

    // MARK: Sharing history (#621)

    /// `detail` is cut to 120 characters: a short code or the server's `error` text, never a body or coordinates.
    func record(_ kind: ShareEvent.Kind, appId: String? = nil, detail: String = "", at: Int64 = CompanionRepository.now()) throws {
        try exec("INSERT INTO share_events(at, app_id, kind, detail) VALUES (?, ?, ?, ?)", [at, appId ?? NSNull(), kind.rawValue, String(detail.prefix(120))])
    }

    /// Records `sync_failed` once per run of identical failures (an offline walk retries about every 15 s).
    /// Returns whether it was recorded, so related events are de-duplicated the same way.
    @discardableResult
    func syncFailed(_ detail: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let failures = setting("syncFailures").flatMap { Int($0) } ?? 0
        let new = failures == 0 || setting("lastSyncFailure") != String(detail.prefix(120))
        try transaction {
            if new { try record(.syncFailed, detail: detail) }
            try setSetting("syncFailures", String(failures + 1))
            try setSetting("lastSyncFailure", String(detail.prefix(120)))
        }
        return new
    }

    /// Ends a failure run with `sync_recovered`.
    func syncSucceeded() throws {
        lock.lock(); defer { lock.unlock() }
        let failures = setting("syncFailures").flatMap { Int($0) } ?? 0
        guard failures > 0 else { return }
        try transaction {
            try record(.syncRecovered, detail: "after \(failures) attempt\(failures == 1 ? "" : "s")")
            try setSetting("syncFailures", "0")
            try setSetting("lastSyncFailure", "")
        }
    }

    /// Oldest first. Kinds this build does not know are skipped.
    func events() throws -> [ShareEvent] {
        try query("SELECT id, at, app_id, kind, detail FROM share_events ORDER BY at, id") { row -> ShareEvent? in
            guard let kind = ShareEvent.Kind(rawValue: String(cString: sqlite3_column_text(row, 3))) else { return nil }
            let appId = sqlite3_column_type(row, 2) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(row, 2))
            return ShareEvent(id: sqlite3_column_int64(row, 0), at: sqlite3_column_int64(row, 1), appId: appId, kind: kind,
                              detail: String(cString: sqlite3_column_text(row, 4)))
        }.compactMap { $0 }
    }

    /// When the server last acknowledged a point for this app, or nil.
    func lastUpload(_ appId: String) throws -> Int64? {
        try query("SELECT MAX(sent_at) FROM share_points WHERE app_id = ?", [appId]) { row in
            sqlite3_column_type(row, 0) == SQLITE_NULL ? nil : sqlite3_column_int64(row, 0)
        }.first ?? nil
    }

    /// This app's points still waiting to upload.
    func pendingCount(_ appId: String) throws -> Int {
        try query("SELECT COUNT(*) FROM share_points WHERE app_id = ? AND sent_at IS NULL", [appId]) { Int(sqlite3_column_int64($0, 0)) }.first ?? 0
    }

    /// This app's shared points in `[from, to]`, oldest first.
    func track(appId: String, from: Int64, to: Int64) throws -> [TrackSample] {
        try query("SELECT at, lat, lng, accuracy, sent_at FROM share_points WHERE app_id = ? AND at BETWEEN ? AND ? ORDER BY at", [appId, from, to]) { row in
            TrackSample(at: sqlite3_column_int64(row, 0), lat: sqlite3_column_double(row, 1), lng: sqlite3_column_double(row, 2),
                        accuracy: sqlite3_column_double(row, 3), sentAt: sqlite3_column_type(row, 4) == SQLITE_NULL ? nil : sqlite3_column_int64(row, 4))
        }
    }

    /// Deletes the history, keeps the queue (pending uploads still go), and re-seeds the current state at `now`.
    /// `history_cleared` comes first: it ends open sessions, and the seeded `enabled` rows then start new ones.
    func clearHistory(now: Int64 = CompanionRepository.now()) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            try exec("DELETE FROM share_events")
            try exec("DELETE FROM share_points")
            try record(.historyCleared, at: now)
            try seed(now: now, consentTime: false, detail: "")
        }
    }

    /// Upgrade path: a phone with grants but no history gets sessions that start at each grant's consent time.
    func seedIfEmpty(now: Int64 = CompanionRepository.now()) throws {
        lock.lock(); defer { lock.unlock() }
        guard try query("SELECT COUNT(*) FROM share_events") { sqlite3_column_int64($0, 0) }.first == 0 else { return }
        try transaction { try seed(now: now, consentTime: true, detail: "seeded") }
    }

    private func seed(now: Int64, consentTime: Bool, detail: String) throws {
        let blocked = blocked(), paused = pausedApps()
        for app in apps() where app.grantId != nil && !blocked.contains(app.id) {
            try record(.enabled, appId: app.id, detail: detail, at: consentTime ? min(app.consentAt, now) : now)
        }
        for app in apps() where app.grantId != nil && !blocked.contains(app.id) && paused.contains(app.id) {
            try record(.paused, appId: app.id, detail: detail, at: now)
        }
        if self.paused { try record(.pausedAll, detail: detail, at: now) }
    }

    // MARK: SQLite

    private func setting(_ key: String) -> String? {
        (try? query("SELECT value FROM settings WHERE key = ?", [key]) { String(cString: sqlite3_column_text($0, 0)) })?.first
    }
    private func setSetting(_ key: String, _ value: String) throws {
        try exec("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
    }
    /// A set of app ids, stored as a sorted JSON array.
    private func ids(_ key: String) -> Set<String> {
        guard let raw = setting(key)?.data(using: .utf8), let ids = try? JSONDecoder().decode([String].self, from: raw) else { return [] }
        return Set(ids)
    }
    private func saveIds(_ key: String, _ ids: Set<String>) throws {
        try setSetting(key, String(decoding: try JSONEncoder().encode(ids.sorted()), as: UTF8.self))
    }
    private func json(_ point: TrackPoint) throws -> String { String(decoding: try JSONEncoder().encode(point), as: UTF8.self) }

    private func transaction(_ body: () throws -> Void) throws {
        try exec("BEGIN IMMEDIATE")
        do { try body(); try exec("COMMIT") } catch { try? exec("ROLLBACK"); throw error }
    }

    private func exec(_ sql: String, _ args: [Any] = []) throws {
        _ = try query(sql, args) { _ in () }
    }

    private func query<T>(_ sql: String, _ args: [Any] = [], row: (OpaquePointer) throws -> T) throws -> [T] {
        lock.lock(); defer { lock.unlock() }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw storageError() }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, arg) in args.enumerated() {
            let index = Int32(i + 1)
            let rc: Int32
            switch arg {
            case let value as Int64: rc = sqlite3_bind_int64(statement, index, value)
            case let value as String: rc = sqlite3_bind_text(statement, index, value, -1, transient)
            case let value as Double: rc = sqlite3_bind_double(statement, index, value)
            case is NSNull: rc = sqlite3_bind_null(statement, index)
            default: preconditionFailure("Unsupported SQLite binding")
            }
            guard rc == SQLITE_OK else { throw storageError() }
        }
        var rows: [T] = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW: rows.append(try row(statement))
            case SQLITE_DONE: return rows
            default: throw storageError()
            }
        }
    }

    /// Never includes SQL arguments, which can hold coordinates.
    private func storageError() -> CompanionError {
        CompanionError("Could not save location on this phone (SQLite \(sqlite3_extended_errcode(db))).")
    }
}
