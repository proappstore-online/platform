package online.proappstore.companion

import android.text.format.DateFormat
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.util.Date
import java.util.Locale

/** One app row's state chip. Pure, so every combination is table-tested. Ported from iOS SharingDashboardView.swift. */
enum class SharingState(val label: String) {
    SHARING("Sharing"), PAUSED("Paused"), PAUSED_ALL("Paused (all)"), OFF("Off"), TURNING_OFF("Turning off…"), NOT_RECORDING("Not recording");

    companion object {
        /** `blocked` with a grant still held means the server `DELETE` has not gone through yet. */
        fun of(granted: Boolean, blocked: Boolean, appPaused: Boolean, pausedAll: Boolean, running: Boolean): SharingState = when {
            blocked -> if (granted) TURNING_OFF else OFF
            !granted -> OFF
            pausedAll -> PAUSED_ALL
            appPaused -> PAUSED
            running -> SHARING
            else -> NOT_RECORDING
        }
    }
}

internal val Orange = Color(0xFFEA580C)
@Composable internal fun SharingState.color(): Color = when (this) {
    SharingState.SHARING -> Color(0xFF16A34A)
    SharingState.PAUSED, SharingState.PAUSED_ALL, SharingState.TURNING_OFF -> Orange
    SharingState.OFF -> MaterialTheme.colorScheme.onSurfaceVariant
    SharingState.NOT_RECORDING -> MaterialTheme.colorScheme.error
}

internal fun CompanionState.enabled(app: ConnectedApp) = app.grantId != null && app.id !in blocked
internal fun CompanionState.sharing(app: ConnectedApp) = enabled(app) && app.id !in pausedApps && !paused
internal fun CompanionState.stateOf(app: ConnectedApp) =
    SharingState.of(app.grantId != null, app.id in blocked, app.id in pausedApps, paused, running)
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
        is InactiveCause.System -> "stopped: " + (mapOf("signed_out" to "signed out", "storage_failed" to "storage", "unlock_failed" to "unlock")[cause.detail] ?: cause.detail)
    }
    fun end(kind: ShareEvent.Kind): String = when (kind) {
        ShareEvent.Kind.DISABLED -> "turned off"
        ShareEvent.Kind.GRANT_LOST -> "revoked by ProAppStore"
        ShareEvent.Kind.HISTORY_CLEARED -> "history cleared"
        else -> kind.raw
    }
    val permission = mapOf("" to "Not set", "denied" to "Not allowed", "approximate" to "Approximate only", "whenInUse" to "While using the app", "always" to "All the time")
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
    pauseApp: (ConnectedApp) -> Unit, resumeApp: (ConnectedApp) -> Unit, pause: () -> Unit, resume: () -> Unit,
    permissions: () -> Unit, sync: () -> Unit, openApp: (ConnectedApp) -> Unit,
    showApp: (ConnectedApp) -> Unit, showActivity: () -> Unit, showMap: () -> Unit,
) {
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Sharing", style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f))
            if (state.signedIn) TextButton(onClick = showActivity) { Text("Activity") }
        }
        StatusMessages(state)
        if (!state.signedIn) {
            Text("Your apps, connected to your phone", style = MaterialTheme.typography.titleMedium)
            Text("Enable background features for the PAS apps you use. You stay in control of what each app can access.")
            Button(onClick = connect, enabled = !state.busy) { Text("Sign in to ProAppStore") }
            if (state.pairingCode.isNotBlank()) Text("Match this code in your browser: ${state.pairingCode}")
        } else {
            val granted = state.apps.filter { it.grantId != null }
            val available = state.apps.filter { it.grantId == null && it.id !in state.blocked }
            if (granted.isNotEmpty()) Overview(state, granted, tracks, showMap)
            Header(state, pause, resume, permissions, sync)
            if (state.apps.isEmpty()) Text("No supported native features are available for your apps yet.")
            granted.forEach { AppRow(state, it, disable, pauseApp, resumeApp, openApp, showApp) }
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
                        }
                    }
                }
            }
            DeviceCard(state, permissions)
        }
        Spacer(Modifier.height(24.dp))
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
private fun Header(state: CompanionState, pause: () -> Unit, resume: () -> Unit, permissions: () -> Unit, sync: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val enabledApps = state.apps.filter { state.enabled(it) }
            Text(when {
                state.paused -> "Location paused"
                enabledApps.isNotEmpty() && enabledApps.all { it.id in state.pausedApps } -> "All apps paused"
                !state.permissions -> "Location permission needed"
                state.running -> "Location sharing is on"
                else -> "Location is not running"
            }, style = MaterialTheme.typography.titleLarge)
            if (!state.permissions) Button(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
            else if (state.paused) Button(onClick = resume, enabled = !state.busy && enabledApps.isNotEmpty()) { Text("Resume all") }
            else OutlinedButton(onClick = pause) { Text("Pause all") }
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
    state: CompanionState, app: ConnectedApp, disable: (ConnectedApp) -> Unit, pauseApp: (ConnectedApp) -> Unit,
    resumeApp: (ConnectedApp) -> Unit, openApp: (ConnectedApp) -> Unit, showApp: (ConnectedApp) -> Unit,
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (state.enabled(app)) {
                    if (app.id in state.pausedApps) Button(onClick = { resumeApp(app) }, enabled = !state.paused) { Text("Resume") }
                    else OutlinedButton(onClick = { pauseApp(app) }) { Text("Pause") }
                }
                TextButton(onClick = { openApp(app) }) { Text("Open ${app.name}") }
                Spacer(Modifier.weight(1f))
                // Not a one-tap button beside Pause: turning off deletes the app's platform copy.
                if (state.enabled(app)) TurnOffMenu(app, state.busy, disable)
            }
            if (state.paused && state.enabled(app) && app.id in state.pausedApps) Text("All sharing is paused. Resume all to continue.", style = MaterialTheme.typography.bodySmall)
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
            if (state.permission != "always") {
                Text("Recording with the screen off needs precise location, allowed all the time.", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
            }
            Labeled("Location services", if (state.locationOn) "On" else "Off")
            if (!state.locationOn) Text("Turn on location in Android settings to record.", style = MaterialTheme.typography.bodySmall, color = Orange)
            Labeled("Battery Saver", if (state.powerSave) "On" else "Off")
            if (state.powerSave) Text("Android may deliver fewer location updates.", style = MaterialTheme.typography.bodySmall, color = Orange)
            Labeled("Battery use", if (state.batteryOptimized) "Optimized" else "Unrestricted")
            // Only matters for recording in the background, which needs "All the time".
            if (state.batteryOptimized && state.permission == "always") Text("Android may stop recording in the background. Set ProAppStore's battery use to Unrestricted in Android settings.", style = MaterialTheme.typography.bodySmall, color = Orange)
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
    pauseApp: (ConnectedApp) -> Unit, resumeApp: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit, openApp: (ConnectedApp) -> Unit,
    showActivity: () -> Unit, back: () -> Unit,
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
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val chip = state.stateOf(app)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(chip.label, style = MaterialTheme.typography.titleMedium, color = chip.color(), modifier = Modifier.weight(1f))
                    if (state.enabled(app)) {
                        if (app.id in state.pausedApps) Button(onClick = { resumeApp(app) }, enabled = !state.paused) { Text("Resume") }
                        else OutlinedButton(onClick = { pauseApp(app) }) { Text("Pause") }
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
