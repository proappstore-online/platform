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

    private func store(apps: [[String: Any]]) throws -> LocalStore {
        let local = try LocalStore(directory: directory)
        try local.saveApps(try JSONSerialization.data(withJSONObject: apps))
        try local.setPaused(false)
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
        XCTAssertEqual(LocationCollector.saveFailureMessage(CompanionError("SQLite")), "Could not save location on this phone. Collection paused.")
    }

    func testPausedEnqueueIsANoOp() throws {
        let local = try store(apps: [app("ski", "g")])
        try local.setPaused(true)
        try local.enqueue(point("p", at: 10, grants: ["g"]))
        XCTAssertEqual(try local.count(), 0)
    }

    func testSettingsDefaultToPausedAndClearResets() throws {
        let local = try LocalStore(directory: directory)
        XCTAssertTrue(local.paused)
        try local.setPaused(false)
        local.message = "m"; local.userName = "Alex"; local.lastSync = 42
        local.close()
        let reopened = try LocalStore(directory: directory)
        XCTAssertFalse(reopened.paused)
        XCTAssertEqual(reopened.userName, "Alex")
        XCTAssertEqual(reopened.lastSync, 42)
        try reopened.clear()
        XCTAssertTrue(reopened.paused)
        XCTAssertEqual(reopened.message, "")
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

    // MARK: Per-app pause (#620)

    func testPauseFiltersNewPointsToTheOtherRecipient() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.pause("ski")
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try local.pending().first?.grants, ["run-g"])
        try local.pause("run")
        try local.enqueue(point("q", at: 11, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try local.count(), 1)
    }

    func testPauseLeavesQueuedPointsUntouched() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        try local.pause("ski")
        XCTAssertEqual(try local.pending().first?.grants, ["ski-g", "run-g"])
    }

    func testResumeRestoresTaggingAndBlockClearsThePause() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.pause("ski")
        try local.resume("ski")
        try local.enqueue(point("p", at: 10, grants: ["ski-g", "run-g"]))
        XCTAssertEqual(try local.pending().first?.grants, ["ski-g", "run-g"])
        try local.pause("ski")
        try local.block("ski")
        XCTAssertEqual(local.pausedApps(), [])
        XCTAssertEqual(local.excluded(), ["ski"])
    }

    func testPausesSurviveReopenAndClearEmptiesThem() throws {
        let local = try store(apps: [app("ski", "ski-g")])
        try local.pause("ski")
        local.close()
        let reopened = try LocalStore(directory: directory)
        XCTAssertEqual(reopened.pausedApps(), ["ski"])
        try reopened.clear()
        XCTAssertEqual(reopened.pausedApps(), [])
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

    /// Events after setup: `store()`'s own setPaused(false) records a `resumed_all` at the real clock.
    private func events(_ local: LocalStore) throws -> [ShareEvent] { try local.events().filter { $0.kind != .resumedAll } }

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
        XCTAssertEqual(try events(local).map(\.kind), [.disabled])
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
        try local.pause("run")
        try local.setPaused(true)
        try local.clearHistory(now: 99)
        XCTAssertEqual(try local.count(), 1)
        XCTAssertEqual(try history(local), [])
        XCTAssertEqual(try local.events().map { "\($0.kind.rawValue):\($0.appId ?? "-"):\($0.at)" },
                       ["history_cleared:-:99", "enabled:ski:99", "enabled:run:99", "paused:run:99", "paused_all:-:99"])
        try local.clear()
        XCTAssertEqual(try local.events(), [])
        XCTAssertEqual(try history(local), [])
    }

    func testClearEmptiesHistory() throws {
        let local = try store(apps: [app("ski", "g")])
        try local.enqueue(point("p", at: 10, grants: ["g"]))
        try local.pause("ski")
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
        XCTAssertEqual(try reopened.events().map(\.kind), [.resumedAll, .expired])
        try reopened.clearHistory(now: 99)
        XCTAssertEqual(try reopened.events().map(\.kind), [.historyCleared])
    }

    /// #652: Reconnect drops the queue, unsent points and the old grants; the shared history and the log stay.
    func testClearForReconnectKeepsHistoryAndDropsQueueAndGrants() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        try local.enqueue(point("sent", at: 10, grants: ["ski-g"]))
        try local.acknowledge(["sent"], now: 20)
        try local.enqueue(point("queued", at: 30, grants: ["ski-g"]))
        try local.pause("ski")
        try local.block("run")
        try local.markExpired(userId: "u1")
        try local.clearForReconnect()
        XCTAssertEqual(try local.count(), 0)
        XCTAssertEqual(try history(local), ["ski:sent:20"])
        XCTAssertEqual(try local.events().map(\.kind), [.resumedAll, .paused, .disabled, .expired])
        XCTAssertEqual(local.apps(), [])
        XCTAssertEqual(local.blocked(), [])
        XCTAssertEqual(local.pausedApps(), [])
        XCTAssertFalse(local.expired)
        XCTAssertTrue(local.paused)
    }

    func testSeedOnAnEmptyHistoryDatesEnabledAtConsent() throws {
        let local = try LocalStore(directory: directory)
        try local.saveApps(try JSONSerialization.data(withJSONObject: [app("run", "run-g")])) // consent_at 1
        try local.seedIfEmpty(now: 500)
        XCTAssertEqual(try local.events().map { "\($0.kind.rawValue):\($0.at):\($0.detail)" }, ["enabled:1:seeded", "paused_all:500:seeded"])
        try local.seedIfEmpty(now: 600)
        XCTAssertEqual(try local.events().count, 2) // only once
    }

    func testSaveAppsRecordsALostGrant() throws {
        let local = try store(apps: [app("ski", "ski-g"), app("run", "run-g")])
        var revoked = app("run", "x"); revoked["grant"] = NSNull()
        try local.saveApps(try JSONSerialization.data(withJSONObject: [app("ski", "ski-new"), revoked]))
        XCTAssertEqual(try events(local).map { "\($0.kind.rawValue):\($0.appId!):\($0.detail)" }, ["grant_lost:ski:replaced", "grant_lost:run:revoked"])
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
        try local.pause("ski"); try local.block("ski")
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
        XCTAssertEqual(try events(local).map(\.kind), [.grantLost, .grantRestored])
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

    private func sqliteHandle(_ url: URL) -> OpaquePointer? {
        var db: OpaquePointer?
        return sqlite3_open(url.path, &db) == SQLITE_OK ? db : nil
    }
}
