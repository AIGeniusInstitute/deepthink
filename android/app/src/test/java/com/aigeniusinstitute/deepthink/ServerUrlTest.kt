package com.aigeniusinstitute.deepthink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** TC-F4-04：URL 规范化（对齐旧壳 normalizeServerUrl 行为）。 */
class ServerUrlTest {

    @Test
    fun `裸域名补 http 协议`() {
        assertEquals("http://deepthink.example.com", ServerUrl.normalize("deepthink.example.com"))
    }

    @Test
    fun `已有 https 协议保持不变`() {
        assertEquals("https://deepthink.example.com", ServerUrl.normalize("https://deepthink.example.com"))
    }

    @Test
    fun `去除尾斜杠`() {
        assertEquals("http://127.0.0.1:9898", ServerUrl.normalize("http://127.0.0.1:9898/"))
    }

    @Test
    fun `带端口的本机地址规范化`() {
        assertEquals("http://127.0.0.1:9898", ServerUrl.normalize(" 127.0.0.1:9898 "))
    }

    @Test
    fun `空输入返回 null`() {
        assertNull(ServerUrl.normalize(""))
        assertNull(ServerUrl.normalize("   "))
    }

    @Test
    fun `非法输入返回 null`() {
        assertNull(ServerUrl.normalize("ht!tp://%%"))
    }

    // ── isLoopback ─────────────────────────────────────────

    @Test
    fun `本机地址判定`() {
        assertTrue(ServerUrl.isLoopback("http://127.0.0.1:9898"))
        assertTrue(ServerUrl.isLoopback("http://localhost:9898"))
    }

    @Test
    fun `非本机地址判定`() {
        assertFalse(ServerUrl.isLoopback("https://deepthink.example.com"))
        assertFalse(ServerUrl.isLoopback("not a url"))
    }
}
