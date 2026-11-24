package online.proappstore.companion

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import android.content.Context
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CompanionTest {
    @get:Rule val compose = createComposeRule()
    private val ski = ConnectedApp("ski", "Ski", "Record routes", "Ski receives precise location even when closed. You can revoke access.", "1", null)
    private fun screen(state: CompanionState, enable: (ConnectedApp) -> Unit = {}) {
        compose.setContent { MaterialTheme { PasScreen(state, {}, enable, {}, {}, {}, {}, {}, {}, {}, {}, {}) } }
    }
    @Test fun consumerLandingHasSignInWithoutDeveloperTools() {
        screen(CompanionState())
        compose.onNodeWithText("Sign in to ProAppStore").assertIsDisplayed()
        compose.onNodeWithText("Create app").assertDoesNotExist()
        compose.onNodeWithText("API key").assertDoesNotExist()
    }
    @Test fun enablingRequiresSpecificDisclosureAndConfirmation() {
        var granted = 0
        screen(CompanionState(signedIn = true, name = "Alex", apps = listOf(ski)), { granted++ })
        compose.onNodeWithText("Enable", useUnmergedTree = true).performScrollTo().performClick()
        compose.onNodeWithText(ski.disclosure).assertIsDisplayed()
        assertEquals(0, granted)
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, granted)
        compose.onNodeWithText("Enable", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Enable for Ski").performClick()
        assertEquals(1, granted)
    }
    @Test fun offlineRevocationAndNoSessionAreVisible() {
        screen(CompanionState(signedIn = true, apps = listOf(ski.copy(grantId = "old")), blocked = setOf("ski")))
        compose.onNodeWithText("Not sharing location").assertIsDisplayed()
        compose.onNodeWithText("Disabled on this phone. Server revocation will finish when connected.").performScrollTo().assertIsDisplayed()
        // #622: a grant still held while the server revocation is pending reads "Turning off…", as on iOS.
        compose.onNodeWithText("Turning off…", useUnmergedTree = true).assertExists()
    }
    @Test fun queueSurvivesReopenAndRevokesOnlyItsRecipient() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("ski", "ski-old")).put(app("rideshare", "ride-grant")))
        local.startSession("ski"); local.startSession("rideshare")
        local.enqueue(TrackPoint("point", 10, 1.0, 2.0, 5f, listOf("ski-old", "ride-grant")))
        local.close()
        val reopened = LocalStore(context)
        assertEquals(1, reopened.count())
        reopened.block("ski")
        assertEquals(listOf("ride-grant"), reopened.pending().single().grants)
        // A callback prepared before revocation cannot put the old recipient back.
        reopened.enqueue(TrackPoint("late", 11, 1.0, 2.0, 5f, listOf("ski-old")))
        assertEquals(1, reopened.count())
        reopened.acknowledge(listOf("not-this-point"))
        assertEquals(1, reopened.count())
        reopened.acknowledge(listOf("point"))
        assertEquals(0, reopened.count())
        reopened.clear(); reopened.close()
    }
    // Collection sessions (ADR-020), which replaced per-app pause (#626) and Pause all
    /** Ski and Run granted, each with a session, and an empty history. */
    private fun store(): LocalStore {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("ski", "ski-g")).put(app("run", "run-g")))
        local.startSession("ski"); local.startSession("run")
        local.writableDatabase.delete("share_events", null, null) // start each history test from an empty record
        return local
    }
    @Test fun stopFiltersNewPointsToTheOtherRecipient() {
        val local = store()
        local.endSession("ski", "user")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(listOf("run-g"), local.pending().single().grants)
        local.endSession("run", "user")
        local.enqueue(TrackPoint("q", 11, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(1, local.count())
        assertEquals(listOf("session_ended:ski:user", "session_ended:run:user"), local.events().map { "${it.kind.raw}:${it.appId}:${it.detail}" })
        local.clear(); local.close()
    }
    @Test fun stopLeavesQueuedPointsUntouched() {
        val local = store()
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        local.endSession("ski", "user")
        assertEquals(listOf("ski-g", "run-g"), local.pending().single().grants)
        local.clear(); local.close()
    }
    @Test fun startRestoresTaggingAndBlockEndsALocationOnlySession() {
        val local = store()
        local.endSession("ski", "user"); local.startSession("ski"); local.startSession("ski")
        assertEquals(listOf("session_ended", "session_started"), local.events().map { it.kind.raw })
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(listOf("ski-g", "run-g"), local.pending().single().grants)
        local.block("ski")
        assertEquals(setOf("run"), local.sessionIds())
        assertEquals("grant", local.events().last { it.kind == ShareEvent.Kind.SESSION_ENDED }.detail)
        local.clear(); local.close()
    }
    @Test fun sessionsSurviveReopenAndClearEmptiesThem() {
        val local = store()
        local.endSession("ski", "user"); local.close()
        val reopened = LocalStore(ApplicationProvider.getApplicationContext())
        assertEquals(setOf("run"), reopened.sessionIds())
        reopened.clear()
        assertEquals(emptySet<String>(), reopened.sessionIds())
        reopened.close()
    }
    /** First run after #668: Pause all and per-app pause are dropped, and no session is created. */
    @Test fun theMigrationDropsThePausePrefs() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        LocalStore(context).apply { clear(); close() }
        context.getSharedPreferences("native-settings", Context.MODE_PRIVATE).edit().putBoolean("paused", false).putStringSet("pausedApps", setOf("run")).commit()
        val local = LocalStore(context)
        val prefs = context.getSharedPreferences("native-settings", Context.MODE_PRIVATE)
        assertFalse(prefs.contains("paused")); assertFalse(prefs.contains("pausedApps"))
        assertEquals(emptyList<Session>(), local.sessions())
        local.clear(); local.close()
    }
    /** ADR-020 §7: after the OS stopped the collector, an unexpired session resumes with a fresh stationary clock; one past 12 h ends. */
    @Test fun resumingEndsSessionsPastTwelveHoursAndRestartsTheClock() {
        val local = store()
        local.endAllSessions("all")
        val now = 100 * LocationPolicy.MAX_SESSION_MS
        local.startSession("ski", now - LocationPolicy.MAX_SESSION_MS); local.startSession("run", now - 60 * 60_000)
        local.resumeSessions(now)
        assertEquals(listOf(Session("run", now - 60 * 60_000, now)), local.sessions())
        assertEquals("max", local.events().last().detail)
        local.clear(); local.close()
    }
    @Test fun aGrantLostOnTheServerEndsItsSession() {
        val local = store()
        local.saveApps(JSONArray().put(JSONObject().put("id", "run").put("name", "run").put("purpose", "Routes").put("disclosure", "D").put("version", "1")
            .put("grant", JSONObject().put("id", "run-g").put("consent_at", 1))))
        assertEquals(setOf("run"), local.sessionIds())
        local.clear(); local.close()
    }
    @Test fun credentialRoundTripUsesKeystoreAndCanBeCleared() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = SecureStore(context)
        store.write(JSONObject().put("token", "test-device-secret"))
        assertEquals("test-device-secret", SecureStore(context).read().getString("token"))
        val stored = context.getSharedPreferences("native-credentials", Context.MODE_PRIVATE).getString("value", "")!!
        assertFalse(stored.contains("test-device-secret"))
        store.clear(); assertFalse(store.read().has("token"))
    }

    // Connection expired (#652)
    @Test fun anExpiredConnectionShowsReconnectAndKeepsTheHistory() {
        var reconnects = 0
        val events = listOf(ShareEvent(1, 1, "ski", ShareEvent.Kind.ENABLED, ""), ShareEvent(2, 2, null, ShareEvent.Kind.EXPIRED, ""))
        compose.setContent { MaterialTheme { PasScreen(CompanionState(expired = true, apps = listOf(ski.copy(grantId = "old")), events = events),
            {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, reconnect = { reconnects++ }) } }
        compose.onAllNodesWithText("Connection expired").onFirst().assertIsDisplayed()
        compose.onNodeWithText("Sign in to ProAppStore").assertDoesNotExist()
        compose.onNodeWithText("Stop all").assertDoesNotExist()
        compose.onAllNodesWithText("Connection expired", useUnmergedTree = true).assertCountEquals(2) // the card and Ski's chip
        compose.onNodeWithText("Reconnect").performClick()
        assertEquals(1, reconnects)
        compose.onNodeWithText("Activity").performClick()
        compose.onNodeWithText("Connection to ProAppStore expired: sharing stopped", substring = true).assertExists()
    }
    @Test fun deleteAccountOpensTheWebPageSignedInAndSignedOut() {
        val opened = mutableListOf<String>()
        var signedIn by mutableStateOf(true)
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = signedIn), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
            initialTab = Tab.SETTINGS, store = StoreHooks(openUrl = { opened += it })) } }
        // Signed in: next to Manage account, and in About (#663).
        compose.onAllNodesWithText("Delete account").assertCountEquals(2)
        compose.onAllNodesWithText("Delete account")[0].performScrollTo().performClick()
        signedIn = false
        compose.onNodeWithText("Delete account").performScrollTo().performClick()
        assertEquals(List(2) { "https://proappstore.online/privacy#data-deletion" }, opened)
    }
    @Test fun theExpiryNoteShowsInSettingsOnlyWhenSet() {
        var reconnects = 0
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, expiresInDays = 1), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
            initialTab = Tab.SETTINGS, reconnect = { reconnects++ }) } }
        compose.onNodeWithText("Connection renews when you reconnect — expires in 1 day").assertIsDisplayed()
        compose.onNodeWithText("Reconnect").performClick()
        assertEquals(1, reconnects)
    }

    /** Answers like the server: `status(path)` decides per call; 200 paths get a usable body. */
    private class Server(var status: (String) -> Int) : PasApi() {
        val seen = mutableListOf<String>()
        override fun request(method: String, path: String, token: String?, body: JSONObject?): JSONObject {
            seen += "$method $path"
            when (val code = status(path)) {
                0 -> throw java.io.IOException("offline")
                200 -> return when (path) {
                    "/native/me" -> JSONObject().put("user", JSONObject().put("id", userId).put("name", "Alex"))
                        .put("device", JSONObject().put("id", "d1").put("label", "Pixel").put("expiresAt", 123L))
                        .put("apps", JSONArray().put(JSONObject().put("id", "ski").put("name", "Ski").put("purpose", "Routes").put("disclosure", "D").put("version", "1")
                            .put("grant", if (token == "ndev_new") JSONObject.NULL else JSONObject().put("id", "ski-g").put("consent_at", 1))))
                    "/native/auth/complete" -> JSONObject().put("token", "ndev_new")
                    "/native/locations" -> JSONObject().put("acknowledged", JSONArray(body!!.getJSONArray("points").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }))
                    "/native/heart-rate" -> JSONObject().put("acknowledged", JSONArray(body!!.getJSONArray("samples").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }))
                    else -> JSONObject()
                }
                else -> throw ApiFailure(code, "Device connection expired or was disconnected.")
            }
        }
        var userId = "u1"
    }
    private fun connected(server: Server): CompanionRepository {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = store()
        // Only Ski, as the fake server answers, so no `grant_lost` for Run.
        local.saveApps(JSONArray().put(JSONObject().put("id", "ski").put("name", "Ski").put("purpose", "Routes").put("disclosure", "D").put("version", "1")
            .put("grant", JSONObject().put("id", "ski-g").put("consent_at", 1))))
        local.writableDatabase.delete("share_events", null, null)
        SecureStore(context).write(JSONObject().put("token", "ndev_old").put("userId", "u1"))
        local.enqueue(TrackPoint("p", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("ski-g")))
        return CompanionRepository(local, SecureStore(context), server)
    }
    private fun LocalStore.kinds() = events().map { it.kind }
    @Test fun a401FromAnyDeviceCallExpiresTheConnection() = kotlinx.coroutines.runBlocking {
        for (failing in listOf("/native/me", "/native/locations")) {
            val repository = connected(Server { if (it == failing) 401 else 200 })
            assertTrue(runCatching { repository.sync() }.isFailure)
            val local = repository.local
            assertTrue(failing, local.expired)
            assertEquals("u1", local.expiredUser)
            assertNull(repository.token())
            assertFalse("collection stops", repository.collecting())
            assertEquals("", local.message)
            assertEquals("an expiry ends every session", listOf(ShareEvent.Kind.SESSION_ENDED, ShareEvent.Kind.EXPIRED), local.kinds())
            assertEquals(emptyList<Session>(), local.sessions())
            local.enqueue(TrackPoint("late", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("ski-g")))
            assertEquals(1, local.count())
            local.clear(); local.close()
        }
        val repository = connected(Server { if (it.startsWith("/native/apps/")) 401 else 200 })
        assertTrue(runCatching { repository.enable(repository.local.apps().first()) }.isFailure)
        assertTrue(repository.local.expired)
        repository.local.clear(); repository.local.close(); SecureStore(ApplicationProvider.getApplicationContext()).clear()
    }
    @Test fun networkErrors429And5xxNeverExpire() = kotlinx.coroutines.runBlocking {
        for (status in listOf(0, 429, 500, 503)) {
            val repository = connected(Server { if (it == "/native/me") status else 200 })
            assertTrue(runCatching { repository.sync() }.isFailure)
            assertFalse("$status", repository.local.expired)
            assertEquals("ndev_old", repository.token())
            assertEquals(1, repository.local.count())
            repository.local.clear(); repository.local.close()
        }
        SecureStore(ApplicationProvider.getApplicationContext()).clear()
    }
    @Test fun expiredSurvivesARelaunchAndReconnectKeepsHistoryButNotQueueOrGrants() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val server = Server { 200 }
        val first = connected(server)
        first.sync() // "p" uploads: shared history
        first.local.enqueue(TrackPoint("q", System.currentTimeMillis(), 1.0, 2.0, 5f, listOf("ski-g"))) // still queued
        first.local.record(ShareEvent.Kind.ENABLED, "ski")
        server.status = { if (it == "/native/me") 401 else 200 }
        assertTrue(runCatching { first.sync() }.isFailure)
        first.local.close()
        // Relaunch: new store and repository instances.
        val local = LocalStore(context)
        val repository = CompanionRepository(local, SecureStore(context), server)
        assertTrue(local.expired); assertNull(repository.token()); assertEquals(1, local.count())
        // Reconnect: the same pairing flow, same account.
        server.status = { 200 }
        SecureStore(context).write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        assertTrue(repository.finishSignIn())
        assertEquals("ndev_new", repository.token())
        assertFalse(local.expired)
        assertEquals(0, local.count())
        assertNull("the old device's grant is gone", local.apps().single().grantId)
        assertEquals("no grant_lost noise", listOf(ShareEvent.Kind.ENABLED, ShareEvent.Kind.SESSION_ENDED, ShareEvent.Kind.EXPIRED), local.kinds())
        assertEquals("the shared point stays, the unsent one goes", 1, local.track("ski", 0, Long.MAX_VALUE).size)
        assertEquals(123L, local.deviceExpiresAt)
        local.clear(); local.close(); SecureStore(context).clear()
    }
    @Test fun reconnectingAsAnotherAccountClearsEverything() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val server = Server { if (it == "/native/me") 401 else 200 }
        val repository = connected(server)
        assertTrue(runCatching { repository.sync() }.isFailure)
        server.status = { 200 }; server.userId = "u2"
        SecureStore(context).write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        assertTrue(repository.finishSignIn())
        assertEquals(emptyList<ShareEvent>(), repository.local.events())
        assertEquals(0, repository.local.count())
        repository.local.clear(); repository.local.close(); SecureStore(context).clear()
    }
    @Test fun renewingEarlyUploadsFirstThenKeepsHistory() = kotlinx.coroutines.runBlocking {
        val server = Server { 200 }
        val repository = connected(server)
        repository.renew()
        assertEquals(listOf("GET /native/me", "POST /native/locations"), server.seen)
        assertTrue(repository.local.expired); assertNull(repository.token()); assertEquals(0, repository.local.count())
        assertEquals("renew", repository.local.events().last().detail)
        assertEquals(1, repository.local.track("ski", 0, Long.MAX_VALUE).size)
        repository.local.clear(); repository.local.close()
    }
    @Test fun disconnectStillWipesEverything() = kotlinx.coroutines.runBlocking {
        for (expire in listOf(false, true)) {
            val server = Server { 200 }
            val repository = connected(server)
            repository.sync()
            if (expire) { server.status = { 401 }; runCatching { repository.sync() }; server.status = { 200 } }
            repository.disconnect()
            val local = repository.local
            assertFalse(local.expired)
            assertEquals(emptyList<ShareEvent>(), local.events())
            assertEquals(emptyList<TrackSample>(), local.track("ski", 0, Long.MAX_VALUE))
            assertEquals(0, local.count())
            assertEquals(emptyList<ConnectedApp>(), local.apps())
            assertNull(repository.token())
            local.close()
        }
    }

    /** A pairing the server calls expired (403) or used (409) is forgotten; a pending one or a network error keeps it. */
    @Test fun aDeadPairingIsForgottenSoSignInStartsClean() = kotlinx.coroutines.runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val secure = SecureStore(context)
        var answer: () -> JSONObject = { JSONObject().put("pending", true) }
        val api = object : PasApi() { override fun request(method: String, path: String, token: String?, body: JSONObject?) = answer() }
        val repository = CompanionRepository(LocalStore(context), secure, api)
        fun pair() = secure.write(JSONObject().put("pairId", "abcdef0123").put("verifier", "00"))
        pair()
        assertFalse(repository.finishSignIn()); assertEquals("ABCDEF01", repository.pairingCode())
        answer = { throw java.io.IOException("offline") }
        assertTrue(runCatching { repository.finishSignIn() }.isFailure); assertEquals("ABCDEF01", repository.pairingCode())
        for (status in listOf(403, 409)) {
            pair()
            answer = { throw ApiFailure(status, "Invalid or expired connection.") }
            assertEquals(status, (runCatching { repository.finishSignIn() }.exceptionOrNull() as ApiFailure).status)
            assertEquals("", repository.pairingCode())
            assertFalse(repository.finishSignIn())
        }
        secure.clear()
    }

    // On-device sharing history (#621), ported from iOS LocalStoreTests.
    @Test fun enqueueWritesHistoryPerAppAndAcknowledgeKeepsIt() {
        val local = store()
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(1, local.pendingCount("ski")); assertEquals(1, local.pendingCount("run"))
        assertNull(local.lastUpload("run"))
        local.acknowledge(listOf("p"), now = 500)
        assertEquals(0, local.count())
        assertEquals(0, local.pendingCount("run"))
        assertEquals(500L, local.lastUpload("run"))
        assertEquals(listOf(TrackSample(10, 1.0, 2.0, 5.0, 500)), local.track("ski", 0, 100))
        assertEquals(emptyList<TrackSample>(), local.track("ski", 11, 100))
        local.clear(); local.close()
    }
    @Test fun blockDropsOnlyThatAppsUnsentHistory() {
        val local = store()
        local.enqueue(TrackPoint("sent", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        local.acknowledge(listOf("sent"))
        local.enqueue(TrackPoint("queued", 11, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        local.block("ski")
        assertEquals(listOf(10L), local.track("ski", 0, 100).map { it.at })
        assertEquals(listOf(10L, 11L), local.track("run", 0, 100).map { it.at })
        assertEquals(listOf(ShareEvent.Kind.DISABLED, ShareEvent.Kind.SESSION_ENDED), local.events().map { it.kind })
        local.clear(); local.close()
    }
    @Test fun expireKeepsThirtyDaysAndTheLastStateBeforeTheWindow() {
        val local = store()
        val day = 24 * 60 * 60 * 1000L
        val now = 100 * day
        local.record(ShareEvent.Kind.ENABLED, "run", at = now - 40 * day)
        local.record(ShareEvent.Kind.PAUSED, "run", at = now - 39 * day)
        local.record(ShareEvent.Kind.PAUSED, "run", at = now - 35 * day)
        local.record(ShareEvent.Kind.RESUMED, "run", at = now - day)
        local.enqueue(TrackPoint("old", now - 31 * day, 1.0, 2.0, 5f, listOf("run-g")))
        local.enqueue(TrackPoint("unsent", now - 8 * day, 1.0, 2.0, 5f, listOf("run-g")))
        local.enqueue(TrackPoint("recent", now - day, 1.0, 2.0, 5f, listOf("run-g")))
        local.acknowledge(listOf("old", "recent"))
        local.expire(now)
        assertEquals(listOf(now - day), local.track("run", 0, now).map { it.at })
        assertEquals(listOf(now - 40 * day, now - 35 * day, now - day), local.events().map { it.at })
        local.clear(); local.close()
    }
    @Test fun clearHistoryKeepsTheQueueAndReseeds() {
        val local = store()
        local.endSession("ski", "user")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("run-g")))
        local.clearHistory(now = 1_000)
        assertEquals(1, local.count())
        assertEquals(emptyList<TrackSample>(), local.track("run", 0, 100))
        assertEquals(listOf("history_cleared", "enabled:ski", "enabled:run", "session_started:run"),
            local.events().map { e -> e.kind.raw + (e.appId?.let { ":$it" } ?: "") })
        local.clear()
        assertEquals(emptyList<ShareEvent>(), local.events())
        local.close()
    }
    @Test fun seedingAnEmptyHistoryStartsAtConsent() {
        val local = store()
        local.seedIfEmpty(now = 5_000)
        assertEquals("enabled at consent, running sessions now", listOf(1L, 1L, 5_000L, 5_000L), local.events().map { it.at })
        assertEquals("seeded", local.events().first().detail)
        local.seedIfEmpty(now = 6_000)
        assertEquals(4, local.events().size)
        local.clear(); local.close()
    }
    @Test fun aForcedStopIsRecordedOnceAndEndsEverySession() {
        val local = store()
        local.stop("storage_failed"); local.stop("storage_failed")
        assertEquals(listOf("stopped"), local.events().map { it.kind.raw })
        assertEquals("storage_failed", local.events().last().detail)
        assertEquals(emptyList<Session>(), local.sessions())
        local.clear(); local.close()
    }
    @Test fun grantChangesFromTheServerAreLogged() {
        val local = store()
        fun app(id: String, grant: String?) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", grant?.let { JSONObject().put("id", it).put("consent_at", 1) } ?: JSONObject.NULL)
        local.saveApps(JSONArray().put(app("ski", null)).put(app("run", "run-new")))
        assertEquals(listOf("grant_lost:ski:revoked", "session_ended:ski:grant", "grant_lost:run:replaced", "session_ended:run:grant"),
            local.events().map { "${it.kind.raw}:${it.appId}:${it.detail}" })
        local.saveApps(JSONArray().put(app("ski", "ski-back")).put(app("run", "run-new")))
        assertEquals(ShareEvent.Kind.GRANT_RESTORED, local.events().last().kind)
        local.clear(); local.close()
    }
    @Test fun syncFailuresAreDeduplicatedAndRecoveryCounted() {
        val local = store()
        repeat(3) { local.syncFailed("0 offline") }
        local.syncSucceeded()
        local.syncSucceeded()
        assertEquals(listOf("sync_failed", "sync_recovered"), local.events().map { it.kind.raw })
        assertEquals("after 3 attempts", local.events().last().detail)
        local.syncFailed("x".repeat(300))
        assertEquals(120, local.events().last().detail.length)
        assertFalse(local.events().any { Regex("-?\\d{1,3}\\.\\d{4,}").containsMatchIn(it.detail) })
        local.clear(); local.close()
    }

    // Start, Stop and the link prompt (ADR-020)
    @Test fun startAndStopOnTheRow() {
        var started = 0
        val granted = ski.copy(grantId = "g")
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(granted), permissions = true), {}, {}, {}, { started++ }, {}, {},
            {}, {}, {}, {}, {}) } }
        compose.onNodeWithText("Stop all").assertDoesNotExist()
        compose.onNodeWithText("Start").performScrollTo().performClick()
        assertEquals(1, started)
    }
    @Test fun aRunningSessionShowsStopAndStopAll() {
        var stopped = 0; var all = 0
        val granted = ski.copy(grantId = "g")
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(granted), permissions = true, running = true,
            sessions = mapOf("ski" to Session("ski", 0, 0)), now = 42 * 60_000), {}, {}, {}, {}, { stopped++ }, { all++ }, {}, {}, {}, {}, {}) } }
        compose.onNodeWithText("Sharing for", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Stop all").performClick()
        compose.onNodeWithText("Stop").performScrollTo().performClick()
        assertEquals(1, all); assertEquals(1, stopped)
    }
    @Test fun aLinkToAGrantedAppAsksBeforeStartingAndNotNowStartsNothing() {
        var started = 0
        var link by mutableStateOf<String?>("ski")
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski.copy(grantId = "g"))), {}, {}, {}, { started++ }, {}, {},
            {}, {}, {}, {}, {}, link = link, linkShown = { link = null }) } }
        compose.onNodeWithText("Start sharing with Ski?").assertIsDisplayed()
        compose.onNodeWithText("Not now").performClick()
        assertEquals(0, started)
        link = "ski"
        compose.onNode(hasText("Start") and hasAnyAncestor(isDialog())).performClick()
        assertEquals(1, started)
    }
    @Test fun aLinkToAnUngrantedAppOpensItsConsentAndAnUnknownOneNothing() {
        var link by mutableStateOf<String?>("ski")
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski)), {}, {}, {}, {}, {}, {},
            {}, {}, {}, {}, {}, link = link, linkShown = { link = null }) } }
        compose.onNodeWithText(ski.disclosure).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        link = "nope"
        compose.onNodeWithText("Start sharing", substring = true).assertDoesNotExist()
        compose.onNodeWithText(ski.disclosure).assertDoesNotExist()
    }
    /** ADR-020 decision 11: heart rate is offered only once the app's location is on. */
    @Test fun enableHeartRateWaitsForLocation() {
        val hr = NativeEntry("ski", "Ski", HeartRate.CAPABILITY, "Heart rate", "p", "d", "1", null)
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski), entries = listOf(hr)), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}) } }
        compose.onNodeWithText("Enable heart rate").assertDoesNotExist()
        compose.onNodeWithText("Off · turn on location for Ski first", useUnmergedTree = true).assertExists()
    }

    // Store tab (#627) and Open (#628).
    private val catalogue = Catalogue.parse("""{"apps":[
        {"id":"ski","name":"Ski","category":"sports","icon":"&#127935;","description":"Ski routes","appUrl":"https://ski.proappstore.online"},
        {"id":"meet","name":"Meet","category":"social","icon":"&#128222;","description":"Video calls","about":"Zero-install calling.","appUrl":"https://meet.proappstore.online"}]}""")!!
    @Test fun openOnAnAppCardUsesTheInstallHint() {
        var opened: ConnectedApp? = null
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski.copy(grantId = "g"))), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, openApp = { opened = it }) } }
        compose.onNodeWithText("Open Ski").performScrollTo().performClick()
        assertEquals("ski", opened?.id)
    }
    @Test fun storeBrowsesSearchesAndOpensWithTheHint() {
        var opened: CatalogueApp? = null
        compose.setContent { MaterialTheme { PasScreen(CompanionState(), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, initialTab = Tab.STORE,
            store = StoreHooks(CatalogueStore.State(catalogue), open = { opened = it })) } }
        compose.onAllNodes(hasScrollToNodeAction()).onFirst().performScrollToNode(hasText("All apps"))
        compose.onNodeWithText("All apps").assertIsDisplayed()
        compose.onAllNodes(hasScrollToNodeAction()).onFirst().performScrollToIndex(0)
        compose.onNodeWithText("Apps, categories and features").performTextInput("calling")
        compose.onAllNodesWithContentDescription("Open Meet").onFirst().performClick()
        assertEquals("https://meet.proappstore.online/?install=1", opened?.openUrl)
    }
    @Test fun storeOfflineWithoutACacheOffersRetry() {
        var retried = 0
        compose.setContent { MaterialTheme { PasScreen(CompanionState(), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, initialTab = Tab.STORE,
            store = StoreHooks(refresh = { retried++ })) } }
        compose.onNodeWithText("Connect to the internet to load the store").assertIsDisplayed()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retried)
    }
    @Test fun companionToggleOnlyOpensTheDisclosure() {
        var granted = 0
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski)), {}, { granted++ }, {}, {}, {}, {}, {}, {}, {}, {}, {},
            initialTab = Tab.STORE, store = StoreHooks(CatalogueStore.State(catalogue))) } }
        compose.onNodeWithText("Apps, categories and features").performTextInput("Ski routes")
        compose.onNodeWithText("Sports").performClick()
        compose.onNodeWithContentDescription("Use Ski with companion").performScrollTo().performClick()
        compose.onNodeWithText(ski.disclosure).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, granted)
        compose.onNodeWithContentDescription("Use Ski with companion").performClick()
        compose.onNodeWithText("Enable for Ski").performClick()
        assertEquals(1, granted)
    }

    // Run's strap heart rate (#634)

    /** [store] plus Run's location (`run-g`) and heart-rate (`run-hr`) entries. */
    private fun heartRateStore(): LocalStore = store().also { local ->
        fun entry(app: String, capability: String, grant: String) = JSONObject().put("appId", app).put("appName", app).put("capability", capability)
            .put("name", "n").put("purpose", "p").put("disclosure", "d").put("version", "1").put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveEntries(JSONArray().put(entry("ski", "location.background", "ski-g")).put(entry("run", "location.background", "run-g")).put(entry("run", "heart_rate.ble", "run-hr")))
    }
    private fun sample(id: String, at: Long = System.currentTimeMillis(), bpm: Int = 140) = HeartRateSample(id, at, bpm, listOf("run-hr"))

    @Test fun blockingRunHeartRateLeavesRunLocationIntact() {
        val local = heartRateStore()
        local.enqueueHeartRate(sample("h1"))
        local.block("run/heart_rate.ble")
        assertEquals(0, local.heartRateCount())
        assertEquals(listOf("ski-g", "run-g"), LocationPolicy.recipients(local.apps(), local.blocked(), local.sessionIds(), 20))
        local.enqueue(TrackPoint("p", 20, 1.0, 2.0, 5f, listOf("run-g")))
        assertEquals(1, local.count())
        assertEquals(listOf("heart_rate:disabled"), local.events().filter { it.appId == "run" }.map { "${it.kind.raw}:${it.detail}" })
        local.clear(); local.close()
    }

    /** #668 finding 1 (iOS #677's twin): turning off Run's location keeps Run's session, so its heart rate carries on. */
    @Test fun blockingRunLocationLeavesRunHeartRateIntact() {
        val local = heartRateStore()
        local.enqueueHeartRate(sample("h1", 10))
        local.block("run")
        assertEquals(setOf("ski", "run"), local.sessionIds())
        assertEquals(listOf("run-hr"), HeartRatePolicy.recipients(local.entries(), local.blocked(), local.sessionIds(), 20))
        local.enqueueHeartRate(sample("h2", 20))
        assertEquals(listOf("h1", "h2"), local.pendingHeartRate().map { it.id })
        // Heart rate off too: nothing is left, so the session ends.
        local.block("run/heart_rate.ble")
        assertEquals(setOf("ski"), local.sessionIds())
        local.clear(); local.close()
    }

    /** Stopping Run stops its heart rate; turning off its location afterwards never resumes it (the live bug #668 fixes). */
    @Test fun heartRateFollowsRunsSessionAndAStoppedRunStaysStopped() {
        val local = heartRateStore()
        local.endSession("run", "user"); local.enqueueHeartRate(sample("stopped"))
        local.block("run"); local.enqueueHeartRate(sample("after-location-off"))
        assertEquals(0, local.heartRateCount())
        assertEquals(emptyList<String>(), HeartRatePolicy.recipients(local.entries(), local.blocked(), local.sessionIds(), System.currentTimeMillis()))
        assertEquals(setOf("ski"), local.sessionIds())
        local.endAllSessions("all"); local.enqueueHeartRate(sample("all"))
        assertEquals(0, local.heartRateCount())
        local.clear(); local.close()
    }

    @Test fun heartRateHistoryIsKeptAcknowledgedExpiredAndCleared() {
        val local = heartRateStore()
        val now = 40L * 24 * 60 * 60 * 1000
        local.enqueueHeartRate(sample("old", now - LocationPolicy.HISTORY_MS - 1))
        local.enqueueHeartRate(sample("unsent-8d", now - LocationPolicy.RETENTION_MS - 1))
        local.enqueueHeartRate(sample("sent-8d", now - LocationPolicy.RETENTION_MS - 2, 99))
        local.enqueueHeartRate(sample("new", now - 1, 150))
        local.acknowledgeHeartRate(listOf("old", "sent-8d", "new"), now)
        assertEquals(now, local.heartRateLastUpload)
        local.expire(now)
        assertEquals(0, local.heartRateCount())
        assertEquals(listOf(HeartRatePoint(now - LocationPolicy.RETENTION_MS - 2, 99), HeartRatePoint(now - 1, 150)), local.heartRate("run", 0, Long.MAX_VALUE))
        assertEquals(HeartRatePoint(now - 1, 150), local.lastHeartRate("run"))
        local.enqueueHeartRate(sample("queued", now))
        local.clearHistory(now)
        assertEquals("Clear history clears heart rate too", emptyList<HeartRatePoint>(), local.heartRate("run", 0, Long.MAX_VALUE))
        assertEquals("and keeps the queue, like points", 1, local.heartRateCount())
        local.heartRateSensor = "00:11:22:33:44:55"
        local.clear()
        assertEquals(0, local.heartRateCount()); assertNull(local.heartRateSensor)
        local.close()
    }

    @Test fun heartRateQueueStopsAtItsCap() {
        val local = heartRateStore()
        local.writableDatabase.execSQL("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${HeartRatePolicy.MAX_QUEUE}) INSERT INTO hr(id, at, payload) SELECT 'h' || i, i, '{}' FROM n")
        assertTrue(runCatching { local.enqueueHeartRate(sample("over")) }.exceptionOrNull() is HeartRateQueueFull)
        assertEquals(HeartRatePolicy.MAX_QUEUE, local.heartRateCount())
        assertEquals(listOf(ShareEvent.Kind.HEART_RATE_PROBLEM), local.kinds())
        local.clear(); local.close()
    }

    @Test fun heartRateUploadsAfterPointsAndARejectionIsLoggedAsHeartRate() = kotlinx.coroutines.runBlocking {
        for (status in listOf(200, 400)) {
            val server = Server { if (it == "/native/heart-rate") status else 200 }
            val repository = connected(server)
            val local = repository.local
            // The fake /native/me has no `capabilities`; sync stores none, so the queued sample carries its grant regardless.
            val queued = sample("h")
            local.writableDatabase.execSQL("INSERT INTO hr(id, at, payload) VALUES (?, ?, ?)", arrayOf<Any>(queued.id, queued.at, queued.json().toString()))
            val result = runCatching { repository.sync() }
            assertEquals(listOf("GET /native/me", "POST /native/locations", "POST /native/heart-rate"), server.seen)
            if (status == 200) { assertTrue(result.isSuccess); assertEquals(0, local.heartRateCount()); assertEquals("", local.heartRateSyncError) }
            else {
                assertEquals(1, local.heartRateCount()); assertEquals(0, local.count())
                assertNotEquals("", local.heartRateSyncError)
                assertEquals(listOf("heart_rate_problem:400"), local.events().filter { it.kind == ShareEvent.Kind.HEART_RATE_PROBLEM || it.kind == ShareEvent.Kind.UPLOAD_REJECTED }.map { "${it.kind.raw}:${it.detail}" })
            }
            local.clear(); local.close()
        }
    }

    // Storage off the main thread (#663 criterion 5). The activity's own store, so its lock is the one contended.
    private fun timeOnMain(scenario: ActivityScenario<MainActivity>, action: (MainActivity) -> Unit): Long {
        val started = SystemClock.elapsedRealtime()
        scenario.onActivity(action)
        return SystemClock.elapsedRealtime() - started
    }
    private fun awaitState(scenario: ActivityScenario<MainActivity>, condition: (CompanionState) -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 60_000
        while (true) {
            var met = false
            scenario.onActivity { met = condition(it.state) }
            if (met) return
            assertTrue("state never assigned", SystemClock.elapsedRealtime() < deadline)
            Thread.sleep(100)
        }
    }
    @Test fun aRevocationOverAFullQueueNeverHoldsMainAndRefreshAssignsOnMain() {
        val graph = ApplicationProvider.getApplicationContext<PasApplication>()
        val local = graph.local
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("ski", "ski-g")).put(app("run", "run-g")))
        // 60,000 queued points for Ski and Run: disabling Ski rewrites every one inside the store's lock.
        local.writableDatabase.execSQL("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LocationPolicy.MAX_QUEUE}) " +
            "INSERT INTO points(id, at, payload) SELECT 'p' || i, i, '{\"id\":\"p' || i || '\",\"at\":' || i || ',\"lat\":1,\"lng\":2,\"accuracy\":5,\"grants\":[\"ski-g\",\"run-g\"]}' FROM n")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitState(scenario) { it.apps.size == 2 }
            val disabled = java.util.concurrent.atomic.AtomicBoolean(false)
            val ski = local.apps().first { it.id == "ski" }
            val disabling = kotlin.concurrent.thread { kotlinx.coroutines.runBlocking { graph.repository.disable(ski) }; disabled.set(true) }
            Thread.sleep(200) // block() holds the lock by now
            var thread: Thread? = null
            val elapsed = timeOnMain(scenario) { thread = Thread.currentThread(); it.refresh() }
            assertFalse("the revocation was still running, so the test measured contention", disabled.get())
            assertTrue("refresh held Main for $elapsed ms", elapsed < 200)
            assertEquals(Looper.getMainLooper().thread, thread)
            // The read waits on IO for the lock, which the revocation holds for as long as it takes, then lands on Main.
            disabling.join()
            awaitState(scenario) { "ski" in it.blocked }
        }
        local.clear()
    }
    @Test fun clearingAFullHistoryReturnsToMainImmediately() {
        val graph = ApplicationProvider.getApplicationContext<PasApplication>()
        val local = graph.local
        local.clear()
        local.writableDatabase.execSQL("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LocationPolicy.HISTORY_MAX_POINTS}) " +
            "INSERT INTO share_points(app_id, point_id, at, lat, lng, accuracy, sent_at) SELECT 'ski', 'p' || i, i, 1, 2, 5, i FROM n")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitState(scenario) { true }
            val elapsed = timeOnMain(scenario) { it.clearHistory() }
            assertTrue("clearHistory held Main for $elapsed ms", elapsed < 200)
            awaitState(scenario) { s -> s.events.any { it.kind == ShareEvent.Kind.HISTORY_CLEARED } }
            assertEquals(emptyList<TrackSample>(), local.track("ski", 0, Long.MAX_VALUE))
        }
        local.clear()
    }
}
