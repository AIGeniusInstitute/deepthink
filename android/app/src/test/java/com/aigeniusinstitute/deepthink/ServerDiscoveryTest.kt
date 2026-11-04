package com.aigeniusinstitute.deepthink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** TC-F4-02 / TC-F4-03：健康探测判定 + 端口候选序列。 */
class ServerDiscoveryTest {

    // ── isHealthy（TC-F4-02） ──────────────────────────────

    @Test
    fun `200 且 status healthy 判定为健康`() {
        assertTrue(ServerDiscovery.isHealthy(200, """{"status":"healthy","checks":{}}"""))
    }

    @Test
    fun `200 且 status ok 判定为健康`() {
        assertTrue(ServerDiscovery.isHealthy(200, """{"status":"ok"}"""))
    }

    @Test
    fun `200 但 status 非健康值判定为不健康`() {
        assertFalse(ServerDiscovery.isHealthy(200, """{"status":"unhealthy"}"""))
    }

    @Test
    fun `200 但响应无 status 字段判定为不健康`() {
        assertFalse(ServerDiscovery.isHealthy(200, """{"checks":{}}"""))
    }

    @Test
    fun `非 200 判定为不健康`() {
        assertFalse(ServerDiscovery.isHealthy(503, """{"status":"healthy"}"""))
        assertFalse(ServerDiscovery.isHealthy(404, """{"status":"ok"}"""))
    }

    @Test
    fun `空响应体判定为不健康`() {
        assertFalse(ServerDiscovery.isHealthy(200, ""))
    }

    // ── candidatePorts（TC-F4-03） ─────────────────────────

    @Test
    fun `默认端口优先且扫描区间去重`() {
        val ports = ServerDiscovery.candidatePorts(9898, scanEnabled = true)
        assertEquals(9898, ports.first())
        assertEquals(9890, ports[1])
        assertEquals(11, ports.size) // 9890..9900 共 11 个，preferred 已去重
        assertEquals(ports.size, ports.toSet().size)
    }

    @Test
    fun `自定义端口优先`() {
        val ports = ServerDiscovery.candidatePorts(9905, scanEnabled = true)
        assertEquals(9905, ports.first())
        assertTrue(ports.containsAll((9890..9900).toList()))
    }

    @Test
    fun `关闭扫描时仅剩配置端口`() {
        val ports = ServerDiscovery.candidatePorts(9898, scanEnabled = false)
        assertEquals(listOf(9898), ports)
    }

    // ── discover（探测编排） ───────────────────────────────

    @Test
    fun `discover 返回第一个命中的端口`() {
        val d = ServerDiscovery { it == 9892 }
        assertEquals(9892, d.discover(listOf(9898, 9891, 9892, 9893)))
    }

    @Test
    fun `全部未命中返回 null`() {
        val d = ServerDiscovery { false }
        assertNull(d.discover(listOf(9898, 9899)))
    }

    @Test
    fun `探测抛异常视为未命中并继续`() {
        val d = ServerDiscovery { port ->
            if (port == 9898) throw RuntimeException("boom") else port == 9899
        }
        assertEquals(9899, d.discover(listOf(9898, 9899)))
    }
}
