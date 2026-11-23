import XCTest
@testable import ProAppStore

final class TrackShapeTests: XCTestCase {
    private func s(_ at: Int64, sent: Int64? = 1, accuracy: Double = 5) -> TrackSample { TrackSample(at: at, lat: 1, lng: 2, accuracy: accuracy, sentAt: sent) }

    func testAGapOverAMinuteSplitsAndOneUnderDoesNot() {
        XCTAssertEqual(TrackShape.segments([s(0), s(61_000)]).count, 2)
        XCTAssertEqual(TrackShape.segments([s(0), s(59_000)]).count, 1)
    }

    func testUploadStateSplitsAndFlagsPending() {
        let segments = TrackShape.segments([s(0), s(1_000), s(2_000, sent: nil), s(3_000, sent: nil)])
        XCTAssertEqual(segments.map(\.pending), [false, true])
        XCTAssertEqual(segments.map { $0.samples.map(\.at) }, [[0, 1_000], [2_000, 3_000]])
    }

    func testThinningKeepsEveryEndpointAndStaysUnderTheCap() {
        // Three walks separated by gaps, 12,000 samples in all.
        let samples = (0..<12_000).map { i in s(Int64(i) * 1_000 + Int64(i / 4_000) * 120_000) }
        let full = TrackShape.segments(samples, maxPoints: .max)
        let thinned = TrackShape.segments(samples)
        XCTAssertEqual(thinned.count, 3)
        XCTAssertLessThanOrEqual(thinned.reduce(0) { $0 + $1.samples.count }, 5_000)
        for (a, b) in zip(full, thinned) {
            XCTAssertEqual(a.samples.first, b.samples.first)
            XCTAssertEqual(a.samples.last, b.samples.last)
        }
    }

    func testEmptyInputGivesNoSegments() {
        XCTAssertEqual(TrackShape.segments([]), [])
    }

    /// #639: the map draws only fixes at 25 m or better; a coarse fix neither draws nor bridges a gap.
    func testOnlyFixesAt25MetresOrBetterAreDrawn() {
        let segments = TrackShape.segments([s(0, accuracy: 3), s(10_000, accuracy: 25), s(20_000, accuracy: 25.1), s(30_000, accuracy: 53), s(40_000, accuracy: 4)])
        XCTAssertEqual(segments.map { $0.samples.map(\.at) }, [[0, 10_000, 40_000]])
        XCTAssertEqual(TrackShape.segments([s(0, accuracy: 40), s(1_000, accuracy: 65)]), [])
    }
}
