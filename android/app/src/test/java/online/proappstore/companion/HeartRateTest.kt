package online.proappstore.companion

import org.junit.Assert.*
import org.junit.Test

/**
 * #634: the parser vectors are copied verbatim from iOS HeartRateTests.swift (#631); keep the two lists identical.
 * Plus the sample policy, chart bucketing, activity text, the collector service's type selection and the strap link (#672).
 */
class HeartRateTest {
    private fun parse(vararg bytes: Int) = HeartRateMeasurement.parse(ByteArray(bytes.size) { bytes[it].toByte() })

    @Test fun eightBitValue() { assertEquals(HeartRateMeasurement.Reading(72, null), parse(0x00, 72)) }

    @Test fun sixteenBitValue() {
        assertEquals(142, parse(0x01, 0x8E, 0x00)!!.bpm) // little-endian
        assertEquals(250, parse(0x01, 0xFA, 0x00)!!.bpm)
    }

    @Test fun contactUnsupportedIsNull() { assertNull("bit 1 without bit 2 means nothing", parse(0x02, 90)!!.contact) }

    @Test fun contactSupportedDetectedAndNotDetected() {
        assertEquals(true, parse(0x06, 90)!!.contact)
        assertEquals(false, parse(0x04, 90)!!.contact)
    }

    @Test fun energyAndRrPresentStillReadTheValue() {
        // flags: 8-bit, contact detected, energy expended (bit 3) and RR (bit 4): value, energy u16, two RR u16.
        assertEquals(HeartRateMeasurement.Reading(131, true), parse(0x1E, 131, 0x10, 0x00, 0x00, 0x02, 0x10, 0x02))
        assertEquals(155, parse(0x19, 0x9B, 0x00, 0x10, 0x00, 0x00, 0x02)!!.bpm)
    }

    @Test fun shortOrOutOfRangeDataIsNull() {
        assertNull(parse())
        assertNull(parse(0x00))
        assertNull("16-bit flag with one value byte", parse(0x01, 0x8E))
        assertNull(parse(0x00, 24))
        assertNull("251", parse(0x01, 0xFB, 0x00))
        assertNull(parse(0x00, 0))
        assertEquals(25, parse(0x00, 25)!!.bpm)
    }

    @Test fun policyRejectsNoContactAndThrottlesToOneHertz() {
        val policy = HeartRatePolicy()
        assertFalse(policy.accept(false, 0))
        assertTrue("a rejected reading does not start the throttle", policy.accept(true, 0))
        assertFalse(policy.accept(true, 999))
        assertTrue(policy.accept(null, 1_000))
        assertFalse(policy.accept(null, 1_500))
        assertTrue(policy.accept(true, 2_100))
    }

    private fun entry(app: String, capability: String, grant: String?, consentAt: Long = 1) =
        NativeEntry(app, app, capability, "n", "p", "d", "v", grant, consentAt)

    @Test fun recipientsAreHeartRateGrantsNotDisabledPausedOrBeforeConsent() {
        val entries = listOf(entry("run", "heart_rate.ble", "hr"), entry("run", "location.background", "loc"),
            entry("other", "heart_rate.ble", null), entry("late", "heart_rate.ble", "late", 50))
        assertEquals(listOf("hr"), HeartRatePolicy.recipients(entries, emptySet(), emptySet(), 10))
        assertEquals(listOf("hr", "late"), HeartRatePolicy.recipients(entries, emptySet(), emptySet(), 50))
        assertEquals("location's key leaves heart rate", listOf("hr"), HeartRatePolicy.recipients(entries, setOf("run"), emptySet(), 10))
        assertEquals(emptyList<String>(), HeartRatePolicy.recipients(entries, setOf("run/heart_rate.ble"), emptySet(), 10))
        assertEquals("pausing Run pauses its heart rate (#626)", emptyList<String>(), HeartRatePolicy.recipients(entries, emptySet(), setOf("run"), 10))
    }

    @Test fun entryKeysAndGrantPathsStayUnderNative() {
        assertEquals("run", entry("run", "location.background", null).key)
        assertEquals("run/heart_rate.ble", entry("run", "heart_rate.ble", null).key)
        assertEquals("/native/apps/run/location", CompanionRepository.grantPath("run"))
        assertEquals("/native/apps/run/capabilities/heart_rate.ble", CompanionRepository.grantPath("run/heart_rate.ble"))
    }

    // Chart

    @Test fun bucketsAverageAndBoundEachBucketAndKeepGaps() {
        val samples = listOf(HeartRatePoint(0, 100), HeartRatePoint(5, 110), HeartRatePoint(12, 120),
            HeartRatePoint(41, 150), HeartRatePoint(100, 90), HeartRatePoint(101, 200))
        val b = HeartRateChart.buckets(samples, 0L..100L, 10)
        assertEquals(listOf(0L, 10L, 40L, 90L), b.map { it.start })
        assertEquals(HeartRateBucket(0, 10, 100, 110, 105, 0), b[0])
        assertEquals("an empty bucket breaks the line", listOf(0, 0, 1, 2), b.map { it.segment })
        assertEquals("the upper bound falls in the last bucket; a sample past it is ignored", 90, b.last().mean)
    }

    @Test fun bucketsOfAnEmptyOrDegenerateRange() {
        assertEquals(emptyList<HeartRateBucket>(), HeartRateChart.buckets(emptyList(), 0L..100L))
        assertEquals(emptyList<HeartRateBucket>(), HeartRateChart.buckets(listOf(HeartRatePoint(5, 80)), 5L..5L))
        assertEquals("width never below 1 ms", listOf(2L), HeartRateChart.buckets(listOf(HeartRatePoint(2, 80)), 0L..3L, 120).map { it.start })
    }

    // Activity text: the same sentences as iOS.

    private fun sentence(kind: ShareEvent.Kind, detail: String, app: String? = null) =
        ActivityText.sentence(ShareEvent(1, 0, app, kind, detail), if (app == null) null else "Run")

    @Test fun heartRateEventText() {
        assertEquals("Run heart rate turned on", sentence(ShareEvent.Kind.HEART_RATE, "enabled", "run"))
        assertEquals("Run heart rate turned off", sentence(ShareEvent.Kind.HEART_RATE, "disabled", "run"))
        assertEquals("Heart-rate sensor chosen", sentence(ShareEvent.Kind.HEART_RATE, "sensor_chosen"))
        assertEquals("Heart-rate sensor connected", sentence(ShareEvent.Kind.HEART_RATE, "connected"))
        assertEquals("Heart-rate sensor disconnected or out of range", sentence(ShareEvent.Kind.HEART_RATE, "lost"))
        assertEquals("Heart-rate sensor forgotten", sentence(ShareEvent.Kind.HEART_RATE, "forgotten"))
        assertEquals("Heart-rate queue full: heart rate stopped until uploads catch up", sentence(ShareEvent.Kind.HEART_RATE_PROBLEM, "queue_full"))
        assertEquals("Heart-rate upload rejected by ProAppStore (400)", sentence(ShareEvent.Kind.HEART_RATE_PROBLEM, "400"))
        assertEquals("Heart-rate upload not fully acknowledged: the copy on this phone was kept", sentence(ShareEvent.Kind.HEART_RATE_PROBLEM, "partial_ack"))
        assertEquals("Bluetooth turned off: heart rate stopped", sentence(ShareEvent.Kind.BLUETOOTH, "off"))
        assertEquals("Bluetooth permission denied: heart rate stopped", sentence(ShareEvent.Kind.BLUETOOTH, "unauthorized"))
        assertEquals(ActivityText.Category.SHARING, ActivityText.category(ShareEvent.Kind.HEART_RATE))
        assertEquals(ActivityText.Category.PROBLEM, ActivityText.category(ShareEvent.Kind.HEART_RATE_PROBLEM))
        assertEquals(ActivityText.Category.PROBLEM, ActivityText.category(ShareEvent.Kind.BLUETOOTH))
        assertEquals(ShareEvent.Kind.HEART_RATE_PROBLEM, ShareEvent.Kind.of("heart_rate_problem"))
    }

    /** Heart-rate events never open, end or pause a location session. */
    @Test fun heartRateEventsLeaveLocationSessionsAlone() {
        val events = listOf(ShareEvent(1, 10, "run", ShareEvent.Kind.ENABLED, ""), ShareEvent(2, 20, "run", ShareEvent.Kind.HEART_RATE, "disabled"),
            ShareEvent(3, 30, null, ShareEvent.Kind.BLUETOOTH, "off"), ShareEvent(4, 40, "run", ShareEvent.Kind.HEART_RATE, "enabled"))
        val sessions = SharingTimeline.sessions(events, "run")
        assertEquals(1, sessions.size)
        assertEquals(10L, sessions[0].start); assertNull(sessions[0].end); assertTrue(sessions[0].inactive.isEmpty())
    }

    // The one foreground service (#634)

    @Test fun onlyPermittedActiveTypesAreStarted() {
        assertEquals(CollectorTypes(location = true, connectedDevice = true), CollectorTypes.select(true, true, true, true))
        // BLUETOOTH_CONNECT revoked while running: heart rate drops, location continues (criterion 3).
        assertEquals(CollectorTypes(location = true, connectedDevice = false), CollectorTypes.select(true, true, false, true))
        // Heart rate only: no location type, so no location permission is needed to start.
        assertEquals(CollectorTypes(location = false, connectedDevice = true), CollectorTypes.select(false, false, true, true))
        assertEquals(CollectorTypes(location = false, connectedDevice = true), CollectorTypes.select(false, true, true, true))
        assertFalse(CollectorTypes.select(true, false, true, false).any)
        assertFalse(CollectorTypes.select(false, true, false, true).any)
    }

    // The strap's connection across Bluetooth off and on (#672). next(wanted, bluetoothOn, open, sameAddress)

    @Test fun bluetoothOffWithNoConnectionWaits() {
        assertEquals(HeartRateLink.KEEP, HeartRateLink.next(wanted = true, bluetoothOn = false, open = false, sameAddress = false))
    }

    @Test fun bluetoothOnWithNoConnectionConnects() {
        assertEquals(HeartRateLink.CONNECT, HeartRateLink.next(wanted = true, bluetoothOn = true, open = false, sameAddress = false))
    }

    @Test fun anOpenConnectionClosesWhenBluetoothGoesOff() {
        assertEquals(HeartRateLink.CLOSE, HeartRateLink.next(wanted = true, bluetoothOn = false, open = true, sameAddress = true))
    }

    @Test fun aWrapperThatNeverOpenedIsReplacedOnceBluetoothIsOn() {
        // connectGatt returned null with Bluetooth off: the same address must not count as connected (scenario 1).
        assertEquals(HeartRateLink.CONNECT, HeartRateLink.next(wanted = true, bluetoothOn = true, open = false, sameAddress = true))
    }

    @Test fun aDifferentSensorClosesBeforeItConnects() {
        assertEquals(HeartRateLink.CLOSE, HeartRateLink.next(wanted = true, bluetoothOn = true, open = true, sameAddress = false))
        // Asked again after the close: now nothing is open, so one new client, never two.
        assertEquals(HeartRateLink.CONNECT, HeartRateLink.next(wanted = true, bluetoothOn = true, open = false, sameAddress = false))
    }

    @Test fun anOpenConnectionToTheChosenSensorIsKept() {
        assertEquals(HeartRateLink.KEEP, HeartRateLink.next(wanted = true, bluetoothOn = true, open = true, sameAddress = true))
    }

    @Test fun notWantedClosesAndNeverConnects() {
        assertEquals(HeartRateLink.CLOSE, HeartRateLink.next(wanted = false, bluetoothOn = true, open = true, sameAddress = true))
        assertEquals(HeartRateLink.KEEP, HeartRateLink.next(wanted = false, bluetoothOn = true, open = false, sameAddress = false))
    }

    @Test fun theNotificationSaysWhatIsShared() {
        assertEquals("Sharing location and heart rate with Run", CollectorTypes.notificationText(listOf("Run"), listOf("Run")))
        assertEquals("Sharing location with Ski, Run and heart rate with Run", CollectorTypes.notificationText(listOf("Ski", "Run"), listOf("Run")))
        assertEquals("Sharing heart rate with Run", CollectorTypes.notificationText(emptyList(), listOf("Run")))
        assertEquals("Sharing location with Ski", CollectorTypes.notificationText(listOf("Ski"), emptyList()))
    }

    @Test fun heartRateLineState() {
        val hr = entry("run", "heart_rate.ble", "hr")
        val on = CompanionState(signedIn = true, entries = listOf(hr), paused = false, heartRateSensor = true, heartRateConnected = true, heartRateBpm = 142, now = 10)
        assertEquals("Connected · 142 bpm", on.heartRateState(hr))
        assertEquals("Paused", on.copy(pausedApps = setOf("run")).heartRateState(hr))
        assertEquals("Paused", on.copy(paused = true).heartRateState(hr))
        assertEquals("No sensor chosen", on.copy(heartRateSensor = false).heartRateState(hr))
        assertEquals("Bluetooth permission needed", on.copy(bluetooth = "unauthorized").heartRateState(hr))
        assertEquals("Not connected", on.copy(heartRateConnected = false).heartRateState(hr))
        assertEquals("Turning off…", on.copy(blocked = setOf("run/heart_rate.ble")).heartRateState(hr))
        assertEquals("Off", on.heartRateState(entry("run", "heart_rate.ble", null)))
        assertEquals("location's block is not heart rate's", "Connected · 142 bpm", on.copy(blocked = setOf("run")).heartRateState(hr))
    }
}
