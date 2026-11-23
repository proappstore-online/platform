import CoreLocation

/// One shared point from the on-device history. `sentAt` nil = still waiting to upload.
struct TrackSample: Equatable {
    let at: Int64
    let lat: Double
    let lng: Double
    let accuracy: Double
    let sentAt: Int64?

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
}

/// Turns a track into drawable polylines. Pure.
enum TrackShape {
    struct Segment: Equatable {
        var samples: [TrackSample]
        /// Not yet acknowledged: drawn dashed.
        let pending: Bool
    }

    /// Splits wherever consecutive samples are more than `maxGap` apart (pauses, stops and OS gaps are never
    /// bridged by a straight line; ADR-015) and wherever upload state changes. Then thins by stride to at most
    /// about `maxPoints` coordinates in total, always keeping each segment's first and last sample.
    static func segments(_ samples: [TrackSample], maxGap: Int64 = 60_000, maxPoints: Int = 5_000) -> [Segment] {
        var segments: [Segment] = []
        for sample in samples {
            let pending = sample.sentAt == nil
            if let last = segments.last?.samples.last, sample.at - last.at <= maxGap, segments[segments.count - 1].pending == pending {
                segments[segments.count - 1].samples.append(sample)
            } else {
                segments.append(Segment(samples: [sample], pending: pending))
            }
        }
        let total = segments.reduce(0) { $0 + $1.samples.count }
        guard total > maxPoints else { return segments }
        let interior = segments.reduce(0) { $0 + max(0, $1.samples.count - 2) }
        // Endpoints are always kept; each segment's stride rounding can add one more.
        let budget = max(1, maxPoints - 3 * segments.count)
        let stride = Int((Double(interior) / Double(budget)).rounded(.up))
        return segments.map { segment in
            let last = segment.samples.count - 1
            return Segment(samples: segment.samples.enumerated().filter { $0.offset == 0 || $0.offset == last || $0.offset % stride == 0 }.map(\.element),
                           pending: segment.pending)
        }
    }
}
