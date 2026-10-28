/**
 * Agent Studio「AI 生成 / AI 优化」请求契约测试。
 *
 * 背景（docs/issues/2026-10-28-agent-studio-ai-generate-frontend-timeout.md）：
 * 后端 LLM 预算 90s（src/agent-ai.ts），实测一次生成约 27s；前端 apiFetch 默认 8s
 * 超时会把还在跑的请求 abort 掉，用户只看到「AI 生成失败（provider 可能不可用或超时）」。
 * 这里锁两件事：
 *   1. generateAgent / optimizeAgent 必须显式传 ≥ 后端 LLM 预算的 timeoutMs；
 *   2. 失败必须把后端真实原因（ApiError.message）抛给调用方，不允许吞掉后返回 null。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentsPaasStore } from '../web/src/stores/agents-paas';

const { apiPostMock } = vi.hoisted(() => ({ apiPostMock: vi.fn() }));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: apiPostMock,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    uploadFiles: vi.fn(),
  },
}));

/** 与 src/agent-ai.ts 的 GENERATION_TIMEOUT_MS / OPTIMIZATION_TIMEOUT_MS 对齐。 */
const BACKEND_LLM_BUDGET_MS = 90_000;

const FIELDS = {
  name: '代码评审助手',
  description: '总结 PR 改动并给出评审建议',
  system_prompt: '你是代码评审专家。',
  model: null,
  engine: 'claude',
  max_turns: null,
  temperature: null,
};

beforeEach(() => {
  apiPostMock.mockReset();
});

describe('agents-paas AI generate/optimize timeout contract', () => {
  it('generateAgent 用 ≥ 后端 LLM 预算的超时发起请求（默认 8s 会提前 abort）', async () => {
    apiPostMock.mockResolvedValueOnce({ fields: FIELDS });

    const fields = await useAgentsPaasStore
      .getState()
      .generateAgent({ name: '代码评审助手', description: '帮助团队做代码评审' });

    expect(fields).toEqual(FIELDS);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [path, body, timeoutMs] = apiPostMock.mock.calls[0];
    expect(path).toBe('/api/paas/agents/generate');
    expect(body).toEqual({ name: '代码评审助手', description: '帮助团队做代码评审' });
    expect(typeof timeoutMs).toBe('number');
    expect(timeoutMs).toBeGreaterThanOrEqual(BACKEND_LLM_BUDGET_MS);
  });

  it('optimizeAgent 同样用 ≥ 后端 LLM 预算的超时发起请求', async () => {
    const preview = {
      optimized_description: 'd',
      optimized_system_prompt: 'p',
      original_description: 'od',
      original_system_prompt: 'op',
    };
    apiPostMock.mockResolvedValueOnce(preview);

    const result = await useAgentsPaasStore.getState().optimizeAgent('ag-1', '更聚焦');

    expect(result).toEqual(preview);
    const [path, body, timeoutMs] = apiPostMock.mock.calls[0];
    expect(path).toBe('/api/paas/agents/ag-1/optimize');
    expect(body).toEqual({ feedback: '更聚焦' });
    expect(timeoutMs).toBeGreaterThanOrEqual(BACKEND_LLM_BUDGET_MS);
  });

  it('generateAgent 失败时抛出后端真实原因，而不是吞掉后返回 null', async () => {
    apiPostMock.mockRejectedValueOnce(
      new Error('AI generation returned empty content (provider may be unavailable)'),
    );

    await expect(
      useAgentsPaasStore.getState().generateAgent({ description: '帮助团队做代码评审' }),
    ).rejects.toThrow('AI generation returned empty content (provider may be unavailable)');
  });

  it('optimizeAgent 失败时同样抛出后端真实原因', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('AI optimized content is invalid JSON'));

    await expect(useAgentsPaasStore.getState().optimizeAgent('ag-1')).rejects.toThrow(
      'AI optimized content is invalid JSON',
    );
  });

  it('响应缺 fields 时返回 null（仅此情况返回 null）', async () => {
    apiPostMock.mockResolvedValueOnce({});

    await expect(
      useAgentsPaasStore.getState().generateAgent({ description: '帮助团队做代码评审' }),
    ).resolves.toBeNull();
  });
});
