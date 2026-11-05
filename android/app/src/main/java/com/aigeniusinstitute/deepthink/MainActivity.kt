package com.aigeniusinstitute.deepthink

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * DeepThink 壳主界面（PRD F4）。
 *
 * 状态机：DISCOVERING（探测本机服务）→ CONNECTED（WebView 加载）| GUIDE（引导页）。
 * 本地模式零配置：自动发现 127.0.0.1 上的 DeepThink 服务并加载；
 * 引导页提供「重新探测」与「手动配置服务器」（远程模式，兼容旧壳能力）。
 */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var webView: WebView
    private lateinit var statusPanel: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var progress: ProgressBar
    private lateinit var retryBtn: Button
    private lateinit var settingsBtn: Button
    private lateinit var banner: LinearLayout
    private lateinit var bannerText: TextView
    private lateinit var bannerClose: Button

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private var currentUrl: String? = null
    private var connectedLocal = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_main)
        bindViews()
        setupWebView()
        setupBanner()
        retryBtn.setOnClickListener { start() }
        settingsBtn.setOnClickListener { openSettings() }
        bannerClose.setOnClickListener {
            banner.visibility = View.GONE
            prefs.bannerDismissed = true
        }
        start()
    }

    private fun bindViews() {
        webView = findViewById(R.id.webview)
        statusPanel = findViewById(R.id.status_panel)
        statusText = findViewById(R.id.status_text)
        progress = findViewById(R.id.status_progress)
        retryBtn = findViewById(R.id.btn_retry)
        settingsBtn = findViewById(R.id.btn_settings)
        banner = findViewById(R.id.banner)
        bannerText = findViewById(R.id.banner_text)
        bannerClose = findViewById(R.id.banner_close)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean {
                val host = request?.url?.host ?: return false
                if (isOurServerHost(host)) return false
                // 非本服务器链接交系统浏览器打开
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: android.webkit.WebResourceError?,
            ) {
                if (request?.isForMainFrame == true) {
                    showGuide("连接中断：" + (error?.description ?: "页面加载失败"))
                }
            }
        }
    }

    /** 本地模式降级提示（PRD F4d）：一次性、可关闭。 */
    private fun setupBanner() {
        bannerText.text = getString(R.string.banner_local_mode)
    }

    /** 本服务器主机：loopback 或已连接服务器的同主机（远程模式，如 10.0.2.2 / 内网域名）。 */
    private fun isOurServerHost(host: String): Boolean {
        if (host == "127.0.0.1" || host == "localhost" || host == "::1") return true
        val cur = currentUrl ?: return false
        return try {
            java.net.URI(cur).host == host
        } catch (_: Exception) {
            false
        }
    }

    /** 入口：按模式启动（本地=自动发现，远程=手动 URL）。 */
    private fun start() {
        if (prefs.mode == Prefs.MODE_REMOTE && prefs.remoteUrl.isNotBlank()) {
            val url = ServerUrl.normalize(prefs.remoteUrl)
            if (url != null) {
                connect(url, local = false)
                return
            }
            showGuide("服务器地址无效：${prefs.remoteUrl}")
            return
        }
        startDiscovery()
    }

    /** 本地服务发现（PRD F4a）。 */
    private fun startDiscovery() {
        showStatus(getString(R.string.status_discovering), indeterminate = true)
        val ports = ServerDiscovery.candidatePorts(prefs.preferredPort, prefs.scanEnabled)
        io.execute {
            val found = ports.firstOrNull { port ->
                val resp = Http.get("http://127.0.0.1:$port/api/health")
                resp != null && ServerDiscovery.isHealthy(resp.first, resp.second)
            }
            main.post {
                if (isFinishing || isDestroyed) return@post
                if (found != null) {
                    connect("http://127.0.0.1:$found", local = true)
                } else {
                    showGuide(getString(R.string.status_not_found))
                }
            }
        }
    }

    private fun connect(url: String, local: Boolean) {
        currentUrl = url
        connectedLocal = local
        statusPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl("$url/")
        if (local && !prefs.bannerDismissed) {
            banner.visibility = View.VISIBLE
        } else {
            banner.visibility = View.GONE
        }
    }

    private fun showStatus(message: String, indeterminate: Boolean) {
        statusPanel.visibility = View.VISIBLE
        webView.visibility = View.GONE
        banner.visibility = View.GONE
        statusText.text = message
        progress.visibility = if (indeterminate) View.VISIBLE else View.GONE
        retryBtn.visibility = View.GONE
        settingsBtn.visibility = View.VISIBLE
    }

    /** 引导页（PRD F4b）：说明 + 重新探测 + 手动配置入口，绝不强制填 URL。 */
    private fun showGuide(message: String) {
        statusPanel.visibility = View.VISIBLE
        webView.visibility = View.GONE
        banner.visibility = View.GONE
        statusText.text = message
        progress.visibility = View.GONE
        retryBtn.visibility = View.VISIBLE
        retryBtn.text = getString(R.string.btn_rediscover)
        settingsBtn.visibility = View.VISIBLE
        settingsBtn.text = getString(R.string.btn_manual_server)
    }

    // ── 菜单 ────────────────────────────────────────────────
    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_RELOAD, 0, R.string.menu_reload)
        menu.add(0, MENU_REDISCOVER, 1, R.string.menu_rediscover)
        menu.add(0, MENU_SETTINGS, 2, R.string.menu_settings)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        MENU_RELOAD -> {
            currentUrl?.let { webView.reload() } ?: start()
            true
        }
        MENU_REDISCOVER -> {
            start()
            true
        }
        MENU_SETTINGS -> {
            openSettings()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    override fun onResume() {
        super.onResume()
        // 从设置返回：模式切换（本地↔远程）或远程 URL 变更时重新走启动流程
        val modeChanged = connectedLocal != (prefs.mode == Prefs.MODE_LOCAL)
        val wantRemote = prefs.mode == Prefs.MODE_REMOTE && prefs.remoteUrl.isNotBlank()
        val targetChanged = wantRemote &&
            ServerUrl.normalize(prefs.remoteUrl)?.let { it != currentUrl } == true
        if (currentUrl == null || modeChanged || targetChanged) {
            currentUrl = null
            webView.stopLoading()
            start()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        io.shutdownNow()
    }

    companion object {
        private const val MENU_RELOAD = 1
        private const val MENU_REDISCOVER = 2
        private const val MENU_SETTINGS = 3
    }
}
