package online.proappstore.companion

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The Play listing's phone screenshots (#665 item 4): [PasScreen] rendered from fixture state, so no image shows a real
 * place, name or email. The route is synthetic, a closed loop drawn around 0°, 0°. captureToImage() captures the app's
 * window only, so the system's ongoing notification cannot appear; the dashboard shows the running session instead.
 * Run by hand on a 1080×2400 emulator, never in CI and never on a personal phone (the run installs over the companion).
 * From `android/`:
 *
 * ```
 * export ANDROID_SERIAL=emulator-5554   # check `adb devices` first
 * ./gradlew :app:installDebug :app:installDebugAndroidTest
 * adb shell am instrument -w -e class online.proappstore.companion.PlayScreenshots online.proappstore.app.test/androidx.test.runner.AndroidJUnitRunner
 * adb pull /sdcard/Android/data/online.proappstore.app/files/play-screenshots/. play/screenshots/
 * ```
 */
class PlayScreenshots {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    // 10:42 today: Run's session started at 10:00, so it reads "Sharing for 42 min".
    private val now = LocalDate.now().atTime(10, 42).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
    private val minute = 60_000L
    private val day = 24 * 60 * minute
    private val sessionStart = now - 42 * minute

    private val ski = ConnectedApp("ski", "Ski", "Automatically record your routes for Ski, including when Ski is closed.",
        "Ski receives your precise location during a session you start, including with your phone locked and Ski closed. You can stop or turn this off here at any time.", "1", "ski-grant", now - 30 * day)
    private val run = ConnectedApp("run", "Run", "Keep recording your runs and walks while your phone is locked or Run is closed.",
        "Run receives your precise location during a session you start, including with your phone locked and Run closed. You can stop or turn this off here at any time.", "1", "run-grant", sessionStart - minute)
    private val rideshare = ConnectedApp("rideshare", "Rideshare", "Keep dispatch and your rider seeing where you are while you drive, including when your phone is locked or Rideshare is closed.",
        "Rideshare receives your precise location during a session you start, including with your phone locked and Rideshare closed.", "1", null)
    private val heartRate = NativeEntry("run", "Run", HeartRate.CAPABILITY, "Heart rate", "Show your heart rate with your run.",
        "Run receives your heart rate from your Bluetooth strap during a session you start.", "1", "run-hr-grant", sessionStart - minute)

    private val state = CompanionState(
        signedIn = true, name = "Sample account", apps = listOf(run, ski, rideshare), running = true, permissions = true,
        queued = 3, lastSync = now - minute, sessions = mapOf("run" to Session("run", sessionStart, now - minute)), now = now,
        events = listOf(
            ShareEvent(1, ski.consentAt, "ski", ShareEvent.Kind.ENABLED, ""),
            ShareEvent(2, now - day - 300 * minute, "ski", ShareEvent.Kind.SESSION_STARTED, ""),
            ShareEvent(3, now - day - 60 * minute, "ski", ShareEvent.Kind.SESSION_ENDED, "user"),
            // Run enabled this morning, then started: its "Session" view is this run.
            ShareEvent(4, run.consentAt, "run", ShareEvent.Kind.ENABLED, ""),
            ShareEvent(5, sessionStart, "run", ShareEvent.Kind.SESSION_STARTED, ""),
        ),
        pendingByApp = mapOf("run" to 3), lastUploadByApp = mapOf("run" to now - minute, "ski" to now - day - 60 * minute),
        lastSyncAttempt = now - minute, permission = "whenInUse", lastFix = route().last().let { LiveFix(now - 5_000, it.lat, it.lng) },
        version = "1.0 (1)", entries = listOf(heartRate), heartRateLastUpload = now - minute, heartRateSensor = true,
        heartRateConnected = true, heartRateBpm = 148, heartRateReadingAt = now - 2_000,
    )

    private val store = StoreHooks(CatalogueStore.State(Catalogue(listOf(
        app("run", "Run", "sports", "&#127939;", "#7c3aed", "Record runs, review routes, pace and splits, and export GPX."),
        app("ski", "Ski", "sports", "&#9975;", "#7c3aed", "Explore mapped ski trails, record rides and coordinate private groups."),
        app("kanban", "Kanban Pro", "productivity", "&#128230;", "#f5f3ff", "Team kanban boards with real-time presence, assignees, and live collaboration."),
        app("timetrack", "TimeTrack", "productivity", "&#9201;", "#f0fdf4", "Track time, manage projects, send invoices."),
        app("meetup", "Meetup", "social", "&#128197;", "#f5f3ff", "Create events, groups, and real-time chat."),
        app("flights", "Flights", "travel", "&#9992;", "#eff6ff", "Search and compare flights. Track prices and get fare alerts."),
        app("prolang", "ProLang", "education", "&#127760;", "#fef3c7", "Language learning with spaced repetition."),
        app("tradies", "Tradies", "marketplace", "&#128296;", "#eff6ff", "Find local tradespeople, post jobs and compare quotes."),
    ))))

    private fun app(id: String, name: String, category: String, icon: String, bg: String, description: String) = CatalogueApp(
        id, name, category, icon, bg, description, description, "https://$id.proappstore.online/", emptyList(), null, null, null)

    /** A synthetic 42-minute loop around 0°, 0°: about 5 km, no real place. */
    private fun route(): List<TrackSample> = (0..252).map { i ->
        val t = i / 252.0 * 2 * PI
        val lat = 0.0060 * sin(t) + 0.0015 * sin(2 * t + 1)
        val lng = 0.0090 * cos(t) + 0.0015 * cos(2 * t) + 0.0007 * sin(3 * t + 0.5)
        TrackSample(sessionStart + i * 10_000L, lat, lng, 5.0, if (i < 249) sessionStart + i * 10_000L + 30_000 else null)
    }

    private val heartRateSamples = (0..2_520).map { i -> HeartRatePoint(sessionStart + i * 1_000L, (138 + 14 * sin(i / 300.0) + 4 * sin(i / 37.0)).toInt()) }

    private fun show(tab: Tab) {
        compose.runOnUiThread { compose.activity.enableEdgeToEdge() }
        compose.setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF6D28D9))) {
                PasScreen(state, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, initialTab = tab, store = store,
                    loadTracks = { ids, _ -> ids.associateWith { if (it == "run") route() else emptyList() } },
                    heartRate = HeartRateHooks(load = { _, _ -> heartRateSamples }))
            }
        }
        compose.waitForIdle()
    }

    /** Saves the whole window, which edge to edge is the full 1080×2400 screen, as an opaque PNG (Play takes no alpha). */
    private fun save(name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap().copy(Bitmap.Config.ARGB_8888, true).apply { setHasAlpha(false) }
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "play-screenshots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertEquals("1080x2400", "${bitmap.width}x${bitmap.height}")
    }

    private fun clickLabel(label: String) = SemanticsMatcher("click label $label") { it.config.getOrNull(SemanticsActions.OnClick)?.label == label }

    @Test fun storeHome() { show(Tab.STORE); save("1-store") }

    @Test fun appPageWithItsCompanionToggle() {
        show(Tab.STORE)
        compose.onAllNodesWithText("Run").onFirst().performClick()
        save("2-app-page")
    }

    @Test fun sharingDashboardWithARunSession() { show(Tab.SHARING); save("3-sharing") }

    @Test fun runsControlRoom() {
        show(Tab.SHARING)
        compose.onNode(clickLabel("Show Run sharing")).performScrollTo().performClick()
        compose.onAllNodesWithText("Session").onFirst().performClick() // this morning's run: its map and heart rate
        save("4-run")
    }

    @Test fun trackView() {
        show(Tab.SHARING)
        compose.onNode(clickLabel("Open the map full screen")).performClick()
        save("5-track")
    }

    @Test fun settings() { show(Tab.SETTINGS); save("6-settings") }
}
