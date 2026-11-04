package com.aigeniusinstitute.deepthink

/**
 * 本地服务发现（PRD F4a）。纯逻辑 + 可注入探测函数，JVM 可单测。
 * 契约：GET http://127.0.0.1:{port}/api/health → 200 + {"status":"healthy"|"ok"}
 * （与后端 src/routes/monitor.ts 的 /api/health 对齐）。
 */
class ServerDiscovery(private val probe: (Int) -> Boolean) {

    /** 顺序探测候选端口，返回第一个健康的端口；全部失败返回 null。 */
    fun discover(ports: List<Int>): Int? =
        ports.firstOrNull { runCatching { probe(it) }.getOrDefault(false) }

    companion object {
        const val DEFAULT_PORT = 9898
        const val SCAN_RANGE_START = 9890
        const val SCAN_RANGE_END = 9900

        /** 候选端口序列：配置端口优先，其次扫描区间（去重）。 */
        fun candidatePorts(preferred: Int, scanEnabled: Boolean): List<Int> {
            val ports = mutableListOf<Int>()
            if (preferred > 0) ports.add(preferred)
            if (scanEnabled) {
                for (p in SCAN_RANGE_START..SCAN_RANGE_END) {
                    if (p != preferred) ports.add(p)
                }
            }
            return ports
        }

        /** 健康响应判定：HTTP 200 且 JSON status ∈ {healthy, ok}。 */
        fun isHealthy(code: Int, body: String): Boolean {
            if (code != 200) return false
            val m = Regex("\"status\"\\s*:\\s*\"(\\w+)\"").find(body) ?: return false
            val status = m.groupValues[1]
            return status == "healthy" || status == "ok"
        }
    }
}
