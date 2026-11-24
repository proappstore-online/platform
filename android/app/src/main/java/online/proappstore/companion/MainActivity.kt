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
import androidx.core.content.edit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class CompanionState(
    val signedIn: Boolean = false, val name: String = "", val apps: List<ConnectedApp> = emptyList(),
    val blocked: Set<String> = emptySet(), val running: Boolean = false,
    val permissions: Boolean = false, val queued: Int = 0, val message: String = "", val busy: Boolean = false,
    val pairingCode: String = "", val lastSync: Long = 0,
    /** Running collection sessions by app id (ADR-020). */
    val sessions: Map<String, Session> = emptyMap(),
    // Sharing control room (#622), history (#621) and activity log (#624).
    val now: Long = System.currentTimeMillis(), val events: List<ShareEvent> = emptyList(),
    val pendingByApp: Map<String, Int> = emptyMap(), val lastUploadByApp: Map<String, Long> = emptyMap(),
    val lastSyncAttempt: Long = 0, val lastSyncError: String = "", val online: Boolean = true,
    /** `denied`, `approximate` or `whenInUse` (LocationService.permissionState). */
    val permission: String = "", val locationOn: Boolean = true, val powerSave: Boolean = false, val batteryOptimized: Boolean = false,
    val lastFix: LiveFix? = null, val version: String = "",
    /** The device connection expired or was revoked (#652); [expiresInDays] is set only in its last 7 days. */
    val expired: Boolean = false, val expiresInDays: Int? = null,
    // Run's strap heart rate (#634).
    val entries: List<NativeEntry> = emptyList(), val heartRateQueued: Int = 0, val heartRateLastUpload: Long = 0,
    val heartRateSyncError: String = "", val lastHeartRateByApp: Map<String, HeartRatePoint> = emptyMap(),
    val heartRateSensor: Boolean = false, val heartRateConnected: Boolean = false, val heartRateBpm: Int? = null,
    /** When [heartRateBpm] was read. A strap off the chest yields no accepted reading, so an old bpm is not shown as live (#674). */
    val heartRateReadingAt: Long = 0,
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
    /** Read on IO, assigned here on Main (Compose snapshot state), in request order (#663). */
    internal var state by mutableStateOf(CompanionState())
        private set
    /** The first read has landed; the screen and its initial tab wait for it rather than show a signed-out flash. */
    private var ready by mutableStateOf(false)
    private val reads = Mutex()
    private var error by mutableStateOf("")
    private var working by mutableStateOf(false)
    private var permissionExplanation by mutableStateOf(false)
    /** The app whose Start waits for the location permission flow. */
    private var pendingStart: String? = null
    /** Around the one location request: what [PermissionDisclosure.step] needs to tell a prompt from no prompt. */
    private var rationaleBefore = false
    private var askedBefore = false
    private val prompts get() = getSharedPreferences("native-permission-prompts", MODE_PRIVATE)
    /** A `proappstore://native/apps/<appId>` link's app, until the screen has shown it (ADR-020 §2). */
    private var link by mutableStateOf<String?>(null)
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
    // Nothing follows the notification answer: the service has started, and its notification shows once allowed.
    private val notificationRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { locationAnswered() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        lifecycleScope.launch {
            // Upgrade path: sessions for grants held before the history existed start at their consent time.
            withContext(Dispatchers.IO) { if (graph.repository.token() != null) runCatching { graph.local.seedIfEmpty() } }
            reload()
        }
        link = SharingSessions.linkedApp(intent?.dataString)
        setContent {
            val colors = if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFC4B5FD)) else lightColorScheme(primary = Color(0xFF6D28D9))
            val catalogue by graph.catalogue.state.collectAsState()
            MaterialTheme(colorScheme = colors) {
                if (!ready) return@MaterialTheme
                PasScreen(state.copy(busy = working, message = error.ifBlank { state.message }),
                    connect = { act { open(graph.repository.startSignIn()) } },
                    // Enabling grants; Start on the row begins sharing (ADR-020 §2).
                    enable = { app -> act { graph.repository.enable(app); refresh(); if (!LocationService.allowed(this@MainActivity)) permissionExplanation = true } },
                    disable = { app -> act { graph.repository.disable(app) } },
                    // Local writes on IO, not `act`: Start and Stop work offline and instantly.
                    startApp = { app -> start(app) },
                    stopApp = { app -> local({ graph.local.endSession(app.id, "user") }) { reconcile() } },
                    stopAll = { local({ graph.local.endAllSessions("all") }) { stopService(Intent(this, LocationService::class.java)) } },
                    permissions = { permissionExplanation = true },
                    sync = { act { graph.repository.sync() } },
                    disconnect = { act { withContext(Dispatchers.IO) { graph.local.endAllSessions("grant") }; stopService(Intent(this@MainActivity, LocationService::class.java)); graph.repository.disconnect() } },
                    privacy = { open("https://docs.proappstore.online/native-companion-users/") },
                    account = { open("https://dashboard.proappstore.online") },
                    // #628: the host shows an Install button on ?install=1. Built from the id; a renamed app redirects with the query.
                    openApp = { app -> open("https://${app.id}.proappstore.online/?install=1") },
                    // Sharing when any app has a grant or the connection expired, otherwise the Store.
                    initialTab = if (state.expired || state.apps.any { it.grantId != null }) Tab.SHARING else Tab.STORE,
                    store = StoreHooks(catalogue, graph.images, refresh = { refreshCatalogue() }, open = { open(it.openUrl) }, openUrl = { open(it) }),
                    clearHistory = { clearHistory() },
                    loadTracks = { ids, range -> withContext(Dispatchers.IO) { ids.associateWith { graph.local.track(it, range.first, range.last) } } },
                    // Pairs again keeping the history (#652): after an expiry, or early from the expiry note.
                    reconnect = { act { graph.repository.renew(); stopService(Intent(this@MainActivity, LocationService::class.java)); open(graph.repository.startSignIn()) } },
                    link = link, linkShown = { link = null },
                    heartRate = HeartRateHooks(
                        enable = { entry -> act { graph.repository.enable(entry); refresh(); reconcile() } },
                        // Local block first (offline-safe, idempotent), so the service drops heart rate now; then the server revoke.
                        disable = { entry -> local({ graph.local.block(entry.key) }) { reconcile(); act { graph.repository.disable(entry) } } },
                        chooseSensor = { choosing = true; sensors = emptyList(); if (Bluetooth.canScan(this)) startScan() else bluetoothRequest.launch(Bluetooth.scanPermissions()) },
                        forgetSensor = { local({ graph.local.heartRateSensor = null; graph.local.record(ShareEvent.Kind.HEART_RATE, detail = "forgotten") }) { reconcile() } },
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
                // Play's prominent disclosure (#663): every location entry, before the request; "Not now" requests nothing.
                if (permissionExplanation) AlertDialog(onDismissRequest = { permissionExplanation = false; pendingStart = null },
                    title = { Text(PermissionDisclosure.TITLE) },
                    text = { Text(PermissionDisclosure.body(state.apps), Modifier.verticalScroll(rememberScrollState())) },
                    confirmButton = { TextButton(onClick = { permissionExplanation = false; requestLocation() }) { Text("Continue") } },
                    dismissButton = { TextButton(onClick = { permissionExplanation = false; pendingStart = null }) { Text("Not now") } })
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
            // Both on IO; sync() returns at once without a credential.
            try { graph.repository.finishSignIn(); graph.repository.sync() }
            catch (e: Exception) { if (e is CancellationException) throw e; if (!DeviceConnection.expired(e)) error = e.message ?: "Could not connect." }
            reload(); maybeStart()
            while (isActive) { delay(2_000); reload() }
        }
    }
    // The radio only: the dialog stays open behind a permission prompt (#673).
    override fun onPause() { refreshJob?.cancel(); stopScanning(); super.onPause() }
    @SuppressLint("MissingPermission") // canScan checked
    private fun startScan() {
        if (scanning || !choosing || !Bluetooth.canScan(this)) return
        val scanner = getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeScanner ?: run { error = "Turn on Bluetooth to find your sensor."; return }
        scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(HeartRate.SERVICE)).build()),
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
        local({ graph.local.heartRateSensor = sensor.address; graph.local.record(ShareEvent.Kind.HEART_RATE, detail = "sensor_chosen") }) { reconcile() }
    }
    /** Starts the one collector service when it has something to run, else stops it; a running one re-applies its types. */
    private fun reconcile() {
        lifecycleScope.launch {
            if (withContext(Dispatchers.IO) { LocationService.wanted(this@MainActivity, graph.repository) }) maybeStart()
            else stopService(Intent(this@MainActivity, LocationService::class.java))
        }
    }
    /**
     * A local write on IO (#663): it waits for the store's lock, which an upload or a revocation can hold. Then `then` on
     * Main, and a refresh. Offline-capable: never through `act`.
     */
    private fun local(write: () -> Unit, then: () -> Unit = {}) {
        lifecycleScope.launch {
            withContext(Dispatchers.IO) { runCatching(write) }.onFailure { error = it.message ?: "Could not save on this phone." }
            then(); reload()
        }
    }
    /** Clear sharing history: up to 200,000 rows, deleted on IO (#663). */
    internal fun clearHistory() = local({ graph.local.clearHistory() })
    /** A link only selects an app: it never grants, changes a permission or starts a session (ADR-020 §2). */
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); link = SharingSessions.linkedApp(intent.dataString) }
    private fun refreshCatalogue() { lifecycleScope.launch { graph.catalogue.refresh() } }
    /** Reads the state on IO and assigns it on Main (#663): the store's lock and the Keystore never block the UI. */
    internal fun refresh() { lifecycleScope.launch { reload() } }
    private suspend fun reload() = reads.withLock {
        val next = withContext(Dispatchers.IO) { read() }
        state = next; ready = true
        if (next.expired && LocationService.running) stopService(Intent(this, LocationService::class.java))
    }
    /** Every storage, Keystore and system read behind [state]. IO only. */
    private fun read(): CompanionState {
        val local = graph.local
        LocationService.notePermission(this, local); Bluetooth.note(this, local)
        val apps = local.apps()
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        val signedIn = graph.repository.token() != null
        return CompanionState(signedIn, local.userName, apps, local.blocked(),
            LocationService.running, LocationService.allowed(this), local.count(), local.message,
            pairingCode = graph.repository.pairingCode(), lastSync = local.lastSync, sessions = local.sessions().associateBy { it.appId },
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
            heartRateReadingAt = LocationService.lastReadingAt,
            bluetooth = Bluetooth.state(this))
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
    /**
     * Start on an app's row or in a link's prompt (ADR-020 §2): needs a current grant, precise permission (the disclosure
     * and permission flow first, which then continues here, #663) and location turned on.
     */
    private fun start(app: ConnectedApp) {
        if (state.expired || app.grantId == null || app.id in state.blocked) return
        if (!LocationService.allowed(this)) { pendingStart = app.id; permissionExplanation = true; return }
        if (!getSystemService(LocationManager::class.java).isLocationEnabled) { error = "Turn on location in Android settings, then tap Start."; return }
        lifecycleScope.launch {
            val started = withContext(Dispatchers.IO) { runCatching { graph.local.startSession(app.id) }.isSuccess }
            if (!started) { error = "Could not start sharing on this phone."; return@launch }
            reload(); maybeStart()
        }
    }
    /**
     * Starts the collector only for sessions that already exist; it never creates one (ADR-020 §7). After the OS stopped
     * it, sessions past 12 hours end and the rest resume with the stationary clock restarted. Precise permission withdrawn
     * ends them. The store and the credential are read on IO; the service starts only while the activity is visible.
     */
    private fun maybeStart() {
        lifecycleScope.launch {
            val allowed = LocationService.allowed(this@MainActivity)
            val wanted = withContext(Dispatchers.IO) {
                runCatching {
                    if (!LocationService.active) graph.local.resumeSessions()
                    if (!allowed) graph.local.endAllSessions("permission")
                }
                LocationService.wanted(this@MainActivity, graph.repository)
            }
            if (!wanted || !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@launch
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !prompts.getBoolean("notifications", false)) {
                prompts.edit().putBoolean("notifications", true).apply()
                notificationRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            try { LocationService.start(this@MainActivity) } catch (_: RuntimeException) { error = "Android could not start location sharing. Open ProAppStore and try again." }
        }
    }
    /** The disclosure's Continue: one foreground, precise request, with no background step (ADR-020 §8). */
    private fun requestLocation() {
        if (LocationService.allowed(this)) { locationAnswered(); return } // allowed meanwhile in Android settings
        rationaleBefore = shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
        askedBefore = prompts.getBoolean("location", false)
        prompts.edit { putBoolean("location", true) }
        permissionRequest.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }
    /** The one step after the request (#663): precise continues the pending Start. Nothing here requests again, so a denial never loops. */
    private fun locationAnswered() {
        val app = pendingStart?.let { id -> state.apps.find { it.id == id } }
        pendingStart = null
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        when (PermissionDisclosure.step(LocationService.allowed(this), coarse, rationaleBefore,
            shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION), askedBefore)) {
            PermissionDisclosure.Step.CONTINUE -> app?.let(::start)
            PermissionDisclosure.Step.STOP -> Unit
            PermissionDisclosure.Step.APPROXIMATE -> error = PermissionDisclosure.APPROXIMATE
            PermissionDisclosure.Step.SETTINGS -> {
                error = PermissionDisclosure.SETTINGS
                try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) }
                catch (_: RuntimeException) { }
            }
        }
        rationaleBefore = false; askedBefore = false
        refresh()
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
    startApp: (ConnectedApp) -> Unit, stopApp: (ConnectedApp) -> Unit,
    stopAll: () -> Unit, permissions: () -> Unit, sync: () -> Unit, disconnect: () -> Unit,
    privacy: () -> Unit, account: () -> Unit,
    openApp: (ConnectedApp) -> Unit = {},
    initialTab: Tab = Tab.SHARING,
    store: StoreHooks = StoreHooks(),
    clearHistory: () -> Unit = {},
    loadTracks: suspend (List<String>, LongRange) -> Map<String, List<TrackSample>> = { _, _ -> emptyMap() },
    reconnect: () -> Unit = {},
    /** A `proappstore://native/apps/<appId>` link's app; [linkShown] clears it once shown. */
    link: String? = null, linkShown: () -> Unit = {},
    heartRate: HeartRateHooks = HeartRateHooks(),
) {
    var tab by remember { mutableStateOf(initialTab) }
    var sharingPage by remember { mutableStateOf<SharingPage>(SharingPage.Dashboard) }
    var storeApp by remember { mutableStateOf<CatalogueApp?>(null) }
    var consent by remember { mutableStateOf<ConnectedApp?>(null) }
    var entryConsent by remember { mutableStateOf<NativeEntry?>(null) }
    var startPrompt by remember { mutableStateOf<ConnectedApp?>(null) }
    val hooks = heartRate.copy(askConsent = { entryConsent = it })
    // ADR-020 §2: a link brings an app forward and never starts anything. Not granted: its consent. Granted: the Start
    // prompt. Sharing: its page. Unknown: the dashboard.
    LaunchedEffect(link) {
        val id = link ?: return@LaunchedEffect
        linkShown()
        tab = Tab.SHARING; sharingPage = SharingPage.Dashboard
        val app = state.apps.find { it.id == id }?.takeIf { state.signedIn && !state.expired } ?: return@LaunchedEffect
        when {
            !state.enabled(app) -> consent = app
            app.id in state.sessions -> sharingPage = SharingPage.App(app.id)
            else -> startPrompt = app
        }
    }
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
                        SharingDashboard(state, tracks, connect, { consent = it }, disable, startApp, stopApp, stopAll, permissions, sync, openApp,
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
                        AppSharingScreen(state, app, loadTracks, startApp, stopApp, disable, openApp,
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
    startPrompt?.let { app -> AlertDialog(onDismissRequest = { startPrompt = null },
        title = { Text("Start sharing with ${app.name}?") },
        text = { Text("ProAppStore will share your location with ${app.name} while you record, including with your phone locked. It stops when you tap Stop, after 30 minutes without moving, or after 12 hours.") },
        confirmButton = { TextButton(onClick = { startPrompt = null; startApp(app) }) { Text("Start") } },
        dismissButton = { TextButton(onClick = { startPrompt = null }) { Text("Not now") } }) }
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

/** Account deletion is requested on the web (#662). */
private const val DELETE_ACCOUNT = "https://proappstore.online/privacy#data-deletion"

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
                    if (state.permission != "whenInUse") TextButton(onClick = permissions, enabled = !state.busy) { Text("Set up location") }
                    else Text("Precise location is allowed. Sharing runs only while you have started it for an app.", style = MaterialTheme.typography.bodySmall)
                }
            }
            TextButton(onClick = account) { Text("Manage account") }
            TextButton(onClick = { openUrl(DELETE_ACCOUNT) }) { Text("Delete account") }
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
        // Reachable signed out too (Play's account-deletion rule, #663). The page explains; there is no deletion API yet (#662).
        TextButton(onClick = { openUrl(DELETE_ACCOUNT) }) { Text("Delete account") }
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
