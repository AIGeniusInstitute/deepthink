/**
 * agent-ai JSON 解析健壮性测试。
 *
 * 背景（docs/issues/2026-10-28-agent-studio-ai-generate-frontend-timeout.md）：
 * 模型偶发在 JSON 字符串值里输出未转义 ASCII 引号，JSON.parse 失败 → /generate 返回502。
 * 实测约 1/6 随机出现，所以「响应不可解析」时应重试一次；空响应/超时不动（provider
 * 真不可用时不要把等待时间翻倍）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sdkQueryMock } = vi.hoisted(() => ({ sdkQueryMock: vi.fn() }));

vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: sdkQueryMock,
  sdkQueryMessages: vi.fn(),
}));

import { generateAgentContent, optimizeAgentContent } from '../src/agent-ai';

/** 复刻线上坏样本：system_prompt 字符串里出现未转义的 ASCII 双引号。 */
const BROKEN_JSON =
  '{"name":"评审助手","description":"d","system_prompt":"清单填写"未发现问题"。","engine":"claude"}';
const GOOD_JSON = JSON.stringify({
  name: '评审助手',
  description: '帮助团队做代码评审',
  system_prompt: '你是代码评审专家。',
  model: null,
  engine: 'claude',
  max_turns: 20,
  temperature: 0.2,
});

beforeEach(() => {
  sdkQueryMock.mockReset();
});

describe('agent-ai generateAgentContent JSON 健壮性', () => {
  it('首次响应不可解析时重试一次并成功返回字段', async () => {
    sdkQueryMock.mockResolvedValueOnce(BROKEN_JSON).mockResolvedValueOnce(GOOD_JSON);

    const result = await generateAgentContent('帮助团队做代码评审的 Agent', '评审助手');

    expect('fields' in result).toBe(true);
    expect(sdkQueryMock).toHaveBeenCalledTimes(2);
  });

  it('两次都不可解析时报 invalid JSON 错误（不再写 provider misconfigured 误导文案）', async () => {
    sdkQueryMock.mockResolvedValue(BROKEN_JSON);

    const result = await generateAgentContent('帮助团队做代码评审的 Agent', '评审助手');

    expect(result).toEqual({ error: 'AI generated invalid JSON (model output not parseable)' });
    expect(sdkQueryMock).toHaveBeenCalledTimes(2);
  });

  it('空响应不重试，直接报 empty content', async () => {
    sdkQueryMock.mockResolvedValue(null);

    const result = await generateAgentContent('帮助团队做代码评审的 Agent', '评审助手');

    expect(result).toEqual({
      error: 'AI generation returned empty content (provider may be unavailable)',
    });
    expect(sdkQueryMock).toHaveBeenCalledTimes(1);
  });

  it('首次即合法 JSON 时不重试', async () => {
    sdkQueryMock.mockResolvedValueOnce('```json\n' + GOOD_JSON + '\n```');

    const result = await generateAgentContent('帮助团队做代码评审的 Agent', '评审助手');

    expect('fields' in result && result.fields.name).toBe('评审助手');
    expect(sdkQueryMock).toHaveBeenCalledTimes(1);
  });
});

describe('agent-ai optimizeAgentContent JSON 健壮性', () => {
  const current = { name: '评审助手', description: 'd', system_prompt: 'p' };
  const GOOD_OPT = JSON.stringify({ description: '更好的描述', system_prompt: '更好的提示词' });

  it('解析失败重试一次后成功', async () => {
    sdkQueryMock.mockResolvedValueOnce(BROKEN_JSON).mockResolvedValueOnce(GOOD_OPT);

    const result = await optimizeAgentContent(current, '更聚焦');

    expect(result).toEqual({
      fields: { description: '更好的描述', system_prompt: '更好的提示词' },
    });
    expect(sdkQueryMock).toHaveBeenCalledTimes(2);
  });

  it('两次都失败时报错且不吞掉', async () => {
    sdkQueryMock.mockResolvedValue(BROKEN_JSON);

    const result = await optimizeAgentContent(current);

    expect(result).toEqual({ error: 'AI optimized content is invalid JSON (model output not parseable)' });
  });
});
