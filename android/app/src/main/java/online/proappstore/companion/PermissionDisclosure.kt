package online.proappstore.companion

/**
 * The prominent disclosure shown before the location request (#663, Play's User Data policy), and what follows the
 * request. Pure, so both are unit-tested off-device.
 */
object PermissionDisclosure {
    const val TITLE = "Allow precise location"
    const val APPROXIMATE = "Approximate location can't record a route. Choose Precise location."
    const val SETTINGS = "Open Permissions → Location → Allow only while using the app, and turn on Use precise location"

    /**
     * One bullet per location entry of `/native/me` (`state.apps`), enabled or not: the purposes are reviewed catalog text,
     * so the next app appears here without a release.
     */
    fun body(apps: List<ConnectedApp>): String = buildString {
        append("ProAppStore collects your precise location while a sharing session you start is running, including while your phone is locked and ProAppStore and the apps are closed. It is used for:")
        apps.forEach { append("\n• ${it.name}: ${it.purpose}") }
        append("\n\nYour location goes to ProAppStore and only to the apps you turn on here. It is never used for advertising. A session ends when you tap Stop, after 30 minutes without moving, or after 12 hours.")
    }

    enum class Step {
        /** Precise granted: continue the pending Start. */
        CONTINUE,
        /** Denied in the system prompt: nothing more. */
        STOP,
        /** Approximate only: say so ([APPROXIMATE]) and start nothing. */
        APPROXIMATE,
        /** Android answered without showing its prompt (denied before, twice): App info, with [SETTINGS]. */
        SETTINGS,
    }

    /**
     * What follows one FINE+COARSE request. `rationaleBefore`/`rationaleAfter` are `shouldShowRequestPermissionRationale`
     * for FINE around the request; `askedBefore` whether ProAppStore requested it before. Asked before with no rationale on
     * either side means Android showed nothing. A first request dismissed without an answer is STOP, not SETTINGS. No step
     * requests again, so a denial never loops.
     */
    fun step(fine: Boolean, coarse: Boolean, rationaleBefore: Boolean, rationaleAfter: Boolean, askedBefore: Boolean): Step = when {
        fine -> Step.CONTINUE
        askedBefore && !rationaleBefore && !rationaleAfter -> Step.SETTINGS
        coarse -> Step.APPROXIMATE
        else -> Step.STOP
    }
}
