package online.proappstore.companion

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.UUID

/** Run's strap heart rate (#634, parity for iOS #631): the `heart_rate.ble` capability id and its Bluetooth UUIDs. */
object HeartRate {
    const val CAPABILITY = "heart_rate.ble"
    const val SERVICE = "0000180d-0000-1000-8000-00805f9b34fb"
    const val MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb"
    /** Client Characteristic Configuration: written to enable notifications. */
    const val CCCD = "00002902-0000-1000-8000-00805f9b34fb"
}

/** One Heart Rate Measurement (GATT 0x2A37) notification, per the Heart Rate Service spec. Pure; ported from iOS HeartRate.swift. */
object HeartRateMeasurement {
    /** `contact` is null when the sensor does not report contact. */
    data class Reading(val bpm: Int, val contact: Boolean?)

    /**
     * Flags bit 0: 16-bit value; bit 2: contact supported, bit 1: contact detected; bits 3-4: energy expended and RR
     * intervals follow the value (ignored). Null for short or malformed data, or bpm outside 25-250.
     */
    fun parse(data: ByteArray): Reading? {
        val flags = data.firstOrNull()?.toInt()?.and(0xFF) ?: return null
        val wide = flags and 0x01 != 0
        if (data.size < (if (wide) 3 else 2)) return null
        val bpm = if (wide) (data[1].toInt() and 0xFF) or ((data[2].toInt() and 0xFF) shl 8) else data[1].toInt() and 0xFF
        if (bpm !in 25..250) return null
        return Reading(bpm, if (flags and 0x04 != 0) flags and 0x02 != 0 else null)
    }
}

/** Which parsed readings become samples: contact detected or not reported, at most one a second. Fed in delivery order. */
class HeartRatePolicy {
    private var lastAt: Long? = null

    fun accept(contact: Boolean?, at: Long): Boolean {
        if (contact == false) return false
        lastAt?.let { if (at - it < MIN_INTERVAL_MS) return false }
        lastAt = at
        return true
    }

    companion object {
        /** 100,000 pending samples, about 28 h at 1 Hz: collection stops visibly, like location's 60,000. */
        const val MAX_QUEUE = 100_000
        const val MIN_INTERVAL_MS = 1_000L
        /** On-device history cap (#621's rule for points). */
        const val HISTORY_MAX_SAMPLES = 200_000

        /** The heart-rate grants current at `at`: neither the entry is disabled nor its app paused (#626). */
        fun recipients(entries: List<NativeEntry>, blocked: Set<String>, pausedApps: Set<String>, at: Long): List<String> = entries
            .filter { it.capability == HeartRate.CAPABILITY && it.key !in blocked && it.appId !in pausedApps && at >= it.consentAt }
            .mapNotNull { it.grantId }
    }
}

/** One queued reading. Serialises to exactly the `POST /native/heart-rate` sample shape. */
data class HeartRateSample(val id: String, val at: Long, val bpm: Int, val grants: List<String>)

/** One sample of the on-device heart-rate history. */
data class HeartRatePoint(val at: Long, val bpm: Int)

/** A chart bucket: the samples in `[start, end)`. `segment` changes after an empty bucket, so a gap stays a gap. */
data class HeartRateBucket(val start: Long, val end: Long, val min: Int, val max: Int, val mean: Int, val segment: Int)

/** The bpm chart on a session's time axis. Pure; the same bucketing as iOS. */
object HeartRateChart {
    /** `samples` cut into `count` equal buckets over `range`; empty buckets are omitted, samples outside `range` ignored. */
    fun buckets(samples: List<HeartRatePoint>, range: LongRange, count: Int = 120): List<HeartRateBucket> {
        val span = range.last - range.first
        if (count <= 0 || span <= 0) return emptyList()
        val width = maxOf(1L, (span + count - 1) / count)
        val groups = sortedMapOf<Long, MutableList<Int>>()
        for (s in samples) if (s.at in range) groups.getOrPut(minOf((s.at - range.first) / width, count - 1L)) { mutableListOf() }.add(s.bpm)
        var segment = 0; var previous: Long? = null
        return groups.map { (index, bpm) ->
            if (previous != null && index != previous!! + 1) segment++
            previous = index
            val start = range.first + index * width
            HeartRateBucket(start, start + width, bpm.min(), bpm.max(), Math.round(bpm.sum().toDouble() / bpm.size).toInt(), segment)
        }
    }
}

/**
 * The one collector service's foreground types (#634): only the types whose permission is held and that have an active
 * grant. Starting with a type whose permission is missing throws SecurityException on Android 14. Pure.
 */
data class CollectorTypes(val location: Boolean, val connectedDevice: Boolean) {
    val any: Boolean get() = location || connectedDevice

    companion object {
        fun select(locationPermitted: Boolean, locationActive: Boolean, bluetoothPermitted: Boolean, heartRateActive: Boolean) =
            CollectorTypes(locationPermitted && locationActive, bluetoothPermitted && heartRateActive)

        /** "Sharing location and heart rate with Run", from the apps each active type shares with. */
        fun notificationText(locationApps: List<String>, heartRateApps: List<String>): String {
            val loc = locationApps.distinct(); val hr = heartRateApps.distinct()
            return when {
                loc.isNotEmpty() && hr.isNotEmpty() && loc.toSet() == hr.toSet() -> "Sharing location and heart rate with ${loc.joinToString()}"
                loc.isNotEmpty() && hr.isNotEmpty() -> "Sharing location with ${loc.joinToString()} and heart rate with ${hr.joinToString()}"
                hr.isNotEmpty() -> "Sharing heart rate with ${hr.joinToString()}"
                else -> "Sharing location with ${loc.joinToString()}"
            }
        }
    }
}

/**
 * What the collector does with the strap's connection (#672). Pure, so the decision is tested off-device. `wanted`: the
 * heart-rate type runs and a sensor is chosen. `open`: a [HeartRateGatt] exists whose `connectGatt` returned a connection
 * (one that never opened, because Bluetooth was off, counts as none). `sameAddress`: that connection is to the chosen sensor.
 * A changed sensor is [CLOSE], then, asked again with nothing open, [CONNECT]: never two clients on one strap.
 */
enum class HeartRateLink {
    KEEP, CONNECT, CLOSE;

    companion object {
        fun next(wanted: Boolean, bluetoothOn: Boolean, open: Boolean, sameAddress: Boolean): HeartRateLink = when {
            open && (!wanted || !bluetoothOn || !sameAddress) -> CLOSE
            !open && wanted && bluetoothOn -> CONNECT
            else -> KEEP
        }
    }
}

/**
 * The chosen strap's GATT connection, owned by the collector service. `connectGatt(autoConnect = true)` to the remembered
 * address: Android keeps reconnecting whenever the strap is in range until [close], with the screen off. Notifications on
 * 0x2A37 are enabled by writing CCCD 0x2902. Callers check [Bluetooth.permitted] first. A Bluetooth restart leaves the
 * client registered with the stopped stack, so the collector closes this and makes a new one ([HeartRateLink], #672).
 */
class HeartRateGatt(private val context: Context, val address: String, private val onReading: (ByteArray) -> Unit, private val onConnected: (Boolean) -> Unit) {
    private var gatt: BluetoothGatt? = null
    @Volatile var connected = false
        private set
    /** `connectGatt` returned a connection. False before [connect], after [close], and when Bluetooth was off (AOSP returns null). */
    val opened: Boolean get() = gatt != null

    private val callback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission") // only reached after connect(), which checked
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            connected = newState == BluetoothProfile.STATE_CONNECTED
            onConnected(connected)
            if (connected && Bluetooth.permitted(context)) gatt.discoverServices()
        }
        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (!Bluetooth.permitted(context)) return
            val c = gatt.getService(UUID.fromString(HeartRate.SERVICE))?.getCharacteristic(UUID.fromString(HeartRate.MEASUREMENT)) ?: return
            gatt.setCharacteristicNotification(c, true)
            val cccd = c.getDescriptor(UUID.fromString(HeartRate.CCCD)) ?: return
            if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            else @Suppress("DEPRECATION") run { cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; gatt.writeDescriptor(cccd) }
        }
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (characteristic.uuid == UUID.fromString(HeartRate.MEASUREMENT)) onReading(value)
        }
        @Deprecated("Android 12L and lower")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            // Android 13+ calls the overload above instead; this one runs on 12L and lower only.
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT < 33 && characteristic.uuid == UUID.fromString(HeartRate.MEASUREMENT)) characteristic.value?.let(onReading)
        }
    }

    @SuppressLint("MissingPermission")
    fun connect() {
        if (gatt != null || !Bluetooth.permitted(context)) return
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: return
        gatt = adapter.getRemoteDevice(address).connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
    }

    @SuppressLint("MissingPermission")
    fun close() {
        if (Bluetooth.permitted(context)) gatt?.close()
        gatt = null; connected = false
    }
}

/** Bluetooth permission and power. */
object Bluetooth {
    /** Connect permission: runtime `BLUETOOTH_CONNECT` on Android 12+, install-time `BLUETOOTH` before. */
    fun permitted(context: Context): Boolean = Build.VERSION.SDK_INT < 31 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    /** What the "Choose sensor" scan needs: `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` on 12+, fine location before (a platform rule for BLE scans). */
    fun scanPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    fun canScan(context: Context): Boolean = scanPermissions().all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    fun on(context: Context): Boolean = context.getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true
    /** The activity-log state: `unauthorized`, `off` or `on`. */
    fun state(context: Context): String = when { !permitted(context) -> "unauthorized"; !on(context) -> "off"; else -> "on" }
    /** Activity log: a Bluetooth change since the last look, never the first report. */
    fun note(context: Context, local: LocalStore) {
        val now = state(context); val old = local.bluetoothState
        if (old == now) return
        if (old.isNotEmpty()) runCatching { local.record(ShareEvent.Kind.BLUETOOTH, detail = now) }
        local.bluetoothState = now
    }
}
