package app.cadence.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var configureWidgetId: Int = AppWidgetManager.INVALID_APPWIDGET_ID

    private lateinit var statusCard: LinearLayout
    private lateinit var statusHeadline: TextView
    private lateinit var statusDetail: TextView
    private lateinit var keyInput: EditText
    private lateinit var goalInput: EditText
    private lateinit var targetInput: EditText
    private lateinit var urlInput: EditText
    private lateinit var primaryBtn: Button
    private lateinit var syncBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        configureWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        val existingCfg = CadenceSync.getConfig(this)
        if (configureWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID && existingCfg.accessKey.isNotBlank()) {
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, configureWidgetId))
        }

        buildUi(existingCfg)
        refreshStatusBanner(CadenceSync.computeCachedStats(this), null)
        CadenceSyncWorker.schedulePeriodic(this)

        if (!handleDeepLinkIfPresent(intent) && existingCfg.accessKey.isNotBlank()) {
            runLiveSync(pinIfNeeded = false, finishConfigure = false)
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLinkIfPresent(intent)
    }

    private fun handleDeepLinkIfPresent(incoming: Intent?): Boolean {
        val data = incoming?.data ?: return false
        if (data.scheme != "cadencewidget") return false

        var pairKey = data.getQueryParameter("key").orEmpty()
        var pairUrl = data.getQueryParameter("url").orEmpty()
        var pairTarget = data.getQueryParameter("target").orEmpty()
        var pairGoal = data.getQueryParameter("goal")?.toIntOrNull()

        val code = data.getQueryParameter("code")
        if (!code.isNullOrBlank()) {
            try {
                val decoded = String(
                    Base64.decode(code, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
                    StandardCharsets.UTF_8
                )
                val obj = JSONObject(decoded)
                if (pairKey.isBlank()) pairKey = obj.optString("k", "")
                if (pairUrl.isBlank()) pairUrl = obj.optString("u", "")
                if (pairTarget.isBlank()) pairTarget = obj.optString("t", "")
                if (pairGoal == null && obj.has("g")) pairGoal = obj.optInt("g", 45)
            } catch (_: Exception) {
                // Ignore malformed code parameter
            }
        }

        if (pairKey.isNotBlank()) keyInput.setText(pairKey.trim())
        if (pairGoal != null) goalInput.setText(pairGoal.coerceIn(5, 600).toString())
        if (pairTarget.isNotBlank()) targetInput.setText(pairTarget.trim())
        if (pairUrl.isNotBlank()) urlInput.setText(pairUrl.trim())

        if (keyInput.text.toString().trim().isNotBlank()) {
            runLiveSync(pinIfNeeded = true, finishConfigure = false)
            return true
        }
        return false
    }

    private fun buildUi(cfg: CadenceSync.WidgetConfig) {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0F19"))
            isFillViewport = true
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padH = dp(20)
            val padV = dp(24)
            setPadding(padH, padV, padH, padV)
        }

        // Header Row
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val logo = ImageView(this).apply {
            setImageResource(R.drawable.ic_cadence_logo)
            background = roundedBox("#131A2A", "#283552", 14f, 1)
            clipToOutline = true
        }
        headerRow.addView(logo, LinearLayout.LayoutParams(dp(50), dp(50)))

        val titleCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, 0, 0)
        }
        titleCol.addView(TextView(this).apply {
            text = "Cadence Widget"
            setTextColor(Color.parseColor("#F1F5F9"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            typeface = Typeface.create("sans-serif-black", Typeface.BOLD)
        })
        titleCol.addView(TextView(this).apply {
            text = "2×2 Pixel Home Screen Streak & Focus"
            setTextColor(Color.parseColor("#94A3B8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
        })
        headerRow.addView(
            titleCol,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        root.addView(headerRow)

        // Live Widget Status Card
        statusCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBox("#131A2A", "#283552", 18f, 2)
            setPadding(dp(16), dp(14), dp(16), dp(14))
        }
        statusHeadline = TextView(this).apply {
            setTextColor(Color.parseColor("#F59E0B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            typeface = Typeface.create("sans-serif-black", Typeface.BOLD)
        }
        statusDetail = TextView(this).apply {
            setTextColor(Color.parseColor("#94A3B8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            setPadding(0, dp(4), 0, 0)
        }
        statusCard.addView(statusHeadline)
        statusCard.addView(statusDetail)
        root.addView(
            statusCard,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(18) }
        )

        // Form Card
        val formCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBox("#131A2A", "#283552", 18f, 1)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }

        // Access Key + Show/Hide toggle
        val keyHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        keyHeader.addView(makeFieldLabel("ACCESS KEY").apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        var keyVisible = false
        val toggleKeyBtn = TextView(this).apply {
            text = "Show"
            setTextColor(Color.parseColor("#818CF8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(8), dp(2), dp(4), dp(2))
        }
        keyHeader.addView(toggleKeyBtn)
        formCard.addView(keyHeader)

        keyInput = makeInput(
            initial = cfg.accessKey,
            hint = "Same access key used in Cadence",
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        )
        toggleKeyBtn.setOnClickListener {
            keyVisible = !keyVisible
            keyInput.inputType = if (keyVisible) {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            } else {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            keyInput.setSelection(keyInput.text?.length ?: 0)
            toggleKeyBtn.text = if (keyVisible) "Hide" else "Show"
        }
        formCard.addView(
            keyInput,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        )

        // Side-by-side Goal Minutes + Target Date
        val row2 = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }

        val goalCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        goalCol.addView(makeFieldLabel("DAILY GOAL (MIN)"))
        goalInput = makeInput(
            initial = cfg.goalMins.toString(),
            hint = "45",
            inputType = InputType.TYPE_CLASS_NUMBER
        )
        goalCol.addView(
            goalInput,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        )

        val targetCol = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        targetCol.addView(makeFieldLabel("TARGET DATE"))
        targetInput = makeInput(
            initial = cfg.targetDate,
            hint = CadenceSync.DEFAULT_TARGET_DATE,
            inputType = InputType.TYPE_CLASS_DATETIME or InputType.TYPE_DATETIME_VARIATION_DATE
        )
        targetCol.addView(
            targetInput,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        )

        row2.addView(
            goalCol,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = dp(6)
            }
        )
        row2.addView(
            targetCol,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(6)
            }
        )
        formCard.addView(
            row2,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )

        // Web App URL
        formCard.addView(
            makeFieldLabel("CADENCE APP URL (OPENED ON WIDGET TAP)"),
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )
        urlInput = makeInput(
            initial = cfg.webUrl,
            hint = "https://...",
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        )
        formCard.addView(
            urlInput,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        )

        // Primary Save / Pin Button
        val isConfigLaunch = configureWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID
        val hasActiveWidgets = CadenceWidgetProvider.getActiveWidgetIds(this).isNotEmpty()

        primaryBtn = Button(this).apply {
            isAllCaps = false
            text = when {
                isConfigLaunch -> "Connect & Save Widget"
                hasActiveWidgets -> "Save & Update Home Widget"
                else -> "Connect & Pin 2×2 Widget"
            }
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBox("#6366F1", "#818CF8", 14f, 1)
            setPadding(dp(14), dp(13), dp(14), dp(13))
            setOnClickListener {
                runLiveSync(pinIfNeeded = !isConfigLaunch, finishConfigure = isConfigLaunch)
            }
        }
        formCard.addView(
            primaryBtn,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(18) }
        )

        // Secondary Action Row: Sync Now + Open Cadence
        val secRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }

        syncBtn = Button(this).apply {
            isAllCaps = false
            text = "↻ Sync Now"
            setTextColor(Color.parseColor("#F1F5F9"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBox("#0B0F19", "#283552", 12f, 1)
            setOnClickListener {
                runLiveSync(pinIfNeeded = false, finishConfigure = false)
            }
        }

        val openAppBtn = Button(this).apply {
            isAllCaps = false
            text = "Open Cadence ↗"
            setTextColor(Color.parseColor("#818CF8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBox("#0B0F19", "#283552", 12f, 1)
            setOnClickListener {
                val targetUrl = urlInput.text?.toString()?.trim().orEmpty()
                if (targetUrl.startsWith("http")) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl)))
                }
            }
        }

        secRow.addView(
            syncBtn,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = dp(6)
            }
        )
        secRow.addView(
            openAppBtn,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(6)
            }
        )
        formCard.addView(
            secRow,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        )

        root.addView(
            formCard,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )

        // Security & Usage Note
        val footer = TextView(this).apply {
            text = "🔒 End-to-end AES-256-GCM decrypted locally on your Pixel. Auto-syncs every 15m in the background, or tap ↻ on the widget anytime."
            setTextColor(Color.parseColor("#64748B"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            setLineSpacing(0f, 1.25f)
        }
        root.addView(
            footer,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
        )

        scroll.addView(root)
        setContentView(scroll)
    }

    private fun runLiveSync(pinIfNeeded: Boolean, finishConfigure: Boolean) {
        val key = keyInput.text?.toString()?.trim().orEmpty()
        val goal = goalInput.text?.toString()?.trim()?.toIntOrNull() ?: CadenceSync.DEFAULT_GOAL_MINS
        val target = targetInput.text?.toString()?.trim()
            ?.takeIf { it.isNotEmpty() } ?: CadenceSync.DEFAULT_TARGET_DATE
        val webUrl = urlInput.text?.toString()?.trim().orEmpty()

        if (key.isBlank()) {
            statusCard.background = roundedBox("#131A2A", "#EF4444", 18f, 2)
            statusHeadline.setTextColor(Color.parseColor("#EF4444"))
            statusHeadline.text = "Access key required"
            statusDetail.text = "Enter your Cadence access key above so the widget can decrypt your streak."
            return
        }

        CadenceSync.saveConfig(this, key, goal, target, webUrl)
        CadenceSyncWorker.schedulePeriodic(this)

        primaryBtn.isEnabled = false
        syncBtn.isEnabled = false
        statusHeadline.setTextColor(Color.parseColor("#818CF8"))
        statusHeadline.text = "Syncing encrypted progress..."
        statusDetail.text = "Connecting to cloud sync & decrypting with AES-256-GCM..."

        val appCtx = applicationContext
        ioExecutor.execute {
            var syncError: String? = null
            val stats = try {
                CadenceSync.fetchAndSave(appCtx)
            } catch (e: Exception) {
                syncError = e.message ?: "Could not reach sync service."
                CadenceSync.computeCachedStats(appCtx)
            }

            CadenceWidgetProvider.updateAllWidgets(appCtx, syncing = false)

            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                primaryBtn.isEnabled = true
                syncBtn.isEnabled = true
                refreshStatusBanner(stats, syncError)

                if (syncError == null) {
                    if (configureWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                        val resIntent = Intent().putExtra(
                            AppWidgetManager.EXTRA_APPWIDGET_ID,
                            configureWidgetId
                        )
                        setResult(RESULT_OK, resIntent)
                        if (finishConfigure) {
                            finish()
                            return@runOnUiThread
                        }
                    }

                    val activeIds = CadenceWidgetProvider.getActiveWidgetIds(this)
                    if (pinIfNeeded && activeIds.isEmpty()) {
                        requestPinHomeWidget()
                    }
                    if (activeIds.isNotEmpty() && configureWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                        primaryBtn.text = "Save & Update Home Widget"
                    }
                }
            }
        }
    }

    private fun requestPinHomeWidget() {
        val mgr = AppWidgetManager.getInstance(this)
        if (mgr.isRequestPinAppWidgetSupported) {
            val provider = ComponentName(this, CadenceWidgetProvider::class.java)
            mgr.requestPinAppWidget(provider, null, null)
        }
    }

    private fun refreshStatusBanner(stats: CadenceSync.WidgetStats, err: String?) {
        if (err != null) {
            statusCard.background = roundedBox("#131A2A", "#EF4444", 18f, 2)
            statusHeadline.setTextColor(Color.parseColor("#EF4444"))
            statusHeadline.text = "⚠ Sync Error"
            statusDetail.text = err
            return
        }

        if (!stats.configured) {
            statusCard.background = roundedBox("#131A2A", "#F59E0B", 18f, 2)
            statusHeadline.setTextColor(Color.parseColor("#F59E0B"))
            statusHeadline.text = "🔑 Ready to Connect • ${CadenceSync.formatDaysLeft(stats.daysLeft)}"
            statusDetail.text = "Enter your Cadence access key below, or tap Auto-Link inside the Cadence web app."
            return
        }

        val borderHex = if (stats.studiedToday) "#10B981" else "#F59E0B"
        val icon = if (stats.studiedToday) "🔥" else "🕯️"
        val timeFmt = CadenceSync.formatMinutes(stats.todaySecs)
        val syncStamp = if (stats.lastSyncMillis > 0L) {
            "Synced " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(stats.lastSyncMillis))
        } else {
            "Ready"
        }

        statusCard.background = roundedBox("#131A2A", borderHex, 18f, 2)
        statusHeadline.setTextColor(
            Color.parseColor(if (stats.studiedToday) "#F59E0B" else "#F1F5F9")
        )
        statusHeadline.text = "$icon ${stats.streak}d streak  •  $timeFmt / ${stats.goalMins}m  •  ${CadenceSync.formatDaysLeft(stats.daysLeft)}"
        statusDetail.text = "✓ Connected ($syncStamp). Widget updates automatically on your home screen."
    }

    private fun makeFieldLabel(label: String): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(Color.parseColor("#94A3B8"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.05f
        }
    }

    private fun makeInput(initial: String, hint: String, inputType: Int): EditText {
        return EditText(this).apply {
            setText(initial)
            this.hint = hint
            setHintTextColor(Color.parseColor("#475569"))
            setTextColor(Color.parseColor("#F1F5F9"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            this.inputType = inputType
            isSingleLine = true
            background = roundedBox("#0B0F19", "#283552", 12f, 1)
            setPadding(dp(12), dp(11), dp(12), dp(11))
        }
    }

    private fun roundedBox(fillHex: String, strokeHex: String, radiusDp: Float, strokeDp: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dpF(radiusDp)
            setColor(Color.parseColor(fillHex))
            setStroke(dp(strokeDp), Color.parseColor(strokeHex))
        }
    }

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun dpF(v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)
}
