package com.aigeniusinstitute.deepthink

import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 极简 HTTP 探测（GET + 状态码 + 限量响应体）。仅运行时使用；
 * 单测通过注入 probe 函数绕开本类，JVM 测试不触碰网络。
 */
object Http {

    private const val MAX_BODY = 2048

    /** GET url；返回 (statusCode, body) 或 null（连接失败/超时）。 */
    fun get(url: String, timeoutMs: Int = 800): Pair<Int, String>? = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.requestMethod = "GET"
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use(BufferedReader::readText)?.take(MAX_BODY) ?: ""
            code to body
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        null
    }
}
