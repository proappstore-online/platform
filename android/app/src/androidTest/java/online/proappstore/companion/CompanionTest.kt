package online.proappstore.companion

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class CompanionTest {
    @get:Rule val compose = createComposeRule()
    private val ski = ConnectedApp("ski", "Ski", "Record routes", "Ski receives precise location even when closed. You can revoke access.", "1", null)
    private fun screen(state: CompanionState, enable: (ConnectedApp) -> Unit = {}) {
        compose.setContent { MaterialTheme { PasScreen(state, {}, enable, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}) } }
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
    @Test fun offlineRevocationAndPausedStateAreVisible() {
        screen(CompanionState(signedIn = true, apps = listOf(ski.copy(grantId = "old")), blocked = setOf("ski"), paused = true))
        compose.onNodeWithText("Location paused").assertIsDisplayed()
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
        local.paused = false
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
    // Per-app pause (#626, ported from #620)
    private fun store(): LocalStore {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val local = LocalStore(context)
        local.clear()
        fun app(id: String, grant: String) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", JSONObject().put("id", grant).put("consent_at", 1))
        local.saveApps(JSONArray().put(app("ski", "ski-g")).put(app("run", "run-g")))
        local.paused = false
        local.writableDatabase.delete("share_events", null, null) // start each history test from an empty record
        return local
    }
    @Test fun pauseFiltersNewPointsToTheOtherRecipient() {
        val local = store()
        local.pause("ski")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(listOf("run-g"), local.pending().single().grants)
        local.pause("run")
        local.enqueue(TrackPoint("q", 11, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(1, local.count())
        local.clear(); local.close()
    }
    @Test fun pauseLeavesQueuedPointsUntouched() {
        val local = store()
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        local.pause("ski")
        assertEquals(listOf("ski-g", "run-g"), local.pending().single().grants)
        local.clear(); local.close()
    }
    @Test fun resumeRestoresTaggingAndBlockClearsThePause() {
        val local = store()
        local.pause("ski"); local.resume("ski")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("ski-g", "run-g")))
        assertEquals(listOf("ski-g", "run-g"), local.pending().single().grants)
        local.pause("ski"); local.block("ski")
        assertEquals(emptySet<String>(), local.pausedApps())
        assertEquals(setOf("ski"), local.excluded())
        local.clear(); local.close()
    }
    @Test fun pausesSurviveReopenAndClearEmptiesThem() {
        val local = store()
        local.pause("ski"); local.close()
        val reopened = LocalStore(ApplicationProvider.getApplicationContext())
        assertEquals(setOf("ski"), reopened.pausedApps())
        reopened.clear()
        assertEquals(emptySet<String>(), reopened.pausedApps())
        reopened.close()
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
        assertEquals(listOf(ShareEvent.Kind.DISABLED), local.events().map { it.kind })
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
        local.pause("ski")
        local.enqueue(TrackPoint("p", 10, 1.0, 2.0, 5f, listOf("run-g")))
        local.clearHistory(now = 1_000)
        assertEquals(1, local.count())
        assertEquals(emptyList<TrackSample>(), local.track("run", 0, 100))
        assertEquals(listOf("history_cleared", "enabled:ski", "enabled:run", "paused:ski"),
            local.events().map { e -> e.kind.raw + (e.appId?.let { ":$it" } ?: "") })
        local.clear()
        assertEquals(emptyList<ShareEvent>(), local.events())
        local.close()
    }
    @Test fun seedingAnEmptyHistoryStartsAtConsent() {
        val local = store()
        local.seedIfEmpty(now = 5_000)
        assertEquals(listOf(1L, 1L), local.events().map { it.at })
        assertEquals("seeded", local.events().first().detail)
        local.seedIfEmpty(now = 6_000)
        assertEquals(2, local.events().size)
        local.clear(); local.close()
    }
    @Test fun pauseAllAndAForcedStopAreRecordedOnce() {
        val local = store()
        local.paused = true; local.paused = true; local.paused = false
        local.stop("signed_out"); local.stop("signed_out")
        assertEquals(listOf("paused_all", "resumed_all", "stopped"), local.events().map { it.kind.raw })
        assertEquals("signed_out", local.events().last().detail)
        assertTrue(local.paused)
        local.clear(); local.close()
    }
    @Test fun grantChangesFromTheServerAreLogged() {
        val local = store()
        fun app(id: String, grant: String?) = JSONObject().put("id", id).put("name", id).put("purpose", "Routes").put("disclosure", "Disclosure").put("version", "1")
            .put("grant", grant?.let { JSONObject().put("id", it).put("consent_at", 1) } ?: JSONObject.NULL)
        local.saveApps(JSONArray().put(app("ski", null)).put(app("run", "run-new")))
        assertEquals(listOf("grant_lost:ski:revoked", "grant_lost:run:replaced"), local.events().map { "${it.kind.raw}:${it.appId}:${it.detail}" })
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

    // Store tab (#627) and Open (#628).
    private val catalogue = Catalogue.parse("""{"apps":[
        {"id":"ski","name":"Ski","category":"sports","icon":"&#127935;","description":"Ski routes","appUrl":"https://ski.proappstore.online"},
        {"id":"meet","name":"Meet","category":"social","icon":"&#128222;","description":"Video calls","about":"Zero-install calling.","appUrl":"https://meet.proappstore.online"}]}""")!!
    @Test fun openOnAnAppCardUsesTheInstallHint() {
        var opened: ConnectedApp? = null
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski.copy(grantId = "g"))), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, openApp = { opened = it }) } }
        compose.onNodeWithText("Open Ski").performScrollTo().performClick()
        assertEquals("ski", opened?.id)
    }
    @Test fun storeBrowsesSearchesAndOpensWithTheHint() {
        var opened: CatalogueApp? = null
        compose.setContent { MaterialTheme { PasScreen(CompanionState(), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, initialTab = Tab.STORE,
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
        compose.setContent { MaterialTheme { PasScreen(CompanionState(), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, initialTab = Tab.STORE,
            store = StoreHooks(refresh = { retried++ })) } }
        compose.onNodeWithText("Connect to the internet to load the store").assertIsDisplayed()
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retried)
    }
    @Test fun companionToggleOnlyOpensTheDisclosure() {
        var granted = 0
        compose.setContent { MaterialTheme { PasScreen(CompanionState(signedIn = true, apps = listOf(ski)), {}, { granted++ }, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
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
}
