package online.proappstore.companion

import android.text.format.DateFormat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.util.Date
import java.util.Locale

/** One app row's state chip. Pure, so every combination is table-tested. Ported from iOS SharingDashboardView.swift. */
enum class SharingState(val label: String) {
    SHARING("Sharing"), STOPPED("Stopped"), OFF("Off"), TURNING_OFF("Turning off…"), NOT_RECORDING("Not recording"),
    /** The device connection expired (#652); set by [CompanionState.stateOf], not [of]. */
    EXPIRED("Connection expired");

    companion object {
        /** `blocked` with a grant still held means the server `DELETE` has not gone through yet. `session`: ADR-020's, started by the user. */
        fun of(granted: Boolean, blocked: Boolean, session: Boolean, running: Boolean): SharingState = when {
            blocked -> if (granted) TURNING_OFF else OFF
            !granted -> OFF
            !session -> STOPPED
            running -> SHARING
            else -> NOT_RECORDING
        }
    }
}

internal val Orange = Color(0xFFEA580C)
@Composable internal fun SharingState.color(): Color = when (this) {
    SharingState.SHARING -> Color(0xFF16A34A)
    SharingState.TURNING_OFF -> Orange
    SharingState.STOPPED, SharingState.OFF, SharingState.EXPIRED -> MaterialTheme.colorScheme.onSurfaceVariant
    SharingState.NOT_RECORDING -> MaterialTheme.colorScheme.error
}

/** An expired connection's grants are gone on the server: nothing is enabled until the user re-enables it. */
internal fun CompanionState.enabled(app: ConnectedApp) = !expired && app.grantId != null && app.id !in blocked
internal fun CompanionState.sharing(app: ConnectedApp) = enabled(app) && app.id in sessions
internal fun CompanionState.stateOf(app: ConnectedApp) = if (expired) SharingState.EXPIRED
    else SharingState.of(app.grantId != null, app.id in blocked, app.id in sessions, running)
internal fun CompanionState.sharedToday(appId: String): Long {
    val today = SharingTimeline.today(now)
    return SharingTimeline.sessions(events, appId).sumOf { it.sharedMs(today) }
}
/** The collector's fix while it is running and under 30 s old: the live dot. */
internal fun CompanionState.liveFix(): LiveFix? = lastFix?.takeIf { running && now - it.at < 30_000 }

/** Plain text formatting shared by the sharing screens. */
internal object Format {
    fun duration(ms: Long): String { val minutes = ms / 60_000; return if (minutes >= 60) "${minutes / 60} h ${minutes % 60} min" else "$minutes min" }
    fun time(ms: Long): String = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(Date(ms))
    fun dateTime(ms: Long): String = DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), "dMMMjjmm"), ms).toString()
    fun day(ms: Long): String = DateFormat.format(DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEEdMMMMyyyy"), ms).toString()
    fun relative(ms: Long, now: Long): String = when {
        now - ms < 60_000 -> "just now"
        else -> android.text.format.DateUtils.getRelativeTimeSpanString(ms, now, android.text.format.DateUtils.MINUTE_IN_MILLIS).toString()
    }
    fun cause(cause: InactiveCause?): String = when (cause) {
        null -> "shared"
        InactiveCause.You -> "paused by you"
        InactiveCause.All -> "Pause all"
        is InactiveCause.Stopped -> when (cause.detail) {
            "" -> "not started"
            "user", "all", "notification" -> "stopped by you"
            "stationary" -> "stopped: no movement"
            "max" -> "stopped: 12 hours"
            "permission" -> "stopped: permission"
            else -> "stopped"
        }
        is InactiveCause.System -> "stopped: " + (mapOf("signed_out" to "signed out", "storage_failed" to "storage", "unlock_failed" to "unlock")[cause.detail] ?: cause.detail)
    }
    fun end(kind: ShareEvent.Kind): String = when (kind) {
        ShareEvent.Kind.DISABLED -> "turned off"
        ShareEvent.Kind.GRANT_LOST -> "revoked by ProAppStore"
        ShareEvent.Kind.HISTORY_CLEARED -> "history cleared"
        ShareEvent.Kind.EXPIRED -> "connection expired"
        else -> kind.raw
    }
    val permission = mapOf("" to "Not set", "denied" to "Not allowed", "approximate" to "Approximate only", "whenInUse" to "Precise")
}

@Composable
internal fun Labeled(label: String, value: String) {
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.width(12.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Chip(state: SharingState) {
    val color = state.color()
    Text(state.label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = color,
        modifier = Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp))
}

/** The Sharing tab's dashboard: overview map, header, one row per app with a grant, Available apps, and this phone. */
@Composable
internal fun SharingDashboard(
    state: CompanionState, tracks: List<MapTrack>, connect: () -> Unit, askConsent: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit,
    startApp: (ConnectedApp) -> Unit, stopApp: (ConnectedApp) -> Unit, stopAll: () -> Unit,
    permissions: () -> Unit, sync: () -> Unit, openApp: (ConnectedApp) -> Unit,
    showApp: (ConnectedApp) -> Unit, showActivity: () -> Unit, showMap: () -> Unit, reconnect: () -> Unit = {},
    heartRate: HeartRateHooks = HeartRateHooks(),
) {
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Sharing", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f))
            if (state.signedIn || state.expired) TextButton(onClick = showActivity) { Text("Activity") }
        }
        StatusMessages(state)
        if (state.expired) ExpiredCard(state, reconnect)
        if (!state.signedIn && !state.expired) {
            Text("Your apps, connected to your phone", style = MaterialTheme.typography.titleMedium)
            Text("Enable background features for the PAS apps you use. You stay in control of what each app can access.")
            Button(onClick = connect, enabled = !state.busy) { Text("Sign in to ProAppStore") }
            if (state.pairingCode.isNotBlank()) Text("Match this code in your browser: ${state.pairingCode}")
        } else {
            val granted = state.apps.filter { it.grantId != null }
            val available = state.apps.filter { it.grantId == null && it.id !in state.blocked && !state.expired }
            if (granted.isNotEmpty()) Overview(state, granted, tracks, showMap)
            if (!state.expired) Header(state, stopAll, permissions, sync)
            if (state.apps.isEmpty() && !state.expired) Text("No supported native features are available for your apps yet.")
            granted.forEach { AppRow(state, it, disable, startApp, stopApp, openApp, showApp, heartRate) }
            if (available.isNotEmpty()) {
                Text("Available", style = MaterialTheme.typography.titleLarge)
                available.forEach { app ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(app.name, style = MaterialTheme.typography.titleMedium)
                            Text("Background location: ${app.purpose}", style = MaterialTheme.typography.bodyMedium)
                            Row {
                                TextButton(onClick = { askConsent(app) }, enabled = !state.busy) { Text("Enable") }
                                TextButton(onClick = { openApp(app) }) { Text("Open ${app.name}") }
                            }
                            HeartRateLines(state, app, heartRate, stopApp)
                        }
                    }
                }
            }
            DeviceCard(state, permissions)
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** The expired connection (#652): one way back that keeps the history. */
@Composable
internal fun ExpiredCard(state: CompanionState, reconnect: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Connection expired", style = MaterialTheme.typography.titleLarge)
            Text("This phone is no longer connected to ProAppStore, so location sharing has stopped. Your sharing history stays on this phone. Reconnect, then turn sharing back on for each app.",
                style = MaterialTheme.typography.bodyMedium)
            Button(onClick = reconnect, enabled = !state.busy) { Text("Reconnect") }
            if (state.pairingCode.isNotBlank()) Text("Match this code in your browser: ${state.pairingCode}", style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Today's track for every app with a grant, plus the live dot, with one toggle per app. Tap for full screen. */
@Composable
private fun Overview(state: CompanionState, granted: List<ConnectedApp>, tracks: List<MapTrack>, showMap: () -> Unit) {
    var hidden by remember { mutableStateOf(emptySet<String>()) }
    TrackMap(tracks.filter { it.id !in hidden }, state.liveFix(), interactive = false,
        modifier = Modifier.fillMaxWidth().height(240.dp).clickable(onClickLabel = "Open the map full screen", onClick = showMap))
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        granted.forEach { app ->
            val on = app.id !in hidden
            FilterChip(selected = on, onClick = { hidden = if (on) hidden + app.id else hidden - app.id }, label = { Text(app.name) },
                leadingIcon = { Box(Modifier.size(10.dp).background(TrackPalette.color(app.id, state.apps), CircleShape)) })
        }
    }
}

@Composable
private fun Header(state: CompanionState, stopAll: () -> Unit, permissions: () -> Unit, sync: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(when {
                state.sessions.isEmpty() -> "Not sharing location"
                !state.permissions -> "Location permission needed"
                state.running -> "Location sharing is on"
                else -> "Location is not running"
            }, style = MaterialTheme.typography.titleLarge)
            // ADR-020: sharing runs only in sessions started with Start on an app; Stop all ends every one.
            if (state.sessions.isEmpty()) Text("Tap Start on an app to share while you record. Sharing stops when you tap Stop, after 30 minutes without moving, or after 12 hours.",
                style = MaterialTheme.typography.bodySmall)
            if (!state.permissions) Button(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
            if (state.sessions.isNotEmpty()) OutlinedButton(onClick = stopAll) { Text("Stop all") }
            Text("${state.queued} updates waiting to sync", style = MaterialTheme.typography.bodyMedium)
            // The most severe state that applies. Retries happen with the recorder's 30 s loop, the 15 min upload job and on opening the app.
            val health = when {
                !state.online -> "Offline. Location is kept on this phone and uploads when you're back online."
                state.lastSyncError.isNotBlank() -> "Sync failed ${Format.relative(state.lastSyncAttempt, state.now)}: ${state.lastSyncError} " +
                    if (state.running) "Retrying while location is recording." else "Retries in the background and when you open ProAppStore."
                state.lastSync > 0 -> "Synced ${Format.relative(state.lastSync, state.now)}"
                else -> "Not synced yet"
            }
            Text(health, style = MaterialTheme.typography.bodySmall, color = if (state.online && state.lastSyncError.isBlank()) Color.Unspecified else Orange)
            TextButton(onClick = sync, enabled = !state.busy) { Text("Sync now") }
        }
    }
}

@Composable
private fun AppRow(
    state: CompanionState, app: ConnectedApp, disable: (ConnectedApp) -> Unit, startApp: (ConnectedApp) -> Unit,
    stopApp: (ConnectedApp) -> Unit, openApp: (ConnectedApp) -> Unit, showApp: (ConnectedApp) -> Unit, heartRate: HeartRateHooks,
) {
    val chip = state.stateOf(app)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Show ${app.name} sharing") { showApp(app) }, verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).background(TrackPalette.color(app.id, state.apps), CircleShape))
                Spacer(Modifier.width(8.dp))
                Text(app.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Chip(chip)
                Text("  ›", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (chip == SharingState.TURNING_OFF) Text("Disabled on this phone. Server revocation will finish when connected.", style = MaterialTheme.typography.bodySmall)
            Labeled("Shared today", Format.duration(state.sharedToday(app.id)))
            Labeled("Last upload", state.lastUploadByApp[app.id]?.let { Format.relative(it, state.now) } ?: "None yet")
            Labeled("Waiting to upload", "${state.pendingByApp[app.id] ?: 0}")
            state.sessions[app.id]?.let { Labeled("Sharing for", Format.duration(state.now - it.startedAt)) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (state.enabled(app)) StartStop(state, app, startApp, stopApp)
                TextButton(onClick = { openApp(app) }) { Text("Open ${app.name}") }
                Spacer(Modifier.weight(1f))
                // Not a one-tap button beside Stop: turning off deletes the app's platform copy.
                if (state.enabled(app)) TurnOffMenu(app, state.busy, disable)
            }
            HeartRateLines(state, app, heartRate, stopApp)
        }
    }
}

/** ADR-020: Start, or Stop while the app has a session. Stop never touches the grant; Start needs no new disclosure. */
@Composable
private fun StartStop(state: CompanionState, app: ConnectedApp, startApp: (ConnectedApp) -> Unit, stopApp: (ConnectedApp) -> Unit) {
    if (app.id in state.sessions) OutlinedButton(onClick = { stopApp(app) }) { Text("Stop") }
    else Button(onClick = { startApp(app) }, enabled = !state.busy) { Text("Start") }
}

/** A non-location entry is on: granted, not disabled, connection not expired. */
internal fun CompanionState.enabled(entry: NativeEntry) = !expired && entry.grantId != null && entry.key !in blocked

/** The app's location is on, which heart rate needs: a session starts only with location (ADR-020 decision 11). */
internal fun CompanionState.locationEnabled(appId: String) = apps.any { it.id == appId && enabled(it) }

/** The heart-rate line's state text (#634). Pure, so it is table-tested. */
internal fun CompanionState.heartRateState(entry: NativeEntry): String = when {
    entry.key in blocked -> if (entry.grantId != null) "Turning off…" else "Off"
    !enabled(entry) -> if (locationEnabled(entry.appId)) "Off" else "Off · turn on location for ${entry.appName} first"
    entry.appId !in sessions -> if (locationEnabled(entry.appId)) "Not sharing · tap Start" else "Not sharing · turn on location for ${entry.appName} to start"
    !heartRateSensor -> "No sensor chosen"
    bluetooth == "unauthorized" -> "Bluetooth permission needed"
    bluetooth == "off" -> "Bluetooth is off"
    !heartRateConnected -> "Not connected"
    else -> listOfNotNull("Connected", heartRateBpm?.let { "$it bpm" },
        heartRateLastUpload.takeIf { it > 0 }?.let { "uploaded ${Format.relative(it, now)}" }).joinToString(" · ")
}

/**
 * Run's heart rate under its row: Enable, Choose sensor, state, the control room's figures, Forget sensor, Turn off. Enable
 * is offered only once the app's location is on: heart rate is shared during a session, and a session needs location.
 */
@Composable
private fun HeartRateLines(state: CompanionState, app: ConnectedApp, hooks: HeartRateHooks, stopApp: (ConnectedApp) -> Unit) {
    state.entries.filter { it.appId == app.id && it.capability == HeartRate.CAPABILITY }.forEach { entry ->
        HorizontalDivider()
        Labeled("Heart rate", state.heartRateState(entry))
        if (!state.enabled(entry)) {
            if ((entry.key !in state.blocked || entry.grantId == null) && state.locationEnabled(app.id)) {
                TextButton(onClick = { hooks.askConsent(entry) }, enabled = !state.busy && !state.expired) { Text("Enable heart rate") }
            }
            return@forEach
        }
        // Location turned off during a session leaves heart rate running (#668): its Stop must stay reachable here.
        if (app.id in state.sessions && !state.enabled(app)) OutlinedButton(onClick = { stopApp(app) }) { Text("Stop") }
        Labeled("Heart rate waiting to upload", "${state.heartRateQueued}")
        Labeled("Heart rate last upload", state.heartRateLastUpload.takeIf { it > 0 }?.let { Format.relative(it, state.now) } ?: "None yet")
        Labeled("Last reading", state.lastHeartRateByApp[entry.appId]?.let { "${it.bpm} bpm, ${Format.relative(it.at, state.now)}" } ?: "None yet")
        if (state.heartRateSyncError.isNotBlank()) Text("Heart-rate upload failed: ${state.heartRateSyncError}", style = MaterialTheme.typography.bodySmall, color = Orange)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = hooks.chooseSensor) { Text(if (state.heartRateSensor) "Change sensor" else "Choose sensor") }
            Spacer(Modifier.weight(1f))
            var open by remember { mutableStateOf(false) }
            Box {
                TextButton(onClick = { open = true }, enabled = !state.busy, modifier = Modifier.semantics { contentDescription = "More heart-rate options for ${entry.appName}" }) { Text("⋮") }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    if (state.heartRateSensor) DropdownMenuItem(text = { Text("Forget sensor") }, onClick = { open = false; hooks.forgetSensor() })
                    DropdownMenuItem(text = { Text("Turn off heart rate for ${entry.appName}", color = MaterialTheme.colorScheme.error) }, onClick = { open = false; hooks.disable(entry) })
                }
            }
        }
    }
}

/** Heart rate over the selected range, on the track's time axis: the mean line over its min-max band. Gaps stay gaps. */
@Composable
internal fun HeartRateChartCard(buckets: List<HeartRateBucket>, range: LongRange) {
    if (buckets.isEmpty()) return
    val low = buckets.minOf { it.min }; val high = buckets.maxOf { it.max }
    val line = Color(0xFFDC2626)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Labeled("Heart rate", "$low–$high bpm")
            Canvas(Modifier.fillMaxWidth().height(120.dp).semantics { contentDescription = "Heart rate from $low to $high bpm" }) {
                val span = (range.last - range.first).coerceAtLeast(1).toFloat()
                val top = (high + 5).toFloat(); val bottom = (low - 5).coerceAtLeast(0).toFloat()
                fun x(t: Long) = (t - range.first) / span * size.width
                fun y(bpm: Int) = size.height * (top - bpm) / (top - bottom)
                buckets.groupBy { it.segment }.values.forEach { segment ->
                    val band = Path(); val mean = Path()
                    segment.forEachIndexed { i, b -> val px = x(b.start + (b.end - b.start) / 2); if (i == 0) band.moveTo(px, y(b.max)) else band.lineTo(px, y(b.max)) }
                    segment.asReversed().forEach { b -> band.lineTo(x(b.start + (b.end - b.start) / 2), y(b.min)) }
                    band.close()
                    drawPath(band, line.copy(alpha = 0.15f))
                    segment.forEachIndexed { i, b -> val px = x(b.start + (b.end - b.start) / 2); if (i == 0) mean.moveTo(px, y(b.mean)) else mean.lineTo(px, y(b.mean)) }
                    if (segment.size == 1) drawCircle(line, 3.dp.toPx(), androidx.compose.ui.geometry.Offset(x(segment[0].start + (segment[0].end - segment[0].start) / 2), y(segment[0].mean)))
                    else drawPath(mean, line, style = Stroke(2.dp.toPx()))
                }
            }
            Row { Text(Format.time(range.first), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f)); Text(Format.time(range.last), style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
internal fun TurnOffMenu(app: ConnectedApp, busy: Boolean, disable: (ConnectedApp) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, enabled = !busy, modifier = Modifier.semantics { contentDescription = "More options for ${app.name}" }) { Text("⋮") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Turn off sharing with ${app.name}", color = MaterialTheme.colorScheme.error) }, onClick = { open = false; disable(app) })
        }
    }
}

@Composable
private fun DeviceCard(state: CompanionState, permissions: () -> Unit) {
    Text("This phone", style = MaterialTheme.typography.titleLarge)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Labeled("Location permission", Format.permission[state.permission] ?: state.permission)
            if (state.permission == "approximate") Text("Approximate location never records routes. Choose Precise location.", style = MaterialTheme.typography.bodySmall, color = Orange)
            if (state.permission != "whenInUse") {
                Text("Sharing needs precise location.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
            }
            Labeled("Location services", if (state.locationOn) "On" else "Off")
            if (!state.locationOn) Text("Turn on location in Android settings to record.", style = MaterialTheme.typography.bodySmall, color = Orange)
            Labeled("Battery Saver", if (state.powerSave) "On" else "Off")
            if (state.powerSave) Text("Android may deliver fewer location updates.", style = MaterialTheme.typography.bodySmall, color = Orange)
            Labeled("Battery use", if (state.batteryOptimized) "Optimized" else "Unrestricted")
            val fix = state.lastFix
            Labeled("Recorder", when {
                state.running && fix != null -> "Recording. Last fix ${maxOf(0, (state.now - fix.at) / 1000)} s ago"
                state.running -> "Recording. Waiting for a fix"
                else -> "Not recording"
            })
        }
    }
}

/** One app's map, summary and session timeline. Everything comes from the phone; opening it makes no PAS request. */
@Composable
internal fun AppSharingScreen(
    state: CompanionState, app: ConnectedApp, loadTracks: suspend (List<String>, LongRange) -> Map<String, List<TrackSample>>,
    startApp: (ConnectedApp) -> Unit, stopApp: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit, openApp: (ConnectedApp) -> Unit,
    showActivity: () -> Unit, back: () -> Unit,
    loadHeartRate: suspend (String, LongRange) -> List<HeartRatePoint> = { _, _ -> emptyList() },
) {
    val sessions = remember(state.events, app.id) { SharingTimeline.sessions(state.events, app.id) }
    val current = sessions.lastOrNull()
    // 0 = today, 1 = this session, 2 = a chosen session or period.
    var selection by remember { mutableIntStateOf(0) }
    var custom by remember { mutableStateOf<LongRange?>(null) }
    var expanded by remember { mutableStateOf(emptySet<Long>()) }
    val today = SharingTimeline.today(state.now)
    val range = when (selection) {
        1 -> current?.let { it.start..(it.end ?: state.now) } ?: today
        2 -> custom ?: today
        else -> today
    }
    val track = rememberTracks(listOf(app), state, range, loadTracks)
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        BackRow("Sharing", back)
        Text(app.name, style = MaterialTheme.typography.headlineMedium)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            val labels = if (custom != null) listOf("Today", "Session", "Selected") else listOf("Today", "Session")
            labels.forEachIndexed { i, label ->
                SegmentedButton(selected = selection == i, onClick = { selection = i }, shape = SegmentedButtonDefaults.itemShape(i, labels.size)) { Text(label) }
            }
        }
        TrackMap(track, if (state.sharing(app)) state.liveFix() else null, interactive = true,
            emptyText = "No location was shared with ${app.name} in this period.", modifier = Modifier.fillMaxWidth().height(320.dp))
        // #634: the bpm chart on the track's time axis, from the on-device heart-rate history.
        var heartRate by remember { mutableStateOf(emptyList<HeartRateBucket>()) }
        val openEnded = range.last == state.now
        LaunchedEffect(app.id, range.first, if (openEnded) null else range.last, state.heartRateQueued, state.heartRateLastUpload) {
            val end = if (openEnded) System.currentTimeMillis() else range.last
            heartRate = HeartRateChart.buckets(loadHeartRate(app.id, range.first..end), range.first..end)
        }
        HeartRateChartCard(heartRate, range)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val chip = state.stateOf(app)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(chip.label, style = MaterialTheme.typography.titleMedium, color = chip.color(), modifier = Modifier.weight(1f))
                    if (state.enabled(app)) {
                        StartStop(state, app, startApp, stopApp)
                        TurnOffMenu(app, state.busy, disable)
                    }
                }
                Labeled("Shared today", Format.duration(sessions.sumOf { it.sharedMs(today) }))
                if (current != null && current.end == null) {
                    Labeled("Shared in this session", Format.duration(current.sharedMs(current.start..state.now)))
                    Labeled("Session started", Format.dateTime(current.start))
                }
                TextButton(onClick = { openApp(app) }) { Text("Open ${app.name}") }
            }
        }
        Row(Modifier.fillMaxWidth().clickable(onClick = showActivity).padding(vertical = 8.dp)) {
            Text("Activity", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Text("›", style = MaterialTheme.typography.titleMedium)
        }
        Text("Sessions", style = MaterialTheme.typography.titleLarge)
        if (sessions.isEmpty()) Text("No sharing recorded on this phone yet.")
        sessions.reversed().forEach { session ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val open = session.start in expanded
                    Row(Modifier.fillMaxWidth().clickable {
                        custom = session.start..(session.end ?: state.now); selection = 2
                        expanded = if (open) expanded - session.start else expanded + session.start
                    }) {
                        val end = session.end?.let { " · Ended ${Format.time(it)}" } ?: " · Ongoing"
                        Text("Started ${Format.dateTime(session.start)}$end · Shared ${Format.duration(session.sharedMs(session.start..(session.end ?: state.now)))}",
                            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Text(if (open) "▴" else "▾")
                    }
                    if (session.start < state.now - LocationPolicy.HISTORY_MS) {
                        Text("Started before ${Format.dateTime(state.now - LocationPolicy.HISTORY_MS)}; older history is not kept.", style = MaterialTheme.typography.bodySmall)
                    }
                    if (open) {
                        session.periods(state.now).forEach { period ->
                            Text("${Format.time(period.start)}–${Format.time(period.end)} ${Format.cause(period.cause)}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (period.cause == null) Color.Unspecified else MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().clickable { custom = period.start..period.end; selection = 2 }.padding(vertical = 4.dp))
                        }
                        session.endKind?.let { Text("Ended: ${Format.end(it)}", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** Loads tracks off the main thread when the range changes or new points arrive or upload. */
@Composable
internal fun rememberTracks(apps: List<ConnectedApp>, state: CompanionState, range: LongRange,
                            loadTracks: suspend (List<String>, LongRange) -> Map<String, List<TrackSample>>): List<MapTrack> {
    var tracks by remember { mutableStateOf(emptyList<MapTrack>()) }
    // A range ending "now" is keyed by its start: it reloads when points arrive, not on every clock tick.
    val openEnded = range.last == state.now
    LaunchedEffect(apps.map { it.id }, range.first, if (openEnded) null else range.last, state.queued, state.lastSync) {
        val samples = loadTracks(apps.map { it.id }, range.first..maxOf(range.last, System.currentTimeMillis().takeIf { openEnded } ?: range.last))
        tracks = apps.map { MapTrack(it.id, TrackPalette.color(it.id, state.apps), TrackShape.segments(samples[it.id] ?: emptyList())) }
    }
    return tracks
}

/** The on-device activity log: newest first, grouped by day. No export; Clear sharing history clears it. */
@Composable
internal fun ActivityScreen(state: CompanionState, appId: String?, back: () -> Unit) {
    var filter by remember { mutableIntStateOf(0) }
    val filters = listOf("All", "Sharing changes", "Problems")
    val events = state.events.asReversed().filter { e ->
        (appId == null || e.appId == null || e.appId == appId) && when (filter) {
            1 -> ActivityText.category(e.kind) == ActivityText.Category.SHARING
            2 -> ActivityText.category(e.kind) == ActivityText.Category.PROBLEM
            else -> true
        }
    }
    val name = appId?.let { id -> state.apps.find { it.id == id }?.name }
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BackRow(if (appId == null) "Sharing" else name ?: "Back", back)
        Text(name?.let { "$it activity" } ?: "Activity", style = MaterialTheme.typography.headlineMedium)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            filters.forEachIndexed { i, label -> FilterChip(selected = filter == i, onClick = { filter = i }, label = { Text(label) }) }
        }
        if (events.isEmpty()) Text("Nothing recorded on this phone for this filter.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        events.groupBy { Format.day(it.at) }.forEach { (day, rows) ->
            Text(day, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            rows.forEach { event ->
                val problem = ActivityText.category(event.kind) == ActivityText.Category.PROBLEM
                Row(verticalAlignment = Alignment.Top) {
                    Box(Modifier.padding(top = 6.dp).size(8.dp).background(if (problem) Orange else MaterialTheme.colorScheme.primary, CircleShape))
                    Spacer(Modifier.width(12.dp))
                    Text(ActivityText.sentence(event, state.apps.find { it.id == event.appId }?.name), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text(Format.time(event.at), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
internal fun BackRow(label: String, back: () -> Unit) {
    TextButton(onClick = back, contentPadding = PaddingValues(0.dp)) { Text("‹ $label") }
}
