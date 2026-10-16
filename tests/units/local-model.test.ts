/**
 * 本机内置模型服务适配层的测试。
 *
 * 同样用本地桩而不是真 Ollama：要断言的是**协议处理和失败降级** ——
 * 服务没起时不能抛异常、模型名带 `:latest` 时"已安装"判断不能失灵、
 * 拉取流里夹带的 error 不能被当成成功。这些都是桩能精确复现、真服务不好构造的。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  isModelInstalled,
  normalizeModelName,
  probeEmbeddingDimension,
  probeLocalModelService,
  pullLocalModel,
  startLocalModelService,
  localModelBaseUrl,
  type PullProgress,
} from '../../src/local-model.js';

interface Stub {
  server: http.Server;
  url: string;
}

let stub: Stub;
let originalUrl: string | undefined;
/** 每个用例可以改这个，决定 /api/pull 返回什么流。 */
let pullLines: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  originalUrl = process.env.DEEPTHINK_LOCAL_MODEL_URL;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/version')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9-stub' }));
      return;
    }
    if (url.startsWith('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'bge-m3:latest',
              size: 1_200_000_000,
              modified_at: '2026-10-16T09:00:00Z',
              details: { parameter_size: '568M', quantization_level: 'F16', family: 'bert' },
            },
          ],
        }),
      );
      return;
    }
    if (url.startsWith('/api/pull')) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const line of pullLines) res.write(`${JSON.stringify(line)}\n`);
      res.end();
      return;
    }
    if (url.endsWith('/embeddings')) {
      const dim = 1024;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: new Array(dim).fill(0.1) }] }));
      return;
    }
    res.writeHead(404).end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  stub = { server, url: `http://127.0.0.1:${port}` };
});

afterAll(async () => {
  if (originalUrl === undefined) delete process.env.DEEPTHINK_LOCAL_MODEL_URL;
  else process.env.DEEPTHINK_LOCAL_MODEL_URL = originalUrl;
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

afterEach(() => {
  pullLines = [];
});

describe('模型名归一化', () => {
  it('`bge-m3` 与 `bge-m3:latest` 视为同一个模型', () => {
    expect(normalizeModelName('bge-m3')).toBe('bge-m3');
    expect(normalizeModelName('bge-m3:latest')).toBe('bge-m3');
  });

  it('显式 tag 保留（`qwen3-vl:8b` 不是 `qwen3-vl`）', () => {
    expect(normalizeModelName('qwen3-vl:8b')).toBe('qwen3-vl:8b');
  });

  it('已安装判定跨 tag 生效 —— 否则界面会重复触发一次 1.2GB 下载', () => {
    const models = [{ name: 'bge-m3:latest', sizeBytes: 1 }];
    expect(isModelInstalled(models, 'bge-m3')).toBe(true);
    expect(isModelInstalled(models, 'bge-m3:latest')).toBe(true);
    expect(isModelInstalled(models, 'qwen3-vl:8b')).toBe(false);
  });
});

describe('服务探测', () => {
  it('服务可用时返回版本与模型清单，字段映射正确', async () => {
    process.env.DEEPTHINK_LOCAL_MODEL_URL = stub.url;
    const status = await probeLocalModelService();
    expect(status.available).toBe(true);
    expect(status.version).toBe('9.9.9-stub');
    expect(status.models).toEqual([
      {
        name: 'bge-m3:latest',
        sizeBytes: 1_200_000_000,
        parameterSize: '568M',
        quantization: 'F16',
        family: 'bert',
        modifiedAt: '2026-10-16T09:00:00Z',
      },
    ]);
  });

  it('服务没起时返回结构化错误而**不是抛异常** —— "没启动"是正常状态之一', async () => {
    // 端口 1 上没有服务；探测必须自己咽下 ECONNREFUSED。
    process.env.DEEPTHINK_LOCAL_MODEL_URL = 'http://127.0.0.1:1';
    const status = await probeLocalModelService(1000);
    expect(status.available).toBe(false);
    expect(status.baseUrl).toBe('http://127.0.0.1:1');
    expect(status.models).toEqual([]);
    expect(typeof status.error).toBe('string');
    expect(status.error!.length).toBeGreaterThan(0);
  });

  it('服务已经可用时 start 不会重复拉起进程', async () => {
    process.env.DEEPTHINK_LOCAL_MODEL_URL = stub.url;
    const result = await startLocalModelService(1000);
    expect(result.started).toBe(false);
    expect(result.status.available).toBe(true);
  });

  it('baseUrl 尾部斜杠被吃掉（否则会拼出 //api/tags）', () => {
    process.env.DEEPTHINK_LOCAL_MODEL_URL = 'http://127.0.0.1:11434///';
    expect(localModelBaseUrl()).toBe('http://127.0.0.1:11434');
  });
});

describe('拉取模型', () => {
  it('流式进度按 total/completed 折成百分比', async () => {
    process.env.DEEPTHINK_LOCAL_MODEL_URL = stub.url;
    pullLines = [
      { status: 'pulling manifest' },
      { status: 'pulling abc', total: 1000, completed: 250 },
      { status: 'pulling abc', total: 1000, completed: 1000 },
      { status: 'success' },
    ];
    const seen: PullProgress[] = [];
    await pullLocalModel('bge-m3', (p) => seen.push(p));

    expect(seen.map((s) => s.status)).toContain('success');
    const withPercent = seen.filter((s) => s.percent !== undefined);
    expect(withPercent.map((s) => s.percent)).toEqual([25, 100]);
  });

  it('HTTP 200 但 body 里带 error 时算失败 —— 当成成功会骗过管理员', async () => {
    process.env.DEEPTHINK_LOCAL_MODEL_URL = stub.url;
    pullLines = [{ status: 'pulling manifest' }, { error: 'pull access denied' }];
    await expect(pullLocalModel('nope', () => {})).rejects.toThrow(/pull access denied/);
  });
});

describe('向量维度探测', () => {
  it('维度是问出来的，不是按模型名硬编码的', async () => {
    await expect(probeEmbeddingDimension(`${stub.url}/v1`, 'bge-m3', 'ollama')).resolves.toBe(1024);
  });

  it('打不通时抛错，绝不返回一个假维度去建 vec0 表', async () => {
    await expect(
      probeEmbeddingDimension('http://127.0.0.1:1/v1', 'bge-m3', 'x', 1000),
    ).rejects.toThrow();
  });
});
