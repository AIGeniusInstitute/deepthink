/**
 * fetchUrlContent 的 SSRF 回归测试。
 *
 * 修复前该函数只判 `^https?://` 后直接 `fetch(url, { redirect: 'follow' })`：
 * 既不查内网地址，也不检查重定向目标，任何指向云元数据服务（169.254.169.254 /
 * 100.100.100.200）的 URL 都会被照单抓取。
 *
 * 本文件锁三件事：
 *   1. 内网字面量地址在发起请求前就被拒绝（不依赖网络）
 *   2. 公网域名解析到内网地址（DNS rebinding）被拒绝
 *   3. 重定向逐跳校验——首跳合法、次跳指向内网时不得继续
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// url-safety 的 DNS 判定走 node:dns/promises。替换掉可避免测试依赖真实解析，
// 同时用来构造「公网域名解析到内网」的场景。
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { fetchUrlContent } from '../../src/document-parser.js';

const PUBLIC_ADDR = [{ address: '93.184.216.34', family: 4 }];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC_ADDR);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUrlContent SSRF 防护', () => {
  describe('内网字面量地址', () => {
    test.each([
      ['http://127.0.0.1:8080/admin', 'loopback'],
      ['http://127.255.255.254/', '127/8 上边界'],
      ['http://localhost/admin', 'localhost'],
      ['http://169.254.169.254/latest/meta-data/', '云元数据服务'],
      ['http://100.100.100.200/latest/meta-data/', '阿里云 ECS 元数据'],
      ['http://192.168.1.1/', 'RFC1918'],
      ['http://10.0.0.1/', 'RFC1918'],
      ['http://172.16.0.1/', 'RFC1918'],
      ['http://[::1]/', 'IPv6 loopback'],
      ['file:///etc/passwd', '非 http(s) 协议'],
    ])('拒绝 %s（%s）', async (url) => {
      await expect(fetchUrlContent(url)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('字面 IP 被拒时不触发 DNS 查询（不依赖网络即可拦截）', async () => {
      await expect(fetchUrlContent('http://169.254.169.254/')).rejects.toThrow();
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });

  describe('DNS rebinding（域名解析到内网）', () => {
    test('公网域名解析到内网地址时拒绝', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

      await expect(fetchUrlContent('http://evil.example.com/')).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('域名有多条 A 记录、其中一条是内网时拒绝', async () => {
      lookupMock.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);

      await expect(fetchUrlContent('http://mixed.example.com/')).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('重定向', () => {
    test('首跳合法、次跳指向内网时中断，且只发出一次请求', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      );

      await expect(fetchUrlContent('https://docs.example.com/a')).rejects.toThrow(/Blocked URL/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('相对路径重定向按当前 URL 解析后仍被校验', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/b' } }))
        .mockResolvedValueOnce(
          new Response('<p>ok</p>', { status: 200, headers: { 'content-type': 'text/plain' } }),
        );

      await fetchUrlContent('https://docs.example.com/a');
      expect(fetchMock.mock.calls[1][0]).toBe('https://docs.example.com/b');
    });

    test('重定向超过上限时报错', async () => {
      fetchMock.mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://docs.example.com/next' } }),
      );

      await expect(fetchUrlContent('https://docs.example.com/a')).rejects.toThrow(/Too many redirects/);
      // 首跳 + 5 次跟随 = 6 次；第 6 次拿到重定向后即判定超限，不再发第 7 次
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    test('重定向响应缺少 Location 头时报错', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));

      await expect(fetchUrlContent('https://docs.example.com/a')).rejects.toThrow(/without Location/);
    });
  });

  describe('请求参数', () => {
    test('必须以 redirect: manual 发起——follow 会让逐跳校验形同虚设', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );

      await fetchUrlContent('https://docs.example.com/a');
      expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    });
  });

  describe('既有行为不回退', () => {
    test('非 2xx 响应仍然报错', async () => {
      fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));

      await expect(fetchUrlContent('https://docs.example.com/a')).rejects.toThrow(/404/);
    });

    test('不支持的 content-type 仍然报错', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('binary', { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      );

      await expect(fetchUrlContent('https://docs.example.com/a')).rejects.toThrow(/Unsupported content type/);
    });

    test('maxBytes 仍然生效', async () => {
      const body = 'x'.repeat(5000);
      fetchMock.mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );

      const out = await fetchUrlContent('https://docs.example.com/a', { maxBytes: 100 });
      expect(out.length).toBe(100);
    });
  });
});
