import XCTest
@testable import ProAppStore

final class SharingTimelineTests: XCTestCase {
    private let min: Int64 = 60_000
    private var nextId: Int64 = 0

    private func e(_ kind: ShareEvent.Kind, _ at: Int64, _ appId: String? = "run", _ detail: String = "") -> ShareEvent {
        nextId += 1
        return ShareEvent(id: nextId, at: at, appId: appId, kind: kind, detail: detail)
    }

    func testPauseAndResumeInsideAClosedSession() {
        let t = 10 * 60 * min
        let sessions = SharingTimeline.sessions([e(.enabled, t), e(.sessionStarted, t), e(.paused, t + 20 * min), e(.resumed, t + 30 * min), e(.disabled, t + 60 * min)], appId: "run")
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].end, t + 60 * min)
        XCTAssertEqual(sessions[0].endKind, .disabled)
        XCTAssertEqual(sessions[0].inactive, [InactiveInterval(start: t + 20 * min, end: t + 30 * min, cause: .you)])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(t * 2)), 50 * min)
    }

    func testPauseAllOverlappingAnAppPauseIsNotDoubleSubtracted() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.sessionStarted, 0), e(.paused, 10 * min), e(.pausedAll, 15 * min, nil), e(.resumed, 20 * min), e(.resumedAll, 30 * min, nil), e(.disabled, 60 * min),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive.map(\.cause), [.you, .all])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(100 * min)), 40 * min)
    }

    func testASessionAcrossMidnightCountsOnlyTodaysPart() {
        let midnight: Int64 = 24 * 60 * min
        let sessions = SharingTimeline.sessions([e(.enabled, midnight - 30 * min), e(.sessionStarted, midnight - 30 * min)], appId: "run") // still open
        XCTAssertNil(sessions[0].end)
        XCTAssertEqual(sessions[0].sharedMs(within: midnight...(midnight + 45 * min)), 45 * min)
        XCTAssertEqual(sessions[0].sharedMs(within: (midnight - 60 * min)...(midnight - 1)), 30 * min - 1)
    }

    func testGrantLostEndsTheSession() {
        let sessions = SharingTimeline.sessions([e(.enabled, 0), e(.grantLost, 5 * min, "run", "revoked"), e(.enabled, 9 * min, "ski")], appId: "run")
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].endKind, .grantLost)
        XCTAssertEqual(sessions[0].end, 5 * min)
    }

    func testAppResumeUnderPauseAllStaysInactiveUntilResumeAll() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.sessionStarted, 0), e(.paused, 10 * min), e(.pausedAll, 20 * min, nil), e(.resumed, 30 * min), e(.resumedAll, 40 * min, nil),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive, [
            InactiveInterval(start: 10 * min, end: 20 * min, cause: .you),
            InactiveInterval(start: 20 * min, end: 40 * min, cause: .all),
        ])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(50 * min)), 20 * min)
    }

    func testForcedStopAndOtherAppsEventsAndHistoryCleared() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.sessionStarted, 0), e(.paused, 5 * min, "ski"), e(.stopped, 10 * min, nil, "signed_out"), e(.resumedAll, 20 * min, nil), e(.historyCleared, 30 * min, nil),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive, [InactiveInterval(start: 10 * min, end: 20 * min, cause: .system("signed_out"))])
        XCTAssertEqual(sessions[0].endKind, .historyCleared)
    }

    /// #652: an expiry ends every open session; re-enabling after Reconnect starts a new one.
    func testExpiryEndsTheSessionAndReconnectStartsANewOne() {
        let sessions = SharingTimeline.sessions([e(.enabled, 0), e(.expired, 10 * min, nil), e(.enabled, 30 * min)], appId: "run")
        XCTAssertEqual(sessions.map(\.start), [0, 30 * min])
        XCTAssertEqual(sessions[0].end, 10 * min)
        XCTAssertEqual(sessions[0].endKind, .expired)
        XCTAssertNil(sessions[1].end)
    }

    func testARestoredGrantStartsASessionAndEnableInsideItContinuesIt() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.grantLost, 10 * min), e(.grantRestored, 20 * min), e(.enabled, 20 * min),
        ], appId: "run")
        XCTAssertEqual(sessions.map(\.start), [0, 20 * min])
        XCTAssertNil(sessions[1].end)
    }

    func testPeriodsCutASessionIntoSharedAndInactiveStretches() {
        let session = SharingTimeline.sessions([e(.enabled, 0), e(.sessionStarted, 0), e(.paused, 10 * min), e(.resumed, 20 * min)], appId: "run")[0]
        XCTAssertEqual(session.periods(now: 30 * min), [
            SharingPeriod(start: 0, end: 10 * min, cause: nil),
            SharingPeriod(start: 10 * min, end: 20 * min, cause: .you),
            SharingPeriod(start: 20 * min, end: 30 * min, cause: nil),
        ])
    }

    /// ADR-020: an enabled app shares only inside a collection session; each gap says why.
    func testSharingIsInactiveOutsideCollectionSessions() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.sessionStarted, 10 * min), e(.sessionEnded, 40 * min, "run", "stationary"), e(.sessionStarted, 50 * min),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive, [
            InactiveInterval(start: 0, end: 10 * min, cause: .stopped("")),
            InactiveInterval(start: 40 * min, end: 50 * min, cause: .stopped("stationary")),
        ])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(60 * min)), 40 * min)
        XCTAssertEqual(SharingTimeline.sessions([e(.enabled, 0)], appId: "run")[0].sharedMs(within: 0...(60 * min)), 0, "enabled, never started")
        XCTAssertEqual(AppSharingView.label(.stopped("stationary")), "not sharing")
    }

    /// A Pause all left open by older history (a fresh store started paused) ends at the first session start, and old
    /// `paused` / `paused_all` rows still decode into the timeline.
    func testASessionStartEndsALegacyPauseAll() {
        let sessions = SharingTimeline.sessions([e(.enabled, 0), e(.pausedAll, 5 * min, nil), e(.sessionStarted, 10 * min)], appId: "run")
        XCTAssertEqual(sessions[0].inactive.map(\.cause), [.stopped(""), .all])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(20 * min)), 10 * min)
    }

    /// Location turned off mid-session ends the consent period; the session's end is recorded after it and changes nothing.
    func testDisablingDuringASessionEndsTheConsentPeriodOnce() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.sessionStarted, 0), e(.disabled, 20 * min), e(.sessionEnded, 20 * min, "run", "grant"), e(.enabled, 30 * min),
        ], appId: "run")
        XCTAssertEqual(sessions.map(\.end), [20 * min, nil])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(60 * min)), 20 * min)
        XCTAssertEqual(sessions[1].inactive.map(\.cause), [.stopped("")], "re-enabling does not start sharing")
    }

    /// #648: the maps' task key must not change between two renders of the same day, or the track reloads every 2 s.
    func testTodaysTrackKeyIsStableThroughTheDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Australia/Sydney")!
        let morning = Date(timeIntervalSince1970: 1_763_850_000) // 2025-11-23 09:20 in Sydney
        let later = morning.addingTimeInterval(2)
        let key = { (now: Date) in TrackKey(range: SharingTimeline.todayTrack(now: now, calendar: calendar), queued: 3, lastSync: 1) }
        XCTAssertEqual(key(morning), key(later))
        XCTAssertEqual(SharingTimeline.todayTrack(now: later, calendar: calendar).lowerBound, SharingTimeline.today(now: later, calendar: calendar).lowerBound)
        XCTAssertNotEqual(key(morning), key(morning.addingTimeInterval(86_400)), "a new day is a new range")
    }

    /// The open end still returns every stored point, including one recorded just now.
    func testAnOpenEndedTrackIncludesTheNewestPoint() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let local = try LocalStore(directory: directory)
        let app: [String: Any] = ["id": "run", "name": "Run", "purpose": "p", "disclosure": "d", "version": "1", "grant": ["id": "g", "consent_at": 1]]
        try local.saveApps(try JSONSerialization.data(withJSONObject: [app]))
        try local.startSession("run")
        let now = CompanionRepository.now()
        try local.enqueue(TrackPoint(id: "p", at: now, lat: 1, lng: 2, accuracy: 5, grants: ["g"]))
        XCTAssertEqual(try local.track(appId: "run", from: SharingTimeline.todayTrack().lowerBound, to: SharingTimeline.todayTrack().upperBound).map(\.at), [now])
    }
}
