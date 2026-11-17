package app.cadence.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class CadenceSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        return try {
            CadenceSync.fetchAndSave(applicationContext)
            CadenceWidgetProvider.updateAllWidgets(applicationContext)
            Result.success()
        } catch (_: IllegalArgumentException) {
            CadenceWidgetProvider.updateAllWidgets(applicationContext)
            Result.failure()
        } catch (_: Exception) {
            CadenceWidgetProvider.updateAllWidgets(applicationContext)
            Result.retry()
        }
    }

    companion object {
        private const val PERIODIC_WORK_NAME = "cadence_widget_periodic_sync"
        private const val IMMEDIATE_WORK_NAME = "cadence_widget_immediate_sync"

        fun schedulePeriodic(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val req = PeriodicWorkRequestBuilder<CadenceSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                req
            )
        }

        fun triggerImmediate(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val req = OneTimeWorkRequestBuilder<CadenceSyncWorker>()
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                req
            )
        }
    }
}
