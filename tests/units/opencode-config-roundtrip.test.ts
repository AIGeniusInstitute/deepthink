/**
 * Regression test for the OpenCode settings blank-page bug.
 *
 * 现象：配置好 OpenCode 引擎（含 provider + apiKey）后，访问
 * /settings?tab=opencode 页面白屏，控制台报
 *   Cannot read properties of undefined (reading 'startsWith')
 *   at SettingsPage ... Array.map
 *
 * 根因：GET /api/config/opencode 的公开响应（toPublicOpencodeConfig）出于
 * 脱敏目的**剥掉了每个 provider 的 apiKey 字段**（只保留 hasApiKey 标志位）。
 * 但前端 OpencodeEngineSection 把 apiKey 当作必填字符串直接调用
 * `p.apiKey.startsWith('****')` → undefined.startsWith → 渲染抛错 → 整页白屏。
 *
 * 关联 bug：保存流程也坏——前端把公开响应原样回 PUT 时，provider 缺 apiKey
 * 字段，而 OpencodeProviderSchema 要求 apiKey 非空，safeParse 直接 400，路由里
 * 的 keep-existing 恢复逻辑根本没机会执行。
 *
 * 修复覆盖三个纯函数契约（路由与前端都依赖它们）：
 *   1. toPublicOpencodeConfig 不返回 apiKey，但返回 hasApiKey
 *   2. 缺省 apiKey 的 provider 能通过 OpencodeConfigSchema（不再 400）
 *   3. resolveOpencodeProvidersForSave 按 id 从 current 恢复 apiKey；仍无 key
 *      的未填新条目被丢弃
 */
import { describe, expect, test } from 'vitest';

import { OpencodeConfigSchema } from '../../src/schemas.js';
import {
  resolveOpencodeProvidersForSave,
  toPublicOpencodeConfig,
  type OpencodeConfig,
  type OpencodeProvider,
} from '../../src/runtime-config.js';

const SAVED_KEY = 'sk-secret-123';

function baseConfig(providers: OpencodeProvider[]): OpencodeConfig {
  return {
    enabled: true,
    binaryPath: '/usr/local/bin/opencode',
    host: '127.0.0.1',
    basePort: 15000,
    portRange: 100,
    password: 'pw',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-6',
    workingDir: '/workspace/group',
    providers,
    updatedAt: null,
  };
}

function seedProvider(): OpencodeProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    apiKey: SAVED_KEY,
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-6'],
  };
}

describe('opencode settings (regression: blank page + save 400)', () => {
  test('toPublicOpencodeConfig strips apiKey, exposes hasApiKey', () => {
    const pub = toPublicOpencodeConfig(baseConfig([seedProvider()]));
    const p = pub.providers[0]!;
    // 前端依赖：公开响应里没有 apiKey 字段（这正是曾导致 startsWith 崩溃的来源）
    expect('apiKey' in p).toBe(false);
    expect(p.hasApiKey).toBe(true);
  });

  test('provider without apiKey passes schema (no longer 400)', () => {
    // 模拟前端把公开响应原样回存：provider 缺 apiKey
    const payload = {
      enabled: true,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          baseURL: 'https://api.anthropic.com/v1',
          models: ['claude-sonnet-4-6'],
          hasApiKey: true,
        },
      ],
    };
    const parsed = OpencodeConfigSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test('resolveOpencodeProvidersForSave restores apiKey by id from current', () => {
    const current = [seedProvider()];
    // 前端回存的 provider 没有 apiKey（hasApiKey: true）
    const fromFrontend = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        baseURL: 'https://api.anthropic.com/v1',
        models: ['claude-sonnet-4-6'],
      },
    ];
    const resolved = resolveOpencodeProvidersForSave(fromFrontend, current);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.apiKey).toBe(SAVED_KEY);
  });

  test('resolveOpencodeProvidersForSave drops incomplete new provider (no key, no current)', () => {
    const resolved = resolveOpencodeProvidersForSave(
      [
        {
          id: 'newprov',
          name: 'New',
          baseURL: 'https://example.com',
          models: ['m1'],
          // 未填 apiKey，current 里也没有
        },
      ],
      [],
    );
    expect(resolved).toHaveLength(0);
  });

  test('full round-trip (pure): public shape → schema → resolve preserves key', () => {
    // 1. 公开响应（前端拿到的）剥掉 apiKey
    const pub = toPublicOpencodeConfig(baseConfig([seedProvider()]));
    expect('apiKey' in pub.providers[0]!).toBe(false);

    // 2. 前端未改 apiKey 直接回存 → schema 通过（不再 400）
    const reparsed = OpencodeConfigSchema.safeParse({
      enabled: true,
      binaryPath: '/usr/local/bin/opencode',
      providers: pub.providers, // 缺 apiKey
    });
    expect(reparsed.success).toBe(true);

    // 3. keep-existing 恢复 apiKey
    const providers = resolveOpencodeProvidersForSave(
      reparsed.data!.providers ?? [],
      [seedProvider()],
    );
    expect(providers[0]!.apiKey).toBe(SAVED_KEY);
  });

  test('legacy config with old bunPath/opencodePath fields does not break schema', () => {
    // 旧版 opencode.json 含 bunPath/opencodePath（源码时代遗留），升级后
    // 回存时前端可能仍带上旧字段。OpencodeConfigSchema 已移除这两个字段，
    // zod 默认 strip 未知键 → safeParse 成功，binaryPath 可独立写入。
    const legacy = {
      enabled: true,
      bunPath: '/opt/homebrew/bin/bun',
      opencodePath: '/Users/xingzhi/opencode/packages/opencode/src/index.ts',
      binaryPath: '/usr/local/bin/opencode',
      host: '127.0.0.1',
      basePort: 15000,
      portRange: 100,
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
      workingDir: '/workspace/group',
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          baseURL: 'https://api.anthropic.com/v1',
          models: ['claude-sonnet-4-6'],
          hasApiKey: true,
        },
      ],
    };
    const parsed = OpencodeConfigSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.binaryPath).toBe('/usr/local/bin/opencode');
  });
});
