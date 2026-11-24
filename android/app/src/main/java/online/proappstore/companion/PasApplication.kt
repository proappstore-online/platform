package online.proappstore.companion

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.work.*
import java.util.concurrent.TimeUnit

class PasApplication : Application() {
    val local by lazy { LocalStore(this) }
    val repository by lazy { CompanionRepository(local, SecureStore(this), PasApi()) { diagnosticsDevice() } }
    /** The public storefront (#627): credential-free, outside the companion's database, so it survives disconnect. */
    val catalogue by lazy { CatalogueStore(CatalogueStore.directory(this)) }
    val images by lazy { ImageCache(ImageCache.directory(this)) }
    override fun onCreate() {
        super.onCreate()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("native-upload", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    /** The diagnostics report's system state (#660), read as MainActivity.read() reads it. */
    private fun diagnosticsDevice(): DiagnosticsDevice {
        val power = getSystemService(PowerManager::class.java)
        val notifications = when {
            Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED -> "allowed"
            // MainActivity asks once and remembers it here.
            getSharedPreferences("native-permission-prompts", MODE_PRIVATE).getBoolean("notifications", false) -> "denied"
            else -> "notDetermined"
        }
        return DiagnosticsDevice(
            os = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            location = LocationService.permissionState(this), precise = LocationService.allowed(this),
            bluetooth = Bluetooth.state(this), notifications = notifications,
            batteryOptimized = !power.isIgnoringBatteryOptimizations(packageName), powerSave = power.isPowerSaveMode,
            locationServices = getSystemService(LocationManager::class.java).isLocationEnabled,
            collecting = LocationService.running, heartRateConnected = LocationService.heartRateConnected)
    }
}
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        (applicationContext as PasApplication).repository.sync(); Result.success()
    } catch (_: Exception) { Result.retry() }
}
