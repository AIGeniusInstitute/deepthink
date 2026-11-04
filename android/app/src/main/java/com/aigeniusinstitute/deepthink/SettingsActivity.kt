package com.aigeniusinstitute.deepthink

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.RadioButton
import android.widget.TextView
import java.util.concurrent.Executors

/**
 * 服务器设置（PRD F4c）：本地/远程模式切换、server URL、探测端口、连接测试。
 * 保留旧壳"手动填 server URL"能力作为可选路径，本地模式仍是默认且零配置。
 */
class SettingsActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var radioLocal: RadioButton
    private lateinit var radioRemote: RadioButton
    private lateinit var urlInput: EditText
    private lateinit var portInput: EditText
    private lateinit var scanCheck: CheckBox
    private lateinit var testResult: TextView

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_settings)
        bindViews()
        loadFromPrefs()

        findViewById<Button>(R.id.btn_test).setOnClickListener { testConnection() }
        findViewById<Button>(R.id.btn_save).setOnClickListener { save() }
    }

    private fun bindViews() {
        radioLocal = findViewById(R.id.radio_local)
        radioRemote = findViewById(R.id.radio_remote)
        urlInput = findViewById(R.id.input_url)
        portInput = findViewById(R.id.input_port)
        scanCheck = findViewById(R.id.check_scan)
        testResult = findViewById(R.id.test_result)
    }

    private fun loadFromPrefs() {
        if (prefs.mode == Prefs.MODE_REMOTE) radioRemote.isChecked = true else radioLocal.isChecked = true
        urlInput.setText(prefs.remoteUrl)
        portInput.setText(prefs.preferredPort.toString())
        scanCheck.isChecked = prefs.scanEnabled
    }

    private fun testConnection() {
        val target = resolveTarget() ?: run {
            testResult.text = getString(R.string.test_invalid_input)
            return
        }
        testResult.text = getString(R.string.test_testing)
        io.execute {
            val resp = Http.get(target, timeoutMs = 3000)
            val ok = resp != null && ServerDiscovery.isHealthy(resp.first, resp.second)
            main.post {
                testResult.text = if (ok) {
                    getString(R.string.test_ok, target)
                } else {
                    getString(R.string.test_fail, target)
                }
            }
        }
    }

    /** 当前表单对应的健康探测 URL；非法输入返回 null。 */
    private fun resolveTarget(): String? {
        return if (radioRemote.isChecked) {
            ServerUrl.normalize(urlInput.text.toString())?.let { "$it/api/health" }
        } else {
            val port = portInput.text.toString().toIntOrNull() ?: return null
            if (port <= 0 || port > 65535) return null
            "http://127.0.0.1:$port/api/health"
        }
    }

    private fun save() {
        if (radioRemote.isChecked) {
            val url = ServerUrl.normalize(urlInput.text.toString())
            if (url == null) {
                testResult.text = getString(R.string.test_invalid_input)
                return
            }
            prefs.mode = Prefs.MODE_REMOTE
            prefs.remoteUrl = url
        } else {
            val port = portInput.text.toString().toIntOrNull()
            if (port == null || port <= 0 || port > 65535) {
                testResult.text = getString(R.string.test_invalid_input)
                return
            }
            prefs.mode = Prefs.MODE_LOCAL
            prefs.preferredPort = port
            prefs.scanEnabled = scanCheck.isChecked
        }
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        io.shutdownNow()
    }
}
