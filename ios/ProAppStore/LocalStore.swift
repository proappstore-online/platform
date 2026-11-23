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
    /// Durable: a failed write throws, like Android's `check(commit())`.
    func setPaused(_ value: Bool) throws { try setSetting("paused", value ? "1" : "0") }
    var lastSync: Int64 {
        get { setting("lastSync").flatMap { Int64($0) } ?? 0 }
        set { try? setSetting("lastSync", String(newValue)) }
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

    func blocked() -> Set<String> {
        guard let raw = setting("blocked")?.data(using: .utf8), let ids = try? JSONDecoder().decode([String].self, from: raw) else { return [] }
        return Set(ids)
    }

    func block(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            try saveBlocked(blocked().union([appId]))
            // A disabled app is not "paused": re-enabling it starts sharing.
            try savePausedApps(pausedApps().subtracting([appId]))
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
        try saveBlocked(blocked().subtracting([appId]))
    }

    /// Apps the user paused on this phone. A local recipient filter only: the grant, consent and platform
    /// copy are untouched, and resuming needs no new disclosure.
    func pausedApps() -> Set<String> {
        guard let raw = setting("pausedApps")?.data(using: .utf8), let ids = try? JSONDecoder().decode([String].self, from: raw) else { return [] }
        return Set(ids)
    }

    /// Never rewrites the queue: points recorded before the pause were authorized when taken and still upload.
    func pause(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try savePausedApps(pausedApps().union([appId]))
    }

    func resume(_ appId: String) throws {
        lock.lock(); defer { lock.unlock() }
        try savePausedApps(pausedApps().subtracting([appId]))
    }

    /// Apps that must not receive new fixes: revoked, or paused by the user.
    func excluded() -> Set<String> { blocked().union(pausedApps()) }

    func apps() -> [ConnectedApp] {
        guard let raw = setting("apps")?.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([ConnectedApp].self, from: raw)) ?? []
    }

    /// The `apps` array of `GET /native/me`, stored as received.
    func saveApps(_ json: Data) throws { try setSetting("apps", String(decoding: json, as: UTF8.self)) }

    // MARK: Queue

    func enqueue(_ point: TrackPoint) throws {
        lock.lock(); defer { lock.unlock() }
        let allowed = Set(LocationPolicy.recipients(apps(), blocked: excluded(), at: point.at))
        let retained = point.with(grants: point.grants.filter { allowed.contains($0) })
        if paused || retained.grants.isEmpty { return }
        guard try count() < LocationPolicy.MAX_QUEUE else { throw CompanionError("Device storage queue is full. Connect to upload before resuming.") }
        try exec("INSERT INTO points(id, at, payload) VALUES (?, ?, ?)", [retained.id, retained.at, try json(retained)])
    }

    func pending(limit: Int = 100) throws -> [TrackPoint] {
        try query("SELECT payload FROM points ORDER BY at, id LIMIT ?", [Int64(limit)]) { row in
            try JSONDecoder().decode(TrackPoint.self, from: Data(String(cString: sqlite3_column_text(row, 0)).utf8))
        }
    }

    func acknowledge(_ ids: [String]) throws {
        lock.lock(); defer { lock.unlock() }
        try transaction { for id in ids { try exec("DELETE FROM points WHERE id = ?", [id]) } }
    }

    func expire(now: Int64) throws { try exec("DELETE FROM points WHERE at < ?", [now - LocationPolicy.RETENTION_MS]) }

    func count() throws -> Int { try query("SELECT COUNT(*) FROM points") { Int(sqlite3_column_int64($0, 0)) }.first ?? 0 }

    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        try transaction {
            try exec("DELETE FROM points")
            try exec("DELETE FROM settings")
        }
    }

    // MARK: SQLite

    private func setting(_ key: String) -> String? {
        (try? query("SELECT value FROM settings WHERE key = ?", [key]) { String(cString: sqlite3_column_text($0, 0)) })?.first
    }
    private func setSetting(_ key: String, _ value: String) throws {
        try exec("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
    }
    private func saveBlocked(_ ids: Set<String>) throws {
        try setSetting("blocked", String(decoding: try JSONEncoder().encode(ids.sorted()), as: UTF8.self))
    }
    private func savePausedApps(_ ids: Set<String>) throws {
        try setSetting("pausedApps", String(decoding: try JSONEncoder().encode(ids.sorted()), as: UTF8.self))
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
