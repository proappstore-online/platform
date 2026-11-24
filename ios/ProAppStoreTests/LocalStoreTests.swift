import SQLite3
import XCTest
@testable import ProAppStore

/// Port of CompanionTest.kt `queueSurvivesReopenAndRevokesOnlyItsRecipient`, plus the iOS storage rules.
final class LocalStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func app(_ id: String, _ grant: String) -> [String: Any] {
        ["id": id, "name": id, "purpose": "Routes", "disclosure": "Disclosure", "version": "1", "grant": ["id": grant, "consent_at": 1]]
    }

    /// Every app granted and, unless `sessions` is false, sharing in a session started at the real clock.
    private func store(apps: [[String: Any]], sessions: Bool = true) throws -> LocalStore {
        let local = try LocalStore(directory: directory)
        try local.saveApps(try JSONSerialization.data(withJSONObject: apps))
        if sessions { for app in apps { try local.startSession(app["id"] as! String) } }
        return local
    }

    private func point(_ id: String, at: Int64, grants: [String]) -> TrackPoint {
        TrackPoint(id: id, at: at, lat: 1, lng: 2, accuracy: 5, grants: grants)
    }

    func testQueueSurvivesReopenAndRevokesOnlyItsRecipient() throws {
        let local = try store(apps: [app("ski", "ski-old"), app("rideshare", "ride-grant")])
        try local.enqueue(point("point", at: 10, grants: ["ski-old", "ride-grant"]))
        try local.enqueue(point("ski-only", at: 11, grants: ["ski-old"]))
        local.close()

        let reopened = try LocalStore(directory: directory)
        XCTAssertEqual(try reopened.count(), 2)
        try reopened.block("ski")
        // Only Ski's grant is stripped; a point left with no recipient is deleted.
        XCTAssertEqual(try reopened.pending().map(\.id), ["point"])
        XCTAssertEqual(try reopened.pending().first?.grants, ["ride-grant"])
        XCTAssertEqual(reopened.blocked(), ["ski"])
        // A callback prepared before revocation cannot put the old recipient back.
        try reopened.enqueue(point("late", at: 12, grants: ["ski-old"]))
        XCTAssertEqual(try reopened.count(), 1)
        try reopened.acknowledge(["not-this-point"])
        XCTAssertEqual(try reopened.count(), 1)
        try reopened.acknowledge(["point"])
        XCTAssertEqual(try reopened.count(), 0)
    }

    func testExpireDropsPointsOlderThanSevenDays() throws {
        let local = try store(apps: [app("ski", "g")])
        let now: Int64 = 10 * 24 * 60 * 60 * 1000
        try local.enqueue(point("old", at: now - LocationPolicy.RETENTION_MS - 1, grants: ["g"]))
        try local.enqueue(point("edge", at: now - LocationPolicy.RETENTION_MS, grants: ["g"]))
        try local.expire(now: now)
        XCTAssertEqual(try local.pending().map(\.id), ["edge"])
    }

    func testEnqueueRefusesAtMaxQueue() throws {
        let local = try store(apps: [app("ski", "g")])
        try local.enqueue(point("first", at: 10, grants: ["g"]))
        // Fill to the cap directly; 60,000 enqueue calls would only slow the test.
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, """
            WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < \(LocationPolicy.MAX_QUEUE))
            INSERT INTO points(id, at, payload) SELECT 'p' || i, i, '{}' FROM n
            """, nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(try local.count(), LocationPolicy.MAX_QUEUE)
        XCTAssertThrowsError(try local.enqueue(point("over", at: 99, grants: ["g"]))) { error in
            XCTAssertEqual(LocationCollector.saveFailureMessage(error),
                           "Upload queue is full. Connect to the internet so ProAppStore can send waiting points.")
        }
        XCTAssertEqual(try local.count(), LocationPolicy.MAX_QUEUE)
        XCTAssertEqual(LocationCollector.saveFailureMessage(CompanionError("SQLite")), "Could not save location on this phone. Sharing stopped.")
    }

    /// ADR-020 (replaces "paused enqueue is a no-op"): with no session, neither queue stores anything.
    func testWithoutASessionNothingIsStored() throws {
        let local = try runStore(sessions: false)
        try local.enqueue(point("p", at: 10, grants: ["ski-loc", "run-loc"]))
        try local.enqueueHeartRate(sample("h", at: 10))
        XCTAssertEqual(try local.count(), 0)
        XCTAssertEqual(try local.heartRateCount(), 0)
    }

    /// A fresh store has no session (replaces "settings default to paused"); sessions survive a reopen, and clear ends them.
    func testNoSessionByDefaultSessionsSurviveReopenAndClearResets() throws {
        let local = try LocalStore(directory: directory)
        XCTAssertEqual(local.sessions(), [])
        try local.startSession("run", now: 5)
        try local.startSession("run", now: 9) // a running session is left as it is
        local.message = "m"; local.userName = "Alex"; local.lastSync = 42
        local.close()
        let reopened = try LocalStore(directory: directory)
        XCTAssertEqual(reopened.sessions(), [Session(appId: "run", startedAt: 5, lastMovedAt: 5)])
        XCTAssertEqual(reopened.userName, "Alex")
        XCTAssertEqual(reopened.lastSync, 42)
        try reopened.clear()
        XCTAssertEqual(reopened.sessions(), [])
        XCTAssertEqual(reopened.message, "")
    }

    /// ADR-020 §9: the first open drops both pause settings and creates no session, even for an app that was sharing.
    func testTheFirstOpenDropsThePauseSettingsAndStartsNothing() throws {
        let local = try store(apps: [app("run", "run-g")], sessions: false)
        local.close()
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        XCTAssertEqual(sqlite3_exec(db, #"INSERT INTO settings(key, value) VALUES ('paused', '0'), ('pausedApps', '["ski"]')"#, nil, nil, nil), SQLITE_OK)
        func keys() -> [String] {
            var statement: OpaquePointer?
            XCTAssertEqual(sqlite3_prepare_v2(db, "SELECT key FROM settings ORDER BY key", -1, &statement, nil), SQLITE_OK)
            defer { sqlite3_finalize(statement) }
            var rows: [String] = []
            while sqlite3_step(statement) == SQLITE_ROW { rows.append(String(cString: sqlite3_column_text(statement, 0))) }
            return rows
        }
        XCTAssertEqual(keys(), ["apps", "paused", "pausedApps"])
        let reopened = try LocalStore(directory: directory)
        XCTAssertEqual(keys(), ["apps"])
        sqlite3_close(db)
        XCTAssertEqual(reopened.sessions(), [])
        try reopened.enqueue(point("p", at: 10, grants: ["run-g"]))
        XCTAssertEqual(try reopened.count(), 0, "nothing collects until Start")
    }

    func testFileIsWritableWhileLockedAndExcludedFromBackup() throws {
        let local = try LocalStore(directory: directory)
        XCTAssertEqual(LocalStore.fileProtection, .completeUntilFirstUserAuthentication)
        for path in [local.fileURL.path, local.fileURL.path + "-wal", local.fileURL.path + "-shm"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: path), path)
            let protection = try FileManager.default.attributesOfItem(atPath: path)[.protectionKey] as? FileProtectionType
            #if targetEnvironment(simulator)
            // The simulator stores files on the Mac's file system, which has no data-protection classes, so
            // the attribute reads back as nil there. On a device it must be the class LocalStore applied.
            XCTAssertTrue(protection == nil || protection == LocalStore.fileProtection, path)
            #else
            XCTAssertEqual(protection, LocalStore.fileProtection, path)
            #endif
        }
        XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    // MARK: Collection sessions (ADR-020), replacing per-app pause (#620)

    /// Replaces "pause filters new points to the other recipient".
    func testStartingRunsSessionTagsOnlyRun() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")], sessions: false)
        try local.startSession("run")
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try local.pending().first?.grants, ["run-g"])
        try local.endSession("run", detail: "user")
        try local.enqueue(point("q", at: 11, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try local.count(), 1)
    }

    /// #620's guarantee for Stop (replaces "pause leaves queued points untouched"): queued points and their grants stay,
    /// and still upload; the grant and the app list are untouched.
    func testEndingASessionLeavesQueuedPointsAndGrantsUnchanged() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        let apps = local.apps()
        try local.endSession("ski", detail: "user")
        XCTAssertEqual(try local.pending().first?.grants, ["ski-g", "run-g"])
        XCTAssertEqual(local.apps(), apps)
        XCTAssertEqual(local.blocked(), [])
        XCTAssertEqual(local.sessionIds(), ["run"])
        XCTAssertEqual(try events(local).map { "\($0.kind.rawValue):\($0.appId!):\($0.detail)" }, ["session_ended:ski:user"])
    }

    /// Replaces "resume restores tagging and block clears the pause": Start again tags again; turning off ends it.
    func testStartingAgainRestoresTaggingAndTurningOffEndsTheSession() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.endSession("ski", detail: "user")
        try local.startSession("ski")
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try local.pending().first?.grants, ["ski-g", "run-g"])
        try local.block("ski")
        XCTAssertEqual(local.sessionIds(), ["run"])
        XCTAssertEqual(local.blocked(), ["ski"])
    }

    func testEndAllSessionsAndAForcedStop() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.endAllSessions("all", now: 50)
        XCTAssertEqual(local.sessions(), [])
        XCTAssertEqual(try events(local).map { "\($0.kind.rawValue):\($0.appId!):\($0.detail)" }, ["session_ended:ski:all", "session_ended:run:all"])
        try local.stop("storage_failed") // nothing running: nothing to record
        try local.startSession("run")
        try local.stop("storage_failed")
        XCTAssertEqual(local.sessions(), [])
        XCTAssertEqual(try local.events().last.map { "\($0.kind.rawValue):\($0.detail)" }, "stopped:storage_failed")
    }

    /// ADR-020 §3: movement restarts every stationary clock, written at most once a minute.
    func testMovementRestartsTheStationaryClockAtMostOnceAMinute() throws {
        let local = try LocalStore(directory: directory)
        try local.startSession("run", now: 0)
        try local.moved(now: 59_999)
        XCTAssertEqual(local.sessions().first?.lastMovedAt, 0)
        try local.moved(now: 60_000)
        XCTAssertEqual(local.sessions().first?.lastMovedAt, 60_000)
    }

    func testDueSessionsEndAsStationaryOrMax() throws {
        let local = try LocalStore(directory: directory)
        let min: Int64 = 60_000
        try local.startSession("run", now: 0)
        try local.startSession("ski", now: 0)
        try local.moved(now: 20 * min)  // both moved at 20 min
        XCTAssertTrue(try local.endDueSessions(now: 49 * min).isEmpty)
        try local.startSession("bike", now: 49 * min)
        let ended = try local.endDueSessions(now: 50 * min)
        XCTAssertEqual(ended.map { "\($0.appId):\($0.reason.rawValue)" }, ["run:stationary", "ski:stationary"])
        XCTAssertEqual(local.sessionIds(), ["bike"])
        XCTAssertEqual(try local.endDueSessions(now: 49 * min + LocationPolicy.MAX_SESSION_MS).map(\.reason), [.maxLength])
        XCTAssertEqual(try local.events().filter { $0.kind == .sessionEnded }.map(\.detail), ["stationary", "stationary", "max"])
    }

    /// ADR-020 §7: opening the companion ends sessions past 12 hours as `max` and restarts the others' stationary clock.
    func testResumeSessionsEndsLongOnesAndRestartsTheOthersClock() throws {
        let local = try LocalStore(directory: directory)
        try local.startSession("run", now: 0)
        try local.startSession("ski", now: 2 * 3_600_000)
        let now = LocationPolicy.MAX_SESSION_MS + 1
        try local.resumeSessions(now: now)
        XCTAssertEqual(local.sessions(), [Session(appId: "ski", startedAt: 2 * 3_600_000, lastMovedAt: now)])
        XCTAssertEqual(try local.events().filter { $0.kind == .sessionEnded }.map { "\($0.appId!):\($0.detail)" }, ["run:max"])
    }

    /// #652: an expiry ends every session; reconnecting creates none.
    func testMarkExpiredEndsAllSessions() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.markExpired(userId: "u1")
        XCTAssertEqual(local.sessions(), [])
        XCTAssertEqual(try events(local).map { "\($0.kind.rawValue):\($0.appId ?? "-"):\($0.detail)" },
                       ["session_ended:ski:grant", "session_ended:run:grant", "expired:-:"])
        try local.clearForReconnect()
        XCTAssertEqual(local.sessions(), [])
    }

    // MARK: Sharing history (#621)

    private func history(_ local: LocalStore, _ where_: String = "1") throws -> [String] {
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(db, "SELECT app_id || ':' || point_id || ':' || IFNULL(sent_at, 'q') FROM share_points WHERE \(where_) ORDER BY app_id, point_id", -1, &statement, nil), SQLITE_OK)
        defer { sqlite3_finalize(statement) }
        var rows: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW { rows.append(String(cString: sqlite3_column_text(statement, 0))) }
        return rows
    }

    /// Events after setup: `store()`'s own sessions record a `session_started` each at the real clock.
    private func events(_ local: LocalStore) throws -> [ShareEvent] { try local.events().filter { $0.kind != .sessionStarted } }

    func testEnqueueWritesHistoryPerAppAndAcknowledgeMarksItSent() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try history(local), ["run:p:q", "ski:p:q"])
        try local.acknowledge(["p"], now: 50)
        XCTAssertEqual(try local.count(), 0)
        XCTAssertEqual(try history(local), ["run:p:50", "ski:p:50"])
    }

    func testBlockDeletesOnlyThatAppsUnsentHistory() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("sent", at: 10, grants: ["ski-g", "run-g"]))
        try local.acknowledge(["sent"], now: 20)
        try local.enqueue(point("queued", at: 30, grants: ["ski-g", "run-g"]))
        try local.block("ski")
        XCTAssertEqual(try history(local), ["run:queued:q", "run:sent:20", "ski:sent:20"])
        XCTAssertEqual(try events(local).map(\.kind), [.disabled, .sessionEnded])
    }

    func testExpireAppliesHistoryWindowsAndKeepsTheNewestEventPerKind() throws {
        let local = try store(apps: [app("ski", "g")])
        let day: Int64 = 24 * 60 * 60 * 1000
        let now = 40 * day
        try local.enqueue(point("sent-old", at: now - 31 * day, grants: ["g"]))
        try local.enqueue(point("sent-kept", at: now - 29 * day, grants: ["g"]))
        try local.acknowledge(["sent-old", "sent-kept"], now: now - 28 * day)
        try local.enqueue(point("unsent-old", at: now - 8 * day, grants: ["g"]))
        try local.enqueue(point("unsent-kept", at: now - 6 * day, grants: ["g"]))
        try local.record(.paused, appId: "ski", at: now - 35 * day)
        try local.record(.paused, appId: "ski", at: now - 33 * day)
        try local.record(.resumed, appId: "ski", at: now - 34 * day)
        try local.record(.paused, appId: "ski", at: now - 1 * day)
        try local.expire(now: now)
        XCTAssertEqual(try history(local), ["ski:sent-kept:\(now - 28 * day)", "ski:unsent-kept:q"])
        XCTAssertEqual(try events(local).map(\.at), [now - 34 * day, now - 33 * day, now - 1 * day])
    }

    func testExpireEnforcesTheHistoryCap() throws {
        let local = try store(apps: [app("ski", "g")])
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, """
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(LocationPolicy.HISTORY_MAX_POINTS + 5))
            INSERT INTO share_points(app_id, point_id, at, lat, lng, accuracy, sent_at) SELECT 'ski', 'p' || i, 1000000 + i, 1, 2, 5, 1 FROM n
            """, nil, nil, nil), SQLITE_OK)
        try local.expire(now: 2_000_000)
        XCTAssertEqual(try history(local).count, LocationPolicy.HISTORY_MAX_POINTS)
        XCTAssertEqual(try history(local, "point_id IN ('p1', 'p5')").count, 0)  // the oldest go first
    }

    func testClearHistoryKeepsTheQueueAndReseedsCurrentState() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        try local.endSession("ski", detail: "user")
        try local.clearHistory(now: 99)
        XCTAssertEqual(try local.count(), 1)
        XCTAssertEqual(try history(local), [])
        XCTAssertEqual(try local.events().map { "\($0.kind.rawValue):\($0.appId ?? "-"):\($0.at)" },
                       ["history_cleared:-:99", "enabled:ski:99", "enabled:run:99", "session_started:run:99"])
        try local.clear()
        XCTAssertEqual(try local.events(), [])
        XCTAssertEqual(try history(local), [])
    }

    func testClearEmptiesHistory() throws {
        let local = try store(apps: [app("ski", "g")])
        try local.enqueue(point("p", at: 10, grants: ["g"]))
        try local.endSession("ski", detail: "user")
        try local.clear()
        XCTAssertEqual(try local.events(), [])
        XCTAssertEqual(try history(local), [])
    }

    /// #652: the expired state survives a relaunch, and the expired device's grants seed nothing.
    func testExpiredSurvivesReopenAndClearHistorySeedsNothing() throws {
        let local = try store(apps: [app("ski", "ski-g")])
        XCTAssertFalse(local.expired)
        try local.markExpired(userId: "u1")
        try local.markExpired(userId: "u1") // logged once
        local.close()
        let reopened = try LocalStore(directory: directory)
        XCTAssertEqual(reopened.expiredUser, "u1")
        XCTAssertEqual(try reopened.events().map(\.kind), [.sessionStarted, .sessionEnded, .expired])
        try reopened.clearHistory(now: 99)
        XCTAssertEqual(try reopened.events().map(\.kind), [.historyCleared])
    }

    /// #652: Reconnect drops the queue, unsent points and the old grants; the shared history and the log stay.
    func testClearForReconnectKeepsHistoryAndDropsQueueAndGrants() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("sent", at: 10, grants: ["ski-g"]))
        try local.acknowledge(["sent"], now: 20)
        try local.enqueue(point("queued", at: 30, grants: ["ski-g"]))
        try local.endSession("ski", detail: "user")
        try local.block("run")
        try local.markExpired(userId: "u1")
        try local.clearForReconnect()
        XCTAssertEqual(try local.count(), 0)
        XCTAssertEqual(try history(local), ["ski:sent:20"])
        XCTAssertEqual(try events(local).map(\.kind), [.sessionEnded, .disabled, .sessionEnded, .expired])
        XCTAssertEqual(local.apps(), [])
        XCTAssertEqual(local.blocked(), [])
        XCTAssertEqual(local.sessions(), [], "reconnecting creates no session")
        XCTAssertFalse(local.expired)
    }

    /// An upgrade seeds the consent periods and no session: there is none to seed.
    func testSeedOnAnEmptyHistoryDatesEnabledAtConsent() throws {
        let local = try LocalStore(directory: directory)
        try local.saveApps(try JSONSerialization.data(withJSONObject: [app("run", "run-g")])) // consent_at 1
        try local.seedIfEmpty(now: 500)
        XCTAssertEqual(try local.events().map { "\($0.kind.rawValue):\($0.at):\($0.detail)" }, ["enabled:1:seeded"])
        try local.seedIfEmpty(now: 600)
        XCTAssertEqual(try local.events().count, 1) // only once
    }

    /// A lost or replaced grant ends the app's session; an unchanged one keeps it.
    func testSaveAppsRecordsALostGrantAndEndsItsSession() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g"), app("bike", "bike-g")])
        var revoked = app("run", "x"); revoked["grant"] = NSNull()
        try local.saveApps(try JSONSerialization.data(withJSONObject: [app("ski", "ski-new"), revoked, app("bike", "bike-g")]))
        XCTAssertEqual(try events(local).map { "\($0.kind.rawValue):\($0.appId!):\($0.detail)" },
                       ["grant_lost:ski:replaced", "session_ended:ski:grant", "grant_lost:run:revoked", "session_ended:run:grant"])
        XCTAssertEqual(local.sessionIds(), ["bike"])
    }

    func testPendingCountAndLastUploadArePerApp() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        XCTAssertNil(try local.lastUpload("run"))
        try local.enqueue(point("both", at: 10, grants: ["ski-g", "run-g"]))
        try local.enqueue(point("run-1", at: 11, grants: ["run-g"]))
        try local.enqueue(point("run-2", at: 12, grants: ["run-g"]))
        XCTAssertEqual(try local.pendingCount("run"), 3)
        XCTAssertEqual(try local.pendingCount("ski"), 1)
        try local.acknowledge(["run-1", "run-2"], now: 70)
        XCTAssertEqual(try local.pendingCount("run"), 1)
        XCTAssertEqual(try local.lastUpload("run"), 70)
        XCTAssertEqual(try local.pendingCount("ski"), 1)
        XCTAssertNil(try local.lastUpload("ski"))
    }

    func testTrackReturnsOnlyThatAppsRowsInRangeInOrder() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("b", at: 20, grants: ["run-g"]))
        try local.enqueue(point("a", at: 10, grants: ["ski-g", "run-g"]))
        try local.enqueue(point("c", at: 30, grants: ["run-g"]))
        try local.enqueue(point("d", at: 40, grants: ["run-g"]))
        try local.acknowledge(["a"], now: 99)
        XCTAssertEqual(try local.track(appId: "run", from: 10, to: 30).map(\.at), [10, 20, 30])
        XCTAssertEqual(try local.track(appId: "run", from: 10, to: 30).map(\.sentAt), [99, nil, nil])
        XCTAssertEqual(try local.track(appId: "ski", from: 0, to: 100).map(\.at), [10])
    }

    func testEventDetailIsTruncatedAndCarriesNoCoordinates() throws {
        let local = try store(apps: [app("ski", "g")])
        try local.syncFailed("500 " + String(repeating: "x", count: 300))
        try local.enqueue(point("p", at: 10, grants: ["g"]))
        try local.endSession("ski", detail: "user"); try local.block("ski")
        let details = try local.events().map(\.detail)
        XCTAssertEqual(details.map(\.count).max(), 120)
        let coordinate = try NSRegularExpression(pattern: #"-?\d{1,3}\.\d{4,}"#)
        for detail in details { XCTAssertNil(coordinate.firstMatch(in: detail, range: NSRange(detail.startIndex..., in: detail)), detail) }
    }

    func testARestoredGrantIsLoggedOnlyAfterItWasLost() throws {
        let local = try store(apps: [app("ski", "g")])
        var none = app("ski", "x"); none["grant"] = NSNull()
        try local.saveApps(try JSONSerialization.data(withJSONObject: [none]))
        try local.saveApps(try JSONSerialization.data(withJSONObject: [app("ski", "g2")]))
        XCTAssertEqual(try events(local).map(\.kind), [.grantLost, .sessionEnded, .grantRestored])
        XCTAssertEqual(local.sessions(), [], "a restored grant starts nothing")
    }

    /// #647: the history queries on hot paths (acknowledge per id, the 2 s per-app refresh, expiry every sync) use
    /// an index. Without one they scan up to 200,000 rows while holding the store lock.
    func testHotHistoryQueriesUseAnIndex() throws {
        let local = try store(apps: [app("ski", "g")])
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        defer { sqlite3_close(db) }
        func plan(_ sql: String) -> String {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "EXPLAIN QUERY PLAN " + sql, -1, &statement, nil) == SQLITE_OK else { return "prepare failed" }
            defer { sqlite3_finalize(statement) }
            var details: [String] = []
            while sqlite3_step(statement) == SQLITE_ROW { details.append(String(cString: sqlite3_column_text(statement, 3))) }
            return details.joined(separator: "; ")
        }
        for (sql, index) in [
            ("UPDATE share_points SET sent_at = 1 WHERE point_id = 'p' AND sent_at IS NULL", "share_points_point"),
            ("SELECT MAX(sent_at) FROM share_points WHERE app_id = 'ski'", "COVERING INDEX share_points_app_sent"),
            ("SELECT COUNT(*) FROM share_points WHERE app_id = 'ski' AND sent_at IS NULL", "COVERING INDEX share_points_app_sent"),
            ("DELETE FROM share_points WHERE at < 1", "share_points_at"),
            ("SELECT rowid FROM share_points ORDER BY at DESC LIMIT -1 OFFSET 200000", "share_points_at"),
        ] {
            let detail = plan(sql)
            XCTAssertTrue(detail.contains(index), "\(sql): \(detail)")
            XCTAssertFalse(detail.contains("TEMP B-TREE"), "\(sql): \(detail)")
        }
    }

    // MARK: Heart rate (#631)

    private func entry(_ id: String, _ capability: String, _ grant: String) -> [String: Any] {
        ["appId": id, "appName": id, "capability": capability, "name": "n", "purpose": "p", "disclosure": "d", "version": "1",
         "grant": ["id": grant, "consent_at": 1]]
    }

    /// Run with location grant `run-loc` and heart-rate grant `run-hr`, Ski with location only; both sharing unless
    /// `sessions` is false.
    private func runStore(sessions: Bool = true) throws -> LocalStore {
        let local = try store(apps: [app("ski", "ski-loc"), app("run", "run-loc")], sessions: sessions)
        try local.saveEntries(try JSONSerialization.data(withJSONObject: [
            entry("ski", "location.background", "ski-loc"), entry("run", "location.background", "run-loc"), entry("run", "heart_rate.ble", "run-hr")]))
        return local
    }

    private func sample(_ id: String, at: Int64, bpm: Int = 140) -> HeartRateSample { HeartRateSample(id: id, at: at, bpm: bpm, grants: ["run-hr"]) }

    func testBlockingRunHeartRateLeavesRunLocationIntact() throws {
        let local = try runStore()
        try local.enqueueHeartRate(sample("h1", at: 10))
        try local.block("run/heart_rate.ble")
        XCTAssertEqual(try local.heartRateCount(), 0, "its queued samples went with it")
        XCTAssertEqual(LocationPolicy.recipients(local.apps(), blocked: local.blocked(), sessions: local.sessionIds(), at: 20), ["ski-loc", "run-loc"])
        XCTAssertTrue(local.sessionIds().contains("run"), "Run's location keeps the session")
        try local.enqueue(point("p", at: 20, grants: ["run-loc"]))
        XCTAssertEqual(try local.count(), 1)
        try local.enqueueHeartRate(sample("h2", at: 20))
        XCTAssertEqual(try local.heartRateCount(), 0)
        XCTAssertEqual(try events(local).filter { $0.appId == "run" }.map { "\($0.kind.rawValue):\($0.detail)" }, ["heart_rate:disabled"], "not a location `disabled`")
    }

    /// #677: `block(run)` with Run's heart rate on keeps the session and the heart-rate recipients.
    func testBlockingRunLocationLeavesRunHeartRateIntact() throws {
        let local = try runStore()
        try local.enqueueHeartRate(sample("h1", at: 10))
        try local.block("run")
        XCTAssertEqual(try local.heartRateCount(), 1)
        XCTAssertEqual(local.sessionIds(), ["ski", "run"])
        XCTAssertEqual(HeartRatePolicy.recipients(local.entries(), blocked: local.blocked(), sessions: local.sessionIds(), at: 20), ["run-hr"])
        try local.enqueueHeartRate(sample("h2", at: 20))
        XCTAssertEqual(try local.pendingHeartRate().map(\.id), ["h1", "h2"])
        XCTAssertFalse(try local.events().contains { $0.kind == .sessionEnded })
    }

    /// #677 (replaces "turning off a paused Run's location keeps it paused"): blocking location never starts heart rate for
    /// a stopped Run.
    func testBlockingLocationNeverStartsHeartRateForAStoppedRun() throws {
        let local = try runStore()
        try local.endSession("run", detail: "user")
        try local.block("run")
        XCTAssertEqual(HeartRatePolicy.recipients(local.entries(), blocked: local.blocked(), sessions: local.sessionIds(), at: 20), [])
        XCTAssertFalse(local.sessionIds().contains("run"))
        try local.enqueueHeartRate(sample("h", at: 20))
        XCTAssertEqual(try local.heartRateCount(), 0)
    }

    /// Replaces "turning off a paused location-only app clears its pause": its last capability ends the session.
    func testBlockingTheLastCapabilityRecordsSessionEndedGrant() throws {
        let local = try runStore()
        try local.block("ski")
        XCTAssertEqual(local.sessionIds(), ["run"])
        XCTAssertEqual(try events(local).filter { $0.appId == "ski" }.map { "\($0.kind.rawValue):\($0.detail)" }, ["disabled:", "session_ended:grant"])
    }

    /// Replaces "turning off Run's last capability clears its pause": heart rate off keeps the session, location off then
    /// ends it, once.
    func testTurningOffRunsLastCapabilityEndsItsSession() throws {
        let local = try runStore()
        try local.block("run/heart_rate.ble")
        XCTAssertTrue(local.sessionIds().contains("run"))
        try local.block("run")
        XCTAssertFalse(local.sessionIds().contains("run"))
        XCTAssertEqual(try local.events().filter { $0.kind == .sessionEnded && $0.appId == "run" }.map(\.detail), ["grant"])
    }

    /// Replaces "heart rate follows Pause all and Run's pause".
    func testHeartRateFollowsRunsSession() throws {
        let local = try runStore()
        try local.endSession("run", detail: "user")
        try local.enqueueHeartRate(sample("stopped", at: 10))
        XCTAssertEqual(try local.heartRateCount(), 0)
        try local.startSession("run")
        try local.enqueueHeartRate(sample("started", at: 11))
        XCTAssertEqual(try local.heartRateCount(), 1)
    }

    func testHeartRateHistoryIsKeptAcknowledgedExpiredAndCleared() throws {
        let local = try runStore()
        let now: Int64 = 40 * 24 * 60 * 60 * 1000
        try local.enqueueHeartRate(sample("old", at: now - LocationPolicy.HISTORY_MS - 1))
        try local.enqueueHeartRate(sample("unsent-8d", at: now - LocationPolicy.RETENTION_MS - 1))
        try local.enqueueHeartRate(sample("sent-8d", at: now - LocationPolicy.RETENTION_MS - 2, bpm: 99))
        try local.enqueueHeartRate(sample("new", at: now - 1, bpm: 150))
        try local.acknowledgeHeartRate(["old", "sent-8d", "new"], now: now)
        XCTAssertEqual(local.heartRateLastUpload, now)
        XCTAssertEqual(try local.heartRateCount(), 1)
        try local.expire(now: now)
        XCTAssertEqual(try local.heartRateCount(), 0, "the 8-day-old queue copy expired")
        XCTAssertEqual(try local.heartRate(appId: "run", from: 0, to: .max), [HeartRatePoint(at: now - LocationPolicy.RETENTION_MS - 2, bpm: 99), HeartRatePoint(at: now - 1, bpm: 150)])
        XCTAssertEqual(try local.lastHeartRate("run"), HeartRatePoint(at: now - 1, bpm: 150))
        XCTAssertEqual(try local.heartRate(appId: "ski", from: 0, to: .max), [])
        try local.enqueueHeartRate(sample("queued", at: now))
        try local.clearHistory(now: now)
        XCTAssertEqual(try local.heartRate(appId: "run", from: 0, to: .max), [], "Clear history clears heart rate too")
        XCTAssertEqual(try local.heartRateCount(), 1, "and keeps the queue, like points")
        try local.clear()
        XCTAssertEqual(try local.heartRateCount(), 0)
        XCTAssertNil(local.heartRateSensor)
    }

    func testHeartRateQueueStopsAtItsCap() throws {
        let local = try runStore()
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, """
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(HeartRatePolicy.MAX_QUEUE))
            INSERT INTO hr(id, at, payload) SELECT 'h' || i, i, '{}' FROM n
            """, nil, nil, nil), SQLITE_OK)
        XCTAssertThrowsError(try local.enqueueHeartRate(sample("over", at: 10))) { XCTAssertTrue($0 is HeartRateQueueFullError) }
        XCTAssertEqual(try local.heartRateCount(), HeartRatePolicy.MAX_QUEUE)
        XCTAssertEqual(try events(local).map(\.kind), [.heartRateProblem])
    }

    /// #679: the insert that fills the queue reports it, once, because the collector stops before the next one.
    func testTheSampleThatFillsTheHeartRateQueueReportsIt() throws {
        let local = try runStore()
        let full = { try local.events().filter { $0.kind == .heartRateProblem }.map(\.detail) }
        XCTAssertFalse(try local.enqueueHeartRate(sample("below", at: 1)))
        XCTAssertEqual(try full(), [])
        let db = try XCTUnwrap(sqliteHandle(local.fileURL))
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, """
            WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < \(HeartRatePolicy.MAX_QUEUE - 1))
            INSERT INTO hr(id, at, payload) SELECT 'h' || i, i, '{}' FROM n
            """, nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(try local.heartRateCount(), HeartRatePolicy.MAX_QUEUE - 1)
        XCTAssertTrue(try local.enqueueHeartRate(sample("last", at: 10)))
        XCTAssertEqual(try local.heartRateCount(), HeartRatePolicy.MAX_QUEUE)
        XCTAssertEqual(try full(), ["queue_full"])
        XCTAssertThrowsError(try local.enqueueHeartRate(sample("over", at: 11))) { XCTAssertTrue($0 is HeartRateQueueFullError) }
    }

    func testTheSensorIdentifierStaysInSettingsUntilForgotten() throws {
        let local = try runStore()
        let id = UUID()
        local.heartRateSensor = id
        local.close()
        let reopened = try LocalStore(directory: directory)
        XCTAssertEqual(reopened.heartRateSensor, id)
        reopened.heartRateSensor = nil
        XCTAssertNil(reopened.heartRateSensor)
    }

    private func sqliteHandle(_ url: URL) -> OpaquePointer? {
        var db: OpaquePointer?
        return sqlite3_open(url.path, &db) == SQLITE_OK ? db : nil
    }
}
