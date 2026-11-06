package online.proappstore.companion

import android.app.Application
import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class PasApplication : Application() {
    val local by lazy { LocalStore(this) }
    val repository by lazy { CompanionRepository(local, SecureStore(this), PasApi()) }
    override fun onCreate() {
        super.onCreate()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("native-upload", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
}
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        (applicationContext as PasApplication).repository.sync(); Result.success()
    } catch (_: Exception) { Result.retry() }
}
