package online.proappstore.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*

data class CompanionState(
    val signedIn: Boolean = false, val name: String = "", val apps: List<ConnectedApp> = emptyList(),
    val blocked: Set<String> = emptySet(), val paused: Boolean = true, val running: Boolean = false,
    val permissions: Boolean = false, val queued: Int = 0, val message: String = "", val busy: Boolean = false,
    val pairingCode: String = "", val lastSync: Long = 0,
)

class MainActivity : ComponentActivity() {
    private val graph get() = application as PasApplication
    private var state by mutableStateOf(CompanionState())
    private var error by mutableStateOf("")
    private var working by mutableStateOf(false)
    private var permissionExplanation by mutableStateOf(false)
    private var refreshJob: Job? = null
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh(); maybeStart() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        setContent {
            val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFC4B5FD)) else lightColorScheme(primary = Color(0xFF6D28D9))
            MaterialTheme(colorScheme = colors) {
                PasScreen(state.copy(busy = working, message = error.ifBlank { state.message }),
                    connect = { act { open(graph.repository.startSignIn()) } },
                    enable = { app -> act { graph.repository.enable(app); refresh(); if (LocationService.allowed(this@MainActivity)) maybeStart() else permissionExplanation = true } },
                    disable = { app -> act { graph.repository.disable(app) } },
                    pause = { graph.local.paused = true; stopService(Intent(this, LocationService::class.java)); refresh() },
                    resume = { graph.local.paused = false; refresh(); if (LocationService.allowed(this)) maybeStart() else permissionExplanation = true },
                    permissions = { permissionExplanation = true },
                    sync = { act { graph.repository.sync() } },
                    disconnect = { act { graph.local.paused = true; stopService(Intent(this@MainActivity, LocationService::class.java)); graph.repository.disconnect() } },
                    privacy = { open("https://docs.proappstore.online/native-companion-users/") },
                    account = { open("https://dashboard.proappstore.online") })
                if (permissionExplanation) AlertDialog(onDismissRequest = { permissionExplanation = false },
                    title = { Text("Allow background location") },
                    text = { Text("ProAppStore collects precise location to automatically record routes for apps you enable, even when ProAppStore and those apps are closed. Updates go to PAS and only your enabled apps. Choose Precise location, then Allow all the time on the next settings screen. You can pause or revoke access here.") },
                    confirmButton = { TextButton(onClick = { permissionExplanation = false; requestLocation() }) { Text("Continue") } },
                    dismissButton = { TextButton(onClick = { permissionExplanation = false }) { Text("Not now") } })
            }
        }
    }
    override fun onResume() {
        super.onResume()
        refresh(); maybeStart()
        refreshJob?.cancel()
        refreshJob = lifecycleScope.launch {
            try { graph.repository.finishSignIn(); if (graph.repository.token() != null) graph.repository.sync() }
            catch (e: Exception) { if (e !is CancellationException) error = e.message ?: "Could not connect." else throw e }
            refresh(); maybeStart()
            while (isActive) { delay(2_000); refresh() }
        }
    }
    override fun onPause() { refreshJob?.cancel(); super.onPause() }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) /* Links only bring settings forward. No automatic permission changes. */ }
    private fun refresh() {
        state = CompanionState(graph.repository.token() != null, graph.local.userName, graph.local.apps(), graph.local.blocked(),
            graph.local.paused, LocationService.running, LocationService.allowed(this), graph.local.count(), graph.local.message,
            pairingCode = graph.repository.pairingCode(), lastSync = graph.local.lastSync)
    }
    private fun act(action: suspend () -> Unit) {
        if (working) return
        working = true; error = ""
        lifecycleScope.launch {
            try { action() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.message ?: "Please try again." }
            finally { working = false; refresh() }
        }
    }
    private fun maybeStart() {
        if (graph.repository.token() == null || graph.local.paused || !LocationService.allowed(this) ||
            LocationPolicy.recipients(graph.local.apps(), graph.local.blocked(), System.currentTimeMillis()).isEmpty()) return
        val prompt = getSharedPreferences("native-permission-prompts", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !prompt.getBoolean("notifications", false)) {
            prompt.edit().putBoolean("notifications", true).apply()
            permissionRequest.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        }
        try { LocationService.start(this) } catch (_: RuntimeException) { error = "Android could not start location sharing. Open ProAppStore and try again." }
    }
    private fun requestLocation() {
        when {
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED ->
                permissionRequest.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            Build.VERSION.SDK_INT == 29 && !LocationService.allowed(this) -> permissionRequest.launch(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
            !LocationService.allowed(this) -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
                permissionRequest.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            else -> maybeStart()
        }
    }
    private fun open(url: String) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

@Composable
internal fun PasScreen(
    state: CompanionState, connect: () -> Unit, enable: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit,
    pause: () -> Unit, resume: () -> Unit, permissions: () -> Unit, sync: () -> Unit, disconnect: () -> Unit,
    privacy: () -> Unit, account: () -> Unit,
) {
    var consent by remember { mutableStateOf<ConnectedApp?>(null) }
    var disconnectPrompt by remember { mutableStateOf(false) }
    Scaffold { padding ->
        Column(Modifier.padding(padding).padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Spacer(Modifier.height(8.dp))
            Text("ProAppStore", style = MaterialTheme.typography.headlineLarge)
            Text("Your apps, connected to your phone", style = MaterialTheme.typography.bodyLarge)
            if (!state.signedIn) {
                Text("Enable background features for the PAS apps you use. You stay in control of what each app can access.")
                Button(onClick = connect, enabled = !state.busy) { Text("Sign in to ProAppStore") }
                if (state.pairingCode.isNotBlank()) Text("Match this code in your browser: ${state.pairingCode}")
            } else {
                Text(state.name, style = MaterialTheme.typography.titleMedium)
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(when { state.paused -> "Location paused"; !state.permissions -> "Location permission needed"; state.running -> "Location sharing is on"; else -> "Location is not running" }, style = MaterialTheme.typography.titleLarge)
                        if (!state.permissions) Button(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
                        else if (state.paused) Button(onClick = resume, enabled = !state.busy && state.apps.any { it.grantId != null && it.id !in state.blocked }) { Text("Resume location") }
                        else OutlinedButton(onClick = pause) { Text("Pause all") }
                        Text("${state.queued} updates waiting to sync", style = MaterialTheme.typography.bodyMedium)
                        if (state.lastSync > 0) Text("Last sync: ${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(state.lastSync))}", style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = sync, enabled = !state.busy) { Text("Sync now") }
                    }
                }
                Text("App permissions", style = MaterialTheme.typography.titleLarge)
                if (state.apps.isEmpty()) Text("No supported native features are available for your apps yet.")
                state.apps.forEach { app ->
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(app.name, style = MaterialTheme.typography.titleMedium)
                            Text("Background location", style = MaterialTheme.typography.bodyMedium)
                            val enabled = app.grantId != null && app.id !in state.blocked
                            Text(if (enabled) "Enabled" else "Off", color = MaterialTheme.colorScheme.primary)
                            if (app.id in state.blocked) Text("Disabled on this phone. Server revocation will finish when connected.", style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = { if (enabled) disable(app) else consent = app }, enabled = !state.busy) { Text(if (enabled) "Disable" else "Enable") }
                        }
                    }
                }
                TextButton(onClick = account) { Text("Manage account") }
                TextButton(onClick = { disconnectPrompt = true }, enabled = !state.busy) { Text("Disconnect this phone") }
            }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.message.isNotBlank()) Text(state.message, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = privacy) { Text("How your data is used") }
            Spacer(Modifier.height(24.dp))
        }
    }
    consent?.let { app -> AlertDialog(onDismissRequest = { consent = null },
        title = { Text("Enable location for ${app.name}?") },
        text = { Text(app.disclosure) },
        confirmButton = { TextButton(onClick = { consent = null; enable(app) }) { Text("Enable for ${app.name}") } },
        dismissButton = { TextButton(onClick = { consent = null }) { Text("Cancel") } }) }
    if (disconnectPrompt) AlertDialog(onDismissRequest = { disconnectPrompt = false },
        title = { Text("Disconnect this phone?") },
        text = { Text("Stops location sharing and deletes this phone’s pending updates and platform location copies. Saved rides in your apps are separate. An internet connection is needed to finish.") },
        confirmButton = { TextButton(onClick = { disconnectPrompt = false; disconnect() }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { disconnectPrompt = false }) { Text("Cancel") } })
}
