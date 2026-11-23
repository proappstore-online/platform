package online.proappstore.companion

import kotlin.math.ceil

/** Turns a track into drawable polylines. Pure; ported from iOS TrackShape.swift. */
object TrackShape {
    /** `pending`: not yet acknowledged, drawn dashed. */
    data class Segment(val samples: List<TrackSample>, val pending: Boolean)

    /** #639: a coarser fix is drawn nowhere. Indoor fixes of 12-53 m drew a scribble around a phone that never moved. */
    const val MAX_ACCURACY_METERS = 25.0

    /**
     * Drops fixes coarser than `maxAccuracy`, then splits wherever consecutive samples are more than `maxGap` apart (pauses, stops and OS gaps are never bridged by a
     * straight line; ADR-015) and wherever upload state changes. Then thins by stride to at most about `maxPoints`
     * coordinates in total, always keeping each segment's first and last sample.
     */
    fun segments(samples: List<TrackSample>, maxGap: Long = 60_000, maxPoints: Int = 5_000, maxAccuracy: Double = MAX_ACCURACY_METERS): List<Segment> {
        val segments = mutableListOf<MutableList<TrackSample>>()
        val pending = mutableListOf<Boolean>()
        for (sample in samples) {
            if (sample.accuracy > maxAccuracy) continue
            val isPending = sample.sentAt == null
            val last = segments.lastOrNull()?.last()
            if (last != null && sample.at - last.at <= maxGap && pending.last() == isPending) segments.last() += sample
            else { segments += mutableListOf(sample); pending += isPending }
        }
        val total = segments.sumOf { it.size }
        if (total <= maxPoints) return segments.mapIndexed { i, s -> Segment(s, pending[i]) }
        val interior = segments.sumOf { maxOf(0, it.size - 2) }
        // Endpoints are always kept; each segment's stride rounding can add one more.
        val budget = maxOf(1, maxPoints - 3 * segments.size)
        val stride = ceil(interior.toDouble() / budget).toInt()
        return segments.mapIndexed { i, s ->
            Segment(s.filterIndexed { index, _ -> index == 0 || index == s.lastIndex || index % stride == 0 }, pending[i])
        }
    }
}
