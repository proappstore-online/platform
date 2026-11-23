package online.proappstore.companion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.cos

/** One app's track on a map. */
data class MapTrack(val id: String, val color: Color, val segments: List<TrackShape.Segment>)

/** Stable per-app colour by position in `/native/me`, whose order is stable. */
object TrackPalette {
    private val colors = listOf(Color(0xFF2563EB), Color(0xFFEA580C), Color(0xFF16A34A), Color(0xFFDB2777))
    fun color(appId: String, apps: List<ConnectedApp>): Color = colors[maxOf(0, apps.indexOfFirst { it.id == appId }) % colors.size]
}

/**
 * Fits points into a box with an equirectangular projection, longitude scaled by the cosine of the middle latitude so
 * a track keeps its shape. No map tiles: those would need a map SDK or API key (#638). Pure.
 */
class TrackProjection(points: List<Pair<Double, Double>>, private val width: Float, private val height: Float, private val padding: Float) {
    private val minLat = points.minOfOrNull { it.first } ?: 0.0
    private val maxLat = points.maxOfOrNull { it.first } ?: 0.0
    private val minLng = points.minOfOrNull { it.second } ?: 0.0
    private val maxLng = points.maxOfOrNull { it.second } ?: 0.0
    private val xScale = cos((minLat + maxLat) / 2 * PI / 180)
    /** At least about 200 m across, so one point or a short track is not blown up to the whole box. */
    private val span = maxOf((maxLng - minLng) * xScale, maxLat - minLat, 0.002)
    private val scale = minOf(width - 2 * padding, height - 2 * padding) / span
    private val cx = (minLng + maxLng) / 2 * xScale
    private val cy = (minLat + maxLat) / 2

    fun project(lat: Double, lng: Double) = Offset((width / 2 + (lng * xScale - cx) * scale).toFloat(), (height / 2 - (lat - cy) * scale).toFloat())
}

/**
 * Draws shared tracks from the phone's own history on a plain background. Solid = acknowledged, dashed = waiting to
 * upload. The live dot is the collector's last fix, never a second location source; without one the last shared point
 * is a hollow marker labelled with its time. `interactive` adds pinch and drag with a Recenter button.
 */
@Composable
fun TrackMap(tracks: List<MapTrack>, live: LiveFix?, interactive: Boolean, modifier: Modifier = Modifier, emptyText: String? = null) {
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    val measurer = rememberTextMeasurer()
    val ground = MaterialTheme.colorScheme.surfaceVariant
    val grid = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
    val label = MaterialTheme.colorScheme.onSurface
    val surface = MaterialTheme.colorScheme.surface
    val empty = tracks.all { it.segments.isEmpty() }
    val last = tracks.mapNotNull { it.segments.lastOrNull()?.samples?.lastOrNull() }.maxByOrNull { it.at }
    Column(modifier) {
        Box(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(ground)
            .then(if (interactive) Modifier.pointerInput(Unit) {
                detectTransformGestures { _, move, gesture, _ -> zoom = (zoom * gesture).coerceIn(1f, 40f); pan += move }
            } else Modifier)
            .semantics { contentDescription = if (empty) "Sharing map, empty" else "Sharing map with ${tracks.count { it.segments.isNotEmpty() }} tracks" }) {
            Canvas(Modifier.fillMaxSize()) {
                val step = 32.dp.toPx()
                var x = 0f; while (x < size.width) { drawLine(grid, Offset(x, 0f), Offset(x, size.height)); x += step }
                var y = 0f; while (y < size.height) { drawLine(grid, Offset(0f, y), Offset(size.width, y)); y += step }
                val points = tracks.flatMap { t -> t.segments.flatMap { s -> s.samples.map { it.lat to it.lng } } } + listOfNotNull(live?.let { it.lat to it.lng })
                if (points.isEmpty()) return@Canvas
                val projection = TrackProjection(points, size.width, size.height, 24.dp.toPx())
                val center = Offset(size.width / 2, size.height / 2)
                fun at(lat: Double, lng: Double) = (projection.project(lat, lng) - center) * zoom + center + pan
                for (track in tracks) for (segment in track.segments) {
                    val path = Path()
                    segment.samples.forEachIndexed { i, s -> val p = at(s.lat, s.lng); if (i == 0) path.moveTo(p.x, p.y) else path.lineTo(p.x, p.y) }
                    if (segment.samples.size == 1) drawCircle(track.color, 3.dp.toPx(), at(segment.samples[0].lat, segment.samples[0].lng))
                    else drawPath(path, track.color, style = Stroke(4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round,
                        pathEffect = if (segment.pending) PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 6.dp.toPx())) else null))
                }
                if (live != null) {
                    val p = at(live.lat, live.lng)
                    drawCircle(Color.White, 9.dp.toPx(), p)
                    drawCircle(Color(0xFF2563EB), 6.dp.toPx(), p)
                } else if (last != null) {
                    val p = at(last.lat, last.lng)
                    drawCircle(surface, 6.dp.toPx(), p)
                    drawCircle(label.copy(alpha = 0.6f), 6.dp.toPx(), p, style = Stroke(3.dp.toPx()))
                    drawText(measurer, Format.time(last.at), Offset(p.x + 10.dp.toPx(), p.y - 8.dp.toPx()), TextStyle(fontSize = 11.sp, color = label))
                }
            }
            val note = if (empty) emptyText else if (live == null) "Not sharing now" else null
            if (note != null) Text(note, style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp).background(surface.copy(alpha = 0.9f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 6.dp))
            if (interactive && (zoom != 1f || pan != Offset.Zero)) TextButton(onClick = { zoom = 1f; pan = Offset.Zero },
                modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).background(surface.copy(alpha = 0.9f), RoundedCornerShape(50))) { Text("Recenter") }
        }
        Text("Solid: uploaded · Dashed: waiting to upload", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
