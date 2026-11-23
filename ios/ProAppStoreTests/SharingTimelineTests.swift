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
        let sessions = SharingTimeline.sessions([e(.enabled, t), e(.paused, t + 20 * min), e(.resumed, t + 30 * min), e(.disabled, t + 60 * min)], appId: "run")
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].end, t + 60 * min)
        XCTAssertEqual(sessions[0].endKind, .disabled)
        XCTAssertEqual(sessions[0].inactive, [InactiveInterval(start: t + 20 * min, end: t + 30 * min, cause: .you)])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(t * 2)), 50 * min)
    }

    func testPauseAllOverlappingAnAppPauseIsNotDoubleSubtracted() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.paused, 10 * min), e(.pausedAll, 15 * min, nil), e(.resumed, 20 * min), e(.resumedAll, 30 * min, nil), e(.disabled, 60 * min),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive.map(\.cause), [.you, .all])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(100 * min)), 40 * min)
    }

    func testASessionAcrossMidnightCountsOnlyTodaysPart() {
        let midnight: Int64 = 24 * 60 * min
        let sessions = SharingTimeline.sessions([e(.enabled, midnight - 30 * min)], appId: "run") // still open
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
            e(.enabled, 0), e(.paused, 10 * min), e(.pausedAll, 20 * min, nil), e(.resumed, 30 * min), e(.resumedAll, 40 * min, nil),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive, [
            InactiveInterval(start: 10 * min, end: 20 * min, cause: .you),
            InactiveInterval(start: 20 * min, end: 40 * min, cause: .all),
        ])
        XCTAssertEqual(sessions[0].sharedMs(within: 0...(50 * min)), 20 * min)
    }

    func testForcedStopAndOtherAppsEventsAndHistoryCleared() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.paused, 5 * min, "ski"), e(.stopped, 10 * min, nil, "signed_out"), e(.resumedAll, 20 * min, nil), e(.historyCleared, 30 * min, nil),
        ], appId: "run")
        XCTAssertEqual(sessions[0].inactive, [InactiveInterval(start: 10 * min, end: 20 * min, cause: .system("signed_out"))])
        XCTAssertEqual(sessions[0].endKind, .historyCleared)
    }

    func testARestoredGrantStartsASessionAndEnableInsideItContinuesIt() {
        let sessions = SharingTimeline.sessions([
            e(.enabled, 0), e(.grantLost, 10 * min), e(.grantRestored, 20 * min), e(.enabled, 20 * min),
        ], appId: "run")
        XCTAssertEqual(sessions.map(\.start), [0, 20 * min])
        XCTAssertNil(sessions[1].end)
    }

    func testPeriodsCutASessionIntoSharedAndInactiveStretches() {
        let session = SharingTimeline.sessions([e(.enabled, 0), e(.paused, 10 * min), e(.resumed, 20 * min)], appId: "run")[0]
        XCTAssertEqual(session.periods(now: 30 * min), [
            SharingPeriod(start: 0, end: 10 * min, cause: nil),
            SharingPeriod(start: 10 * min, end: 20 * min, cause: .you),
            SharingPeriod(start: 20 * min, end: 30 * min, cause: nil),
        ])
    }
}
