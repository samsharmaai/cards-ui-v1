package app.cadence.widget

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import javax.crypto.AEADBadTagException
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

object CadenceSync {
    private const val PREFS_NAME = "cadence_widget_prefs"
    private const val KEY_ACCESS_KEY = "access_key"
    private const val KEY_GOAL_MINS = "goal_mins"
    private const val KEY_TARGET_DATE = "target_date"
    private const val KEY_WEB_URL = "web_url"
    private const val KEY_CACHED_PROGRESS = "cached_progress_json"
    private const val KEY_LAST_SYNC_AT = "last_sync_at"

    private const val FIREBASE_PROJECT = "cadence-deck"
    private const val FIREBASE_COLLECTION = "cadence"

    const val DEFAULT_TARGET_DATE = "2026-12-12"
    const val DEFAULT_GOAL_MINS = 45

    data class WidgetConfig(
        val accessKey: String,
        val goalMins: Int,
        val targetDate: String,
        val webUrl: String
    )

    data class WidgetStats(
        val configured: Boolean,
        val streak: Int,
        val todaySecs: Int,
        val studiedToday: Boolean,
        val goalMins: Int,
        val daysLeft: Int,
        val lastSyncMillis: Long
    )

    fun getConfig(context: Context): WidgetConfig {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val key = prefs.getString(KEY_ACCESS_KEY, "")?.trim().orEmpty()
        val goal = prefs.getInt(KEY_GOAL_MINS, DEFAULT_GOAL_MINS).coerceIn(5, 600)
        val target = prefs.getString(KEY_TARGET_DATE, DEFAULT_TARGET_DATE)?.trim()
            ?.takeIf { it.isNotEmpty() } ?: DEFAULT_TARGET_DATE
        val savedUrl = prefs.getString(KEY_WEB_URL, null)?.trim()
        val webUrl = if (!savedUrl.isNullOrEmpty()) savedUrl else BuildConfig.DEFAULT_WEB_URL
        return WidgetConfig(
            accessKey = key,
            goalMins = goal,
            targetDate = target,
            webUrl = webUrl
        )
    }

    fun saveConfig(
        context: Context,
        accessKey: String,
        goalMins: Int,
        targetDate: String,
        webUrl: String
    ) {
        val cleanGoal = goalMins.coerceIn(5, 600)
        val cleanTarget = parseTargetDateOrDefault(targetDate).toString()
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ACCESS_KEY, accessKey.trim())
            .putInt(KEY_GOAL_MINS, cleanGoal)
            .putString(KEY_TARGET_DATE, cleanTarget)
            .putString(KEY_WEB_URL, webUrl.trim())
            .apply()
    }

    fun computeCachedStats(context: Context): WidgetStats {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cfg = getConfig(context)
        val today = LocalDate.now()
        val target = parseTargetDateOrDefault(cfg.targetDate)
        val daysLeft = ChronoUnit.DAYS.between(today, target).toInt()

        if (cfg.accessKey.isBlank()) {
            return WidgetStats(
                configured = false,
                streak = 0,
                todaySecs = 0,
                studiedToday = false,
                goalMins = cfg.goalMins,
                daysLeft = daysLeft,
                lastSyncMillis = 0L
            )
        }

        val raw = prefs.getString(KEY_CACHED_PROGRESS, "{}") ?: "{}"
        val lastSync = prefs.getLong(KEY_LAST_SYNC_AT, 0L)
        return parseProgressStats(raw, cfg.goalMins, daysLeft, lastSync)
    }

    fun fetchAndSave(context: Context): WidgetStats {
        val cfg = getConfig(context)
        if (cfg.accessKey.isBlank()) {
            return computeCachedStats(context)
        }

        val docId = sha256Hex("cadence-sync-doc:${cfg.accessKey}")
        val endpoint =
            "https://firestore.googleapis.com/v1/projects/$FIREBASE_PROJECT/databases/(default)/documents/$FIREBASE_COLLECTION/$docId"

        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Cache-Control", "no-cache")
        }

        try {
            val code = conn.responseCode
            val compactProgressJson = when (code) {
                HttpURLConnection.HTTP_NOT_FOUND -> "{}"
                HttpURLConnection.HTTP_OK -> {
                    val body = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                    val doc = JSONObject(body)
                    val payloadStr = doc
                        .optJSONObject("fields")
                        ?.optJSONObject("payload")
                        ?.optString("stringValue", "")
                        .orEmpty()

                    if (payloadStr.isBlank()) {
                        "{}"
                    } else {
                        val plainJson = decryptPayload(payloadStr, cfg.accessKey)
                        val full = JSONObject(plainJson)
                        JSONObject().apply {
                            put("dailyActivity", full.optJSONObject("dailyActivity") ?: JSONObject())
                            put("dailySeconds", full.optJSONObject("dailySeconds") ?: JSONObject())
                        }.toString()
                    }
                }
                else -> throw IllegalStateException("Cloud sync returned HTTP $code")
            }

            val now = System.currentTimeMillis()
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_CACHED_PROGRESS, compactProgressJson)
                .putLong(KEY_LAST_SYNC_AT, now)
                .apply()

            return computeCachedStats(context)
        } finally {
            conn.disconnect()
        }
    }

    private fun parseProgressStats(
        progressJson: String,
        goalMins: Int,
        daysLeft: Int,
        lastSyncMillis: Long
    ): WidgetStats {
        val root = try {
            JSONObject(progressJson)
        } catch (_: Exception) {
            JSONObject()
        }
        val act = root.optJSONObject("dailyActivity")
        val secs = root.optJSONObject("dailySeconds")

        fun isDayActive(dk: String): Boolean {
            val r = act?.optInt(dk, 0) ?: 0
            val s = secs?.optInt(dk, 0) ?: 0
            return r > 0 || s >= 60
        }

        val today = LocalDate.now()
        val todayKey = today.toString()
        val todaySecs = secs?.optInt(todayKey, 0) ?: 0
        val studiedToday = isDayActive(todayKey)

        var streak = 0
        var cursor = if (studiedToday) today else today.minusDays(1)
        while (isDayActive(cursor.toString())) {
            streak++
            cursor = cursor.minusDays(1)
        }

        return WidgetStats(
            configured = true,
            streak = streak,
            todaySecs = todaySecs,
            studiedToday = studiedToday,
            goalMins = goalMins,
            daysLeft = daysLeft,
            lastSyncMillis = lastSyncMillis
        )
    }

    private fun decryptPayload(payloadStr: String, passcode: String): String {
        val payload = JSONObject(payloadStr)
        val iter = payload.optInt("iter", 100_000)
        val salt = Base64.decode(payload.getString("salt"), Base64.DEFAULT)
        val iv = Base64.decode(payload.getString("iv"), Base64.DEFAULT)
        val ct = Base64.decode(payload.getString("ct"), Base64.DEFAULT)

        val skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(passcode.trim().toCharArray(), salt, iter, 256)
        val secretBytes = skf.generateSecret(spec).encoded
        val aesKey = SecretKeySpec(secretBytes, "AES")

        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
            val plain = cipher.doFinal(ct)
            String(plain, StandardCharsets.UTF_8)
        } catch (_: AEADBadTagException) {
            throw IllegalArgumentException("Invalid access key — check spelling and try again.")
        } catch (_: BadPaddingException) {
            throw IllegalArgumentException("Invalid access key — check spelling and try again.")
        }
    }

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(StandardCharsets.UTF_8))
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            sb.append(String.format("%02x", b))
        }
        return sb.toString()
    }

    private fun parseTargetDateOrDefault(iso: String): LocalDate {
        return try {
            LocalDate.parse(iso.trim())
        } catch (_: Exception) {
            LocalDate.of(2026, 12, 12)
        }
    }

    fun formatMinutes(sec: Int): String {
        val s = maxOf(0, sec)
        return when {
            s == 0 -> "0m"
            s < 60 -> "<1m"
            s < 3600 -> "${s / 60}m"
            else -> {
                val h = s / 3600
                val m = (s % 3600) / 60
                if (m > 0) "${h}h ${m}m" else "${h}h"
            }
        }
    }

    fun formatDaysLeft(daysLeft: Int): String {
        return when {
            daysLeft > 0 -> "${daysLeft}d left"
            daysLeft == 0 -> "Today!"
            else -> "Done"
        }
    }
}
