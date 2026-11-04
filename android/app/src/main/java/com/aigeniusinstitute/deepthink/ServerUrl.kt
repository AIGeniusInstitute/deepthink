package com.aigeniusinstitute.deepthink

import java.net.URI

/**
 * 服务 URL 规范化（对齐旧壳 dex 中 normalizeServerUrl 的行为）：
 * 补协议、去尾斜杠、非法输入返回 null。纯函数，JVM 可单测。
 */
object ServerUrl {

    /** 规范化用户输入的服务器地址；非法返回 null。 */
    fun normalize(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            s = "http://$s"
        }
        s = s.trimEnd('/')
        val uri = try {
            URI(s)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrBlank()) return null
        return s
    }

    /** 是否指向本机（本地模式判定）。 */
    fun isLoopback(url: String): Boolean {
        val host = try {
            URI(url).host?.lowercase()
        } catch (_: Exception) {
            null
        } ?: return false
        return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }
}
