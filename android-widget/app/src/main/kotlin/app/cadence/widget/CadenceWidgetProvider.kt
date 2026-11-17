package app.cadence.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class CadenceWidgetProvider : AppWidgetProvider() {

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        CadenceSyncWorker.schedulePeriodic(context)
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        CadenceSyncWorker.schedulePeriodic(context)
        renderIds(context, appWidgetManager, appWidgetIds, syncing = false)
        refreshAsync(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            ACTION_REFRESH -> {
                updateAllWidgets(context, syncing = true)
                refreshAsync(context)
            }
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_DATE_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED -> {
                CadenceSyncWorker.schedulePeriodic(context)
                updateAllWidgets(context, syncing = false)
                refreshAsync(context)
            }
        }
    }

    private fun refreshAsync(context: Context) {
        val appCtx = context.applicationContext
        val pendingResult = goAsync()
        bgExecutor.execute {
            try {
                CadenceSync.fetchAndSave(appCtx)
            } catch (_: Exception) {
                // Keep cached stats on transient offline error
            } finally {
                updateAllWidgets(appCtx, syncing = false)
                pendingResult.finish()
            }
        }
    }

    companion object {
        const val ACTION_REFRESH = "app.cadence.widget.ACTION_REFRESH"
        private val bgExecutor = Executors.newSingleThreadExecutor()

        fun getActiveWidgetIds(context: Context): IntArray {
            val mgr = AppWidgetManager.getInstance(context)
            val comp = ComponentName(context, CadenceWidgetProvider::class.java)
            return mgr.getAppWidgetIds(comp)
        }

        fun updateAllWidgets(context: Context, syncing: Boolean = false) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = getActiveWidgetIds(context)
            if (ids.isNotEmpty()) {
                renderIds(context, mgr, ids, syncing)
            }
        }

        private fun renderIds(
            context: Context,
            mgr: AppWidgetManager,
            ids: IntArray,
            syncing: Boolean
        ) {
            val cfg = CadenceSync.getConfig(context)
            val stats = CadenceSync.computeCachedStats(context)
            for (id in ids) {
                mgr.updateAppWidget(id, buildRemoteViews(context, id, cfg, stats, syncing))
            }
        }

        private fun buildRemoteViews(
            context: Context,
            appWidgetId: Int,
            cfg: CadenceSync.WidgetConfig,
            stats: CadenceSync.WidgetStats,
            syncing: Boolean
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_cadence_2x2)

            val outerBg = if (!stats.configured || stats.studiedToday) {
                R.drawable.widget_bg_lit
            } else {
                R.drawable.widget_bg_nudge
            }
            views.setInt(R.id.widget_root, "setBackgroundResource", outerBg)

            if (!stats.configured) {
                views.setTextViewText(R.id.tv_streak, "🔑 Link")
                views.setTextColor(R.id.tv_streak, Color.parseColor("#F59E0B"))
            } else if (stats.studiedToday) {
                views.setTextViewText(R.id.tv_streak, "🔥 ${stats.streak}d")
                views.setTextColor(R.id.tv_streak, Color.parseColor("#F59E0B"))
            } else {
                views.setTextViewText(R.id.tv_streak, "🕯️ ${stats.streak}d")
                views.setTextColor(R.id.tv_streak, Color.parseColor("#94A3B8"))
            }

            views.setTextViewText(R.id.tv_days_left, CadenceSync.formatDaysLeft(stats.daysLeft))
            views.setTextViewText(R.id.btn_refresh, if (syncing) "⋯" else "↻")

            if (!stats.configured) {
                views.setTextViewText(R.id.tv_today_time, "Tap")
                views.setTextViewText(R.id.tv_today_goal, " to setup")
            } else {
                views.setTextViewText(R.id.tv_today_time, CadenceSync.formatMinutes(stats.todaySecs))
                views.setTextViewText(R.id.tv_today_goal, " / ${stats.goalMins}m")
            }

            val goalSecs = maxOf(1, stats.goalMins) * 60
            val rawPct = ((stats.todaySecs.toDouble() / goalSecs.toDouble()) * 100.0).roundToInt()
            val barPct = when {
                !stats.configured -> 0
                stats.studiedToday -> rawPct.coerceIn(8, 100)
                else -> rawPct.coerceIn(0, 100)
            }

            if (stats.studiedToday) {
                views.setViewVisibility(R.id.pb_today_lit, View.VISIBLE)
                views.setViewVisibility(R.id.pb_today_warm, View.GONE)
                views.setProgressBar(R.id.pb_today_lit, 100, barPct, false)
            } else {
                views.setViewVisibility(R.id.pb_today_lit, View.GONE)
                views.setViewVisibility(R.id.pb_today_warm, View.VISIBLE)
                views.setProgressBar(R.id.pb_today_warm, 100, barPct, false)
            }

            // Tap ↻ -> immediate background sync
            val refreshIntent = Intent(context, CadenceWidgetProvider::class.java).apply {
                action = ACTION_REFRESH
            }
            val refreshPi = PendingIntent.getBroadcast(
                context,
                appWidgetId + 10_000,
                refreshIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.btn_refresh, refreshPi)

            // Tap widget body -> open Cadence web app (or setup screen if not yet configured)
            val openIntent = if (stats.configured && cfg.webUrl.startsWith("http")) {
                Intent(Intent.ACTION_VIEW, Uri.parse(cfg.webUrl)).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            } else {
                Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
            }
            val openPi = PendingIntent.getActivity(
                context,
                appWidgetId + 20_000,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_root, openPi)

            return views
        }
    }
}
