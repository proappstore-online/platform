import Foundation

/// Run's strap heart rate (#631): the `heart_rate.ble` capability id and its Bluetooth Heart Rate Service UUIDs.
enum HeartRate {
    static let CAPABILITY = "heart_rate.ble"
    static let SERVICE = "180D"
    static let MEASUREMENT = "2A37"
}

/// One Heart Rate Measurement (GATT 0x2A37) notification, per the Heart Rate Service spec. Pure.
enum HeartRateMeasurement {
    /// Flags bit 0: 16-bit value; bit 2: contact supported, bit 1: contact detected; bits 3-4: energy expended and
    /// RR intervals follow the value (ignored). `contact` is nil when the sensor does not report contact. Nil for
    /// short or malformed data, or bpm outside 25-250.
    static func parse(_ data: Data) -> (bpm: Int, contact: Bool?)? {
        let bytes = [UInt8](data)
        guard let flags = bytes.first else { return nil }
        let wide = flags & 0x01 != 0
        guard bytes.count >= (wide ? 3 : 2) else { return nil }
        let bpm = wide ? Int(bytes[1]) | Int(bytes[2]) << 8 : Int(bytes[1])
        guard (25...250).contains(bpm) else { return nil }
        return (bpm, flags & 0x04 != 0 ? flags & 0x02 != 0 : nil)
    }
}

/// Which parsed readings become samples: contact detected or not reported, at most one a second. Pure: fed readings
/// in delivery order.
struct HeartRatePolicy {
    /// 100,000 pending samples, about 28 h at 1 Hz: collection stops visibly, like location's 60,000.
    static let MAX_QUEUE = 100_000
    static let MIN_INTERVAL_MS: Int64 = 1_000
    /// On-device history cap (#621's rule for points): about 55 h at 1 Hz inside the 30-day window.
    static let HISTORY_MAX_SAMPLES = 200_000
    private var lastAt: Int64?

    mutating func accept(contact: Bool?, at: Int64) -> Bool {
        guard contact != false else { return false }
        if let lastAt, at - lastAt < Self.MIN_INTERVAL_MS { return false }
        lastAt = at
        return true
    }

    /// The heart-rate grants current at `at`: the entry is not disabled and its app has a session (ADR-020). No session,
    /// no reads.
    static func recipients(_ entries: [NativeEntry], blocked: Set<String>, sessions: Set<String>, at: Int64) -> [String] {
        entries.filter { $0.capability == HeartRate.CAPABILITY && !blocked.contains($0.key) && sessions.contains($0.appId) && at >= $0.consentAt }
            .compactMap(\.grantId)
    }
}

/// One queued reading. Encodes to exactly the `POST /native/heart-rate` sample shape.
struct HeartRateSample: Codable, Equatable {
    let id: String
    let at: Int64
    let bpm: Int
    let grants: [String]

    func with(grants: [String]) -> HeartRateSample { HeartRateSample(id: id, at: at, bpm: bpm, grants: grants) }
}

/// One sample of the on-device heart-rate history.
struct HeartRatePoint: Equatable {
    let at: Int64
    let bpm: Int
}

/// A chart bucket: the samples in `[start, end)`. `segment` changes after an empty bucket, so a gap in the samples
/// stays a gap in the line rather than being drawn across.
struct HeartRateBucket: Equatable, Identifiable {
    let start: Int64
    let end: Int64
    let min: Int
    let max: Int
    let mean: Int
    let segment: Int
    var id: Int64 { start }
}

/// The bpm chart on a session's time axis (#631). Pure.
enum HeartRateChart {
    /// `samples` oldest first, cut into `count` equal buckets over `range`; empty buckets are omitted. Samples outside
    /// `range` are ignored.
    static func buckets(_ samples: [HeartRatePoint], range: ClosedRange<Int64>, count: Int = 120) -> [HeartRateBucket] {
        let span = range.upperBound - range.lowerBound
        guard count > 0, span > 0 else { return [] }
        let width = Swift.max(1, (span + Int64(count) - 1) / Int64(count))
        var groups: [Int64: [Int]] = [:]
        for s in samples where range.contains(s.at) { groups[Swift.min((s.at - range.lowerBound) / width, Int64(count - 1)), default: []].append(s.bpm) }
        var result: [HeartRateBucket] = [], segment = 0, previous: Int64?
        for index in groups.keys.sorted() {
            let bpm = groups[index]!
            if let previous, index != previous + 1 { segment += 1 }
            previous = index
            let start = range.lowerBound + index * width
            result.append(HeartRateBucket(start: start, end: start + width, min: bpm.min()!, max: bpm.max()!,
                                          mean: Int((Double(bpm.reduce(0, +)) / Double(bpm.count)).rounded()), segment: segment))
        }
        return result
    }
}
