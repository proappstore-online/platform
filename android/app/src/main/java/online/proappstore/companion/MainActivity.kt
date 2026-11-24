package online.proappstore.companion

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelUuid
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*

data class CompanionState(
    val signedIn: Boolean = false, val name: String = "", val apps: List<ConnectedApp> = emptyList(),
    val blocked: Set<String> = emptySet(), val paused: Boolean = true, val running: Boolean = false,
    val permissions: Boolean = false, val queued: Int = 0, val message: String = "", val busy: Boolean = false,
    val pairingCode: String = "", val lastSync: Long = 0, val pausedApps: Set<String> = emptySet(),
    // Sharing control room (#622), history (#621) and activity log (#624).
    val now: Long = System.currentTimeMillis(), val events: List<ShareEvent> = emptyList(),
    val pendingByApp: Map<String, Int> = emptyMap(), val lastUploadByApp: Map<String, Long> = emptyMap(),
    val lastSyncAttempt: Long = 0, val lastSyncError: String = "", val online: Boolean = true,
    /** `denied`, `approximate`, `whenInUse` or `always` (LocationService.permissionState). */
    val permission: String = "", val locationOn: Boolean = true, val powerSave: Boolean = false, val batteryOptimized: Boolean = false,
    val lastFix: LiveFix? = null, val version: String = "",
    /** The device connection expired or was revoked (#652); [expiresInDays] is set only in its last 7 days. */
    val expired: Boolean = false, val expiresInDays: Int? = null,
    // Run's strap heart rate (#634).
    val entries: List<NativeEntry> = emptyList(), val heartRateQueued: Int = 0, val heartRateLastUpload: Long = 0,
    val heartRateSyncError: String = "", val lastHeartRateByApp: Map<String, HeartRatePoint> = emptyMap(),
    val heartRateSensor: Boolean = false, val heartRateConnected: Boolean = false, val heartRateBpm: Int? = null,
    /** `on`, `off` or `unauthorized` (Bluetooth.state). */
    val bluetooth: String = "on",
)

/** A sensor seen by the "Choose sensor" scan. Its address stays on this phone. */
data class Sensor(val address: String, val name: String)

enum class Tab(val label: String, val icon: Int) {
    STORE("Store", R.drawable.ic_store), SHARING("Sharing", R.drawable.ic_location), SETTINGS("Settings", R.drawable.ic_settings)
}

class MainActivity : ComponentActivity() {
    private val graph get() = application as PasApplication
    private var state by mutableStateOf(CompanionState())
    private var error by mutableStateOf("")
    private var working by mutableStateOf(false)
    private var permissionExplanation by mutableStateOf(false)
    private var refreshJob: Job? = null
    /** The "Choose sensor" dialog is open (#634). It survives the permission prompt's onPause (#673). */
    private var choosing by mutableStateOf(false)
    /** The radio is scanning: only while [choosing] and resumed, so no path leaks a scan (#673). */
    private var scanning = false
    private var sensors by mutableStateOf(emptyList<Sensor>())
    // onResume, which follows the prompt, starts the scan.
    private val bluetoothRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh() }
    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission") // a scan result implies the scan permission
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val name = result.scanRecord?.deviceName ?: (if (Bluetooth.permitted(this@MainActivity)) result.device.name else null) ?: "Heart-rate sensor"
            if (sensors.none { it.address == result.device.address }) sensors = sensors + Sensor(result.device.address, name)
        }
        // Android refuses more than 5 scan starts in 30 s; without this the dialog says "Looking" forever.
        override fun onScanFailed(errorCode: Int) { error = "Could not search for sensors. Try again."; stopScanning() }
    }
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh(); maybeStart() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        // Upgrade path: sessions for grants held before the history existed start at their consent time.
        if (graph.repository.token() != null) runCatching { graph.local.seedIfEmpty() }
        refresh()
        // Sharing when any app has a grant or the connection expired, otherwise the Store.
        val initialTab = if (state.expired || state.apps.any { it.grantId != null }) Tab.SHARING else Tab.STORE
        setContent {
            val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFC4B5FD)) else lightColorScheme(primary = Color(0xFF6D28D9))
            val catalogue by graph.catalogue.state.collectAsState()
            MaterialTheme(colorScheme = colors) {
                PasScreen(state.copy(busy = working, message = error.ifBlank { state.message }),
                    connect = { act { open(graph.repository.startSignIn()) } },
                    enable = { app -> act { graph.repository.enable(app); refresh(); if (LocationService.allowed(this@MainActivity)) maybeStart() else permissionExplanation = true } },
                    disable = { app -> act { graph.repository.disable(app) } },
                    // Local writes, not `act`: pausing works offline and instantly.
                    pauseApp = { app -> graph.local.pause(app.id); reconcile(); refresh() },
                    resumeApp = { app -> graph.local.resume(app.id); refresh(); reconcile() },
                    pause = { graph.local.paused = true; stopService(Intent(this, LocationService::class.java)); refresh() },
                    resume = { graph.local.paused = false; refresh(); if (LocationService.allowed(this)) maybeStart() else permissionExplanation = true },
                    permissions = { permissionExplanation = true },
                    sync = { act { graph.repository.sync() } },
                    disconnect = { act { graph.local.paused = true; stopService(Intent(this@MainActivity, LocationService::class.java)); graph.repository.disconnect() } },
                    privacy = { open("https://docs.proappstore.online/native-companion-users/") },
                    account = { open("https://dashboard.proappstore.online") },
                    // #628: the host shows an Install button on ?install=1. Built from the id; a renamed app redirects with the query.
                    openApp = { app -> open("https://${app.id}.proappstore.online/?install=1") },
                    initialTab = initialTab,
                    store = StoreHooks(catalogue, graph.images, refresh = { refreshCatalogue() }, open = { open(it.openUrl) }, openUrl = { open(it) }),
                    clearHistory = { runCatching { graph.local.clearHistory() }.onFailure { error = it.message ?: "Could not clear history." }; refresh() },
                    loadTracks = { ids, range -> withContext(Dispatchers.IO) { ids.associateWith { graph.local.track(it, range.first, range.last) } } },
                    // Pairs again keeping the history (#652): after an expiry, or early from the expiry note.
                    reconnect = { act { graph.repository.renew(); stopService(Intent(this@MainActivity, LocationService::class.java)); open(graph.repository.startSignIn()) } },
                    heartRate = HeartRateHooks(
                        enable = { entry -> act { graph.repository.enable(entry); refresh(); reconcile() } },
                        // Local block first (offline-safe, idempotent), so the service drops heart rate now; then the server revoke.
                        disable = { entry -> graph.local.block(entry.key); reconcile(); act { graph.repository.disable(entry) } },
                        chooseSensor = { choosing = true; sensors = emptyList(); if (Bluetooth.canScan(this)) startScan() else bluetoothRequest.launch(Bluetooth.scanPermissions()) },
                        forgetSensor = { graph.local.heartRateSensor = null; runCatching { graph.local.record(ShareEvent.Kind.HEART_RATE, detail = "forgotten") }; reconcile(); refresh() },
                        load = { appId, range -> withContext(Dispatchers.IO) { graph.local.heartRate(appId, range.first, range.last) } }))
                if (choosing) AlertDialog(onDismissRequest = { closeSensors() },
                    title = { Text("Choose sensor") },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (sensors.isEmpty()) Text(if (Bluetooth.canScan(this@MainActivity)) "Looking for heart-rate sensors. Put your strap on so it wakes up." else "Allow Bluetooth to find your sensor.")
                            sensors.forEach { sensor -> TextButton(onClick = { choose(sensor) }) { Text(sensor.name) } }
                            Text("Only standard Bluetooth heart-rate sensors are listed. The sensor's name and address stay on this phone.", style = MaterialTheme.typography.bodySmall)
                        }
                    },
                    confirmButton = { TextButton(onClick = { closeSensors() }) { Text("Cancel") } })
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
        if (choosing) startScan() // also after the Nearby devices prompt (#673)
        refreshCatalogue() // foreground only: never from location callbacks
        refreshJob?.cancel()
        refreshJob = lifecycleScope.launch {
            try { graph.repository.finishSignIn(); if (graph.repository.token() != null) graph.repository.sync() }
            catch (e: Exception) { if (e is CancellationException) throw e; if (!DeviceConnection.expired(e)) error = e.message ?: "Could not connect." }
            refresh(); maybeStart()
            while (isActive) { delay(2_000); refresh() }
        }
    }
    // The radio only: the dialog stays open behind a permission prompt (#673).
    override fun onPause() { refreshJob?.cancel(); stopScanning(); super.onPause() }
    @SuppressLint("MissingPermission") // canScan checked
    private fun startScan() {
        if (scanning || !choosing || !Bluetooth.canScan(this)) return
        val scanner = getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner ?: run { error = "Turn on Bluetooth to find your sensor."; return }
        scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid.fromString(HeartRate.SERVICE)).build()),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
        scanning = true
    }
    /** Stops a running scan whatever [choosing] says; runCatching absorbs the SecurityException of a since-revoked permission. */
    @SuppressLint("MissingPermission")
    private fun stopScanning() {
        if (scanning) runCatching { getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
        scanning = false
    }
    private fun closeSensors() { choosing = false; stopScanning() }
    private fun choose(sensor: Sensor) {
        closeSensors()
        graph.local.heartRateSensor = sensor.address
        runCatching { graph.local.record(ShareEvent.Kind.HEART_RATE, detail = "sensor_chosen") }
        refresh(); reconcile()
    }
    /** Starts the one collector service when it has something to run, else stops it; a running one re-applies its types. */
    private fun reconcile() {
        if (LocationService.wanted(this, graph.repository)) maybeStart() else stopService(Intent(this, LocationService::class.java))
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) /* Links only bring settings forward. No automatic permission changes. */ }
    private fun refreshCatalogue() { lifecycleScope.launch { graph.catalogue.refresh() } }
    private fun refresh() {
        val local = graph.local
        LocationService.notePermission(this, local); Bluetooth.note(this, local)
        val apps = local.apps()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        val signedIn = graph.repository.token() != null
        state = CompanionState(signedIn, local.userName, apps, local.blocked(),
            local.paused, LocationService.running, LocationService.allowed(this), local.count(), local.message,
            pairingCode = graph.repository.pairingCode(), lastSync = local.lastSync, pausedApps = local.pausedApps(),
            now = System.currentTimeMillis(), events = runCatching { local.events() }.getOrDefault(emptyList()),
            pendingByApp = apps.associate { it.id to local.pendingCount(it.id) },
            lastUploadByApp = apps.mapNotNull { app -> local.lastUpload(app.id)?.let { app.id to it } }.toMap(),
            lastSyncAttempt = local.lastSyncAttempt, lastSyncError = local.lastSyncError,
            online = connectivity.getNetworkCapabilities(connectivity.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
            permission = LocationService.permissionState(this),
            locationOn = getSystemService(LocationManager::class.java).isLocationEnabled,
            powerSave = power.isPowerSaveMode, batteryOptimized = !power.isIgnoringBatteryOptimizations(packageName),
            lastFix = LocationService.lastFix,
            version = packageManager.getPackageInfo(packageName, 0).let { "${it.versionName} (${it.longVersionCode})" },
            expired = local.expired,
            expiresInDays = if (signedIn) DeviceConnection.expiresInDays(local.deviceExpiresAt, System.currentTimeMillis()) else null,
            entries = local.entries(), heartRateQueued = local.heartRateCount(), heartRateLastUpload = local.heartRateLastUpload,
            heartRateSyncError = local.heartRateSyncError,
            lastHeartRateByApp = local.entries().filter { it.capability == HeartRate.CAPABILITY }.mapNotNull { e -> local.lastHeartRate(e.appId)?.let { e.appId to it } }.toMap(),
            heartRateSensor = local.heartRateSensor != null, heartRateConnected = LocationService.heartRateConnected, heartRateBpm = LocationService.lastBpm,
            bluetooth = Bluetooth.state(this))
        if (state.expired && LocationService.running) stopService(Intent(this, LocationService::class.java))
    }
    private fun act(action: suspend () -> Unit) {
        if (working) return
        working = true; error = ""
        lifecycleScope.launch {
            try { action() } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (!DeviceConnection.expired(e)) error = e.message ?: "Please try again." // the expired card says it
            }
            finally { working = false; refresh() }
        }
    }
    private fun maybeStart() {
        if (!LocationService.wanted(this, graph.repository)) return
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
    private fun open(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: RuntimeException) { error = "No browser is available to open $url." }
    }
}

/** Where the user is inside the Sharing tab. */
private sealed class SharingPage {
    data object Dashboard : SharingPage()
    data object Map : SharingPage()
    data class App(val id: String) : SharingPage()
    data class Activity(val appId: String?, val from: SharingPage) : SharingPage()
}

/**
 * The tab shell: Store, Sharing and Settings. The consent and disconnect dialogs live here so they work from every tab.
 * The parameters up to `account` are the original screen's; the rest default so existing callers keep compiling.
 */
@Composable
internal fun PasScreen(
    state: CompanionState, connect: () -> Unit, enable: (ConnectedApp) -> Unit, disable: (ConnectedApp) -> Unit,
    pauseApp: (ConnectedApp) -> Unit, resumeApp: (ConnectedApp) -> Unit,
    pause: () -> Unit, resume: () -> Unit, permissions: () -> Unit, sync: () -> Unit, disconnect: () -> Unit,
    privacy: () -> Unit, account: () -> Unit,
    openApp: (ConnectedApp) -> Unit = {},
    initialTab: Tab = Tab.SHARING,
    store: StoreHooks = StoreHooks(),
    clearHistory: () -> Unit = {},
    loadTracks: suspend (List<String>, LongRange) -> Map<String, List<TrackSample>> = { _, _ -> emptyMap() },
    reconnect: () -> Unit = {},
    heartRate: HeartRateHooks = HeartRateHooks(),
) {
    var tab by remember { mutableStateOf(initialTab) }
    var sharingPage by remember { mutableStateOf<SharingPage>(SharingPage.Dashboard) }
    var storeApp by remember { mutableStateOf<CatalogueApp?>(null) }
    var consent by remember { mutableStateOf<ConnectedApp?>(null) }
    var entryConsent by remember { mutableStateOf<NativeEntry?>(null) }
    val hooks = heartRate.copy(askConsent = { entryConsent = it })
    BackHandler(enabled = (tab == Tab.SHARING && sharingPage != SharingPage.Dashboard) || (tab == Tab.STORE && storeApp != null)) {
        if (tab == Tab.STORE) storeApp = null
        else sharingPage = (sharingPage as? SharingPage.Activity)?.from ?: SharingPage.Dashboard
    }
    Scaffold(bottomBar = {
        NavigationBar {
            Tab.entries.forEach { t ->
                NavigationBarItem(selected = tab == t, onClick = { if (tab == t) { storeApp = null; sharingPage = SharingPage.Dashboard }; tab = t },
                    icon = { Icon(painterResource(t.icon), contentDescription = null) }, label = { Text(t.label) })
            }
        }
    }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                Tab.STORE -> storeApp?.let { app -> StoreAppScreen(app, state, store, connect, { consent = it }, disable) { storeApp = null } }
                    ?: StoreScreen(state, store) { storeApp = it }
                Tab.SHARING -> when (val page = sharingPage) {
                    SharingPage.Dashboard -> {
                        val granted = state.apps.filter { it.grantId != null }
                        val tracks = rememberTracks(granted, state, SharingTimeline.today(state.now), loadTracks)
                        SharingDashboard(state, tracks, connect, { consent = it }, disable, pauseApp, resumeApp, pause, resume, permissions, sync, openApp,
                            showApp = { sharingPage = SharingPage.App(it.id) }, showActivity = { sharingPage = SharingPage.Activity(null, page) },
                            showMap = { sharingPage = SharingPage.Map }, reconnect = reconnect, heartRate = hooks)
                    }
                    SharingPage.Map -> Column(Modifier.padding(horizontal = 16.dp).fillMaxSize()) {
                        BackRow("Sharing") { sharingPage = SharingPage.Dashboard }
                        Text("Today", style = MaterialTheme.typography.headlineMedium)
                        val granted = state.apps.filter { it.grantId != null }
                        TrackMap(rememberTracks(granted, state, SharingTimeline.today(state.now), loadTracks), state.liveFix(), interactive = true,
                            modifier = Modifier.fillMaxSize().padding(bottom = 8.dp))
                    }
                    is SharingPage.App -> state.apps.find { it.id == page.id }?.let { app ->
                        AppSharingScreen(state, app, loadTracks, pauseApp, resumeApp, disable, openApp,
                            showActivity = { sharingPage = SharingPage.Activity(app.id, page) }, back = { sharingPage = SharingPage.Dashboard },
                            loadHeartRate = heartRate.load)
                    } ?: LaunchedEffect(page) { sharingPage = SharingPage.Dashboard } // the app left /native/me
                    is SharingPage.Activity -> ActivityScreen(state, page.appId) { sharingPage = page.from }
                }
                Tab.SETTINGS -> SettingsScreen(state, connect, permissions, disconnect, privacy, account, clearHistory, store.openUrl, reconnect)
            }
        }
    }
    consent?.let { app -> AlertDialog(onDismissRequest = { consent = null },
        title = { Text("Enable location for ${app.name}?") },
        text = { Text(app.disclosure) },
        confirmButton = { TextButton(onClick = { consent = null; enable(app) }) { Text("Enable for ${app.name}") } },
        dismissButton = { TextButton(onClick = { consent = null }) { Text("Cancel") } }) }
    entryConsent?.let { entry -> AlertDialog(onDismissRequest = { entryConsent = null },
        title = { Text("Enable ${entry.name.lowercase()} for ${entry.appName}?") },
        text = { Text(entry.disclosure) },
        confirmButton = { TextButton(onClick = { entryConsent = null; heartRate.enable(entry) }) { Text("Enable for ${entry.appName}") } },
        dismissButton = { TextButton(onClick = { entryConsent = null }) { Text("Cancel") } }) }
}

/** Run's heart-rate actions (#634); defaults keep existing callers and previews compiling. */
data class HeartRateHooks(
    val enable: (NativeEntry) -> Unit = {}, val disable: (NativeEntry) -> Unit = {}, val askConsent: (NativeEntry) -> Unit = {},
    val chooseSensor: () -> Unit = {}, val forgetSensor: () -> Unit = {},
    val load: suspend (String, LongRange) -> List<HeartRatePoint> = { _, _ -> emptyList() },
)

/** Busy indicator and the last error, at the top of each tab. */
@Composable
internal fun StatusMessages(state: CompanionState) {
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (state.message.isNotBlank()) Text(state.message, color = MaterialTheme.colorScheme.error)
}

/** Account, permissions, history and About. */
@Composable
private fun SettingsScreen(
    state: CompanionState, connect: () -> Unit, permissions: () -> Unit, disconnect: () -> Unit, privacy: () -> Unit, account: () -> Unit,
    clearHistory: () -> Unit, openUrl: (String) -> Unit, reconnect: () -> Unit,
) {
    var disconnectPrompt by remember { mutableStateOf(false) }
    var clearPrompt by remember { mutableStateOf(false) }
    Column(Modifier.padding(horizontal = 24.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("Settings", style = MaterialTheme.typography.headlineLarge)
        StatusMessages(state)
        if (state.expired) ExpiredCard(state, reconnect)
        if (state.signedIn || state.expired) {
            Text(state.name, style = MaterialTheme.typography.titleMedium)
            state.expiresInDays?.let { days ->
                Text("Connection renews when you reconnect — expires in $days day${if (days == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = reconnect, enabled = !state.busy) { Text("Reconnect") }
            }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Labeled("Location permission", Format.permission[state.permission] ?: state.permission)
                    if (state.permission != "always") TextButton(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
                    else Text("Precise location is allowed all the time.", style = MaterialTheme.typography.bodySmall)
                }
            }
            TextButton(onClick = account) { Text("Manage account") }
            TextButton(onClick = { clearPrompt = true }) { Text("Clear sharing history") }
            TextButton(onClick = { disconnectPrompt = true }, enabled = !state.busy) { Text("Disconnect this phone") }
        } else Button(onClick = connect, enabled = !state.busy) { Text("Sign in to ProAppStore") }
        Text("About", style = MaterialTheme.typography.titleLarge)
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Labeled("Version", state.version)
                Labeled("Android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            }
        }
        TextButton(onClick = privacy) { Text("How your data is used") }
        TextButton(onClick = { openUrl("https://proappstore.online/privacy") }) { Text("Privacy policy") }
        Spacer(Modifier.height(24.dp))
    }
    if (disconnectPrompt) AlertDialog(onDismissRequest = { disconnectPrompt = false },
        title = { Text("Disconnect this phone?") },
        text = { Text("Stops location sharing and deletes this phone’s pending updates, its sharing history and platform location copies. Saved rides in your apps are separate. An internet connection is needed to finish.") },
        confirmButton = { TextButton(onClick = { disconnectPrompt = false; disconnect() }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { disconnectPrompt = false }) { Text("Cancel") } })
    if (clearPrompt) AlertDialog(onDismissRequest = { clearPrompt = false },
        title = { Text("Clear sharing history?") },
        text = { Text("Deletes the sharing map, timeline and activity kept on this phone. Updates waiting to sync still upload.") },
        confirmButton = { TextButton(onClick = { clearPrompt = false; clearHistory() }) { Text("Clear history") } },
        dismissButton = { TextButton(onClick = { clearPrompt = false }) { Text("Cancel") } })
}
