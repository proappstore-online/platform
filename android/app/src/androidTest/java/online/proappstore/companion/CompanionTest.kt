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
        compose.setContent { MaterialTheme { PasScreen(state, {}, enable, {}, {}, {}, {}, {}, {}, {}, {}) } }
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
        compose.onNodeWithText("Off", useUnmergedTree = true).assertExists()
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
    @Test fun credentialRoundTripUsesKeystoreAndCanBeCleared() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val store = SecureStore(context)
        store.write(JSONObject().put("token", "test-device-secret"))
        assertEquals("test-device-secret", SecureStore(context).read().getString("token"))
        val stored = context.getSharedPreferences("native-credentials", Context.MODE_PRIVATE).getString("value", "")!!
        assertFalse(stored.contains("test-device-secret"))
        store.clear(); assertFalse(store.read().has("token"))
    }
}
