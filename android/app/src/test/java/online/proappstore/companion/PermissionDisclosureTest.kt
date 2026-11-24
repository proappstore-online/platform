package online.proappstore.companion

import online.proappstore.companion.PermissionDisclosure.Step
import org.junit.Assert.*
import org.junit.Test

/** #663: the prominent disclosure lists every location entry, and one permission step continues the user's Start. */
class PermissionDisclosureTest {
    private val apps = listOf(
        ConnectedApp("ski", "Ski", "Automatically record your routes for Ski, including when Ski is closed.", "D", "1", "ski-g"),
        ConnectedApp("run", "Run", "Keep recording your runs and walks while your phone is locked or Run is closed.", "D", "1", null),
        ConnectedApp("rideshare", "Rideshare", "Keep dispatch and your rider seeing where you are while you drive, including when your phone is locked or Rideshare is closed.", "D", "1", null),
    )

    @Test fun theBodyHasOneBulletPerEntryEnabledOrNot() {
        val body = PermissionDisclosure.body(apps)
        assertTrue(body.contains("location")); assertTrue(body.contains("locked"))
        assertEquals(3, body.lines().count { it.startsWith("• ") })
        apps.forEach { assertTrue(body.contains("• ${it.name}: ${it.purpose}")) }
    }

    @Test fun theBodyIsTheIssuesTextForTheCurrentCatalog() {
        assertEquals("""
            ProAppStore collects your precise location while a sharing session you start is running, including while your phone is locked and ProAppStore and the apps are closed. It is used for:
            • Ski: Automatically record your routes for Ski, including when Ski is closed.
            • Run: Keep recording your runs and walks while your phone is locked or Run is closed.
            • Rideshare: Keep dispatch and your rider seeing where you are while you drive, including when your phone is locked or Rideshare is closed.

            Your location goes to ProAppStore and only to the apps you turn on here. It is never used for advertising. A session ends when you tap Stop, after 30 minutes without moving, or after 12 hours.
        """.trimIndent(), PermissionDisclosure.body(apps))
        assertEquals("Allow precise location", PermissionDisclosure.TITLE)
    }

    @Test fun nothingAsksForAllTheTime() {
        val text = listOf(PermissionDisclosure.body(apps), PermissionDisclosure.SETTINGS, PermissionDisclosure.APPROXIMATE).joinToString()
        assertFalse(text.contains("all the time", ignoreCase = true)); assertFalse(text.contains("next settings screen"))
    }

    @Test fun preciseContinuesThePendingStart() {
        assertEquals(Step.CONTINUE, PermissionDisclosure.step(fine = true, coarse = true, rationaleBefore = false, rationaleAfter = false, askedBefore = false))
        assertEquals(Step.CONTINUE, PermissionDisclosure.step(fine = true, coarse = true, rationaleBefore = false, rationaleAfter = false, askedBefore = true))
    }

    @Test fun deniedInThePromptStops() {
        // First denial: Android now offers a rationale.
        assertEquals(Step.STOP, PermissionDisclosure.step(fine = false, coarse = false, rationaleBefore = false, rationaleAfter = true, askedBefore = false))
        // Second denial, which Android 11+ makes permanent: the prompt was shown (rationale before), so still no settings.
        assertEquals(Step.STOP, PermissionDisclosure.step(fine = false, coarse = false, rationaleBefore = true, rationaleAfter = false, askedBefore = true))
        // A first prompt dismissed without an answer is not "denied without UI".
        assertEquals(Step.STOP, PermissionDisclosure.step(fine = false, coarse = false, rationaleBefore = false, rationaleAfter = false, askedBefore = false))
    }

    @Test fun approximateStopsWithAMessage() {
        assertEquals(Step.APPROXIMATE, PermissionDisclosure.step(fine = false, coarse = true, rationaleBefore = false, rationaleAfter = true, askedBefore = false))
        assertEquals(Step.APPROXIMATE, PermissionDisclosure.step(fine = false, coarse = true, rationaleBefore = true, rationaleAfter = true, askedBefore = true))
    }

    @Test fun deniedWithoutSystemUiOpensSettingsOnce() {
        assertEquals(Step.SETTINGS, PermissionDisclosure.step(fine = false, coarse = false, rationaleBefore = false, rationaleAfter = false, askedBefore = true))
        assertEquals(Step.SETTINGS, PermissionDisclosure.step(fine = false, coarse = true, rationaleBefore = false, rationaleAfter = false, askedBefore = true))
    }
}
