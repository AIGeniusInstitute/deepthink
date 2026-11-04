package com.aigeniusinstitute.deepthink

import android.content.Context
import android.content.SharedPreferences

/** 配置持久化（SharedPreferences）。 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("deepthink_prefs", Context.MODE_PRIVATE)

    /** "local" = 自动发现本机服务；"remote" = 手动 server URL。 */
    var mode: String
        get() = sp.getString(KEY_MODE, MODE_LOCAL) ?: MODE_LOCAL
        set(v) = sp.edit().putString(KEY_MODE, v).apply()

    var remoteUrl: String
        get() = sp.getString(KEY_REMOTE_URL, "") ?: ""
        set(v) = sp.edit().putString(KEY_REMOTE_URL, v).apply()

    var preferredPort: Int
        get() = sp.getInt(KEY_PORT, ServerDiscovery.DEFAULT_PORT)
        set(v) = sp.edit().putInt(KEY_PORT, v).apply()

    var scanEnabled: Boolean
        get() = sp.getBoolean(KEY_SCAN, true)
        set(v) = sp.edit().putBoolean(KEY_SCAN, v).apply()

    var bannerDismissed: Boolean
        get() = sp.getBoolean(KEY_BANNER_DISMISSED, false)
        set(v) = sp.edit().putBoolean(KEY_BANNER_DISMISSED, v).apply()

    companion object {
        const val MODE_LOCAL = "local"
        const val MODE_REMOTE = "remote"
        private const val KEY_MODE = "mode"
        private const val KEY_REMOTE_URL = "remote_url"
        private const val KEY_PORT = "preferred_port"
        private const val KEY_SCAN = "scan_enabled"
        private const val KEY_BANNER_DISMISSED = "banner_dismissed"
    }
}
