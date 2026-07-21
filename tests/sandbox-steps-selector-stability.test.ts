import { describe, it, expect, vi } from 'vitest';

// ws.ts 在导入即构造 WsManager 单例时调用 window.addEventListener，
// 纯 node 环境无 window —— 在模块导入前补丁全局对象。
vi.hoisted(() => {
  if (typeof (globalThis as any).window === 'undefined') {
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { protocol: 'http:', host: 'localhost', pathname: '/' },
    };
  }
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    (globalThis as any).WebSocket = class {};
  }
});

import { useSandboxStore } from '../web/src/stores/sandbox';

/**
 * 回归测试：React error #185（Maximum update depth exceeded）根因锁定。
 *
 * 背景：BrowserUsePanel 使用 selector
 *   useSandboxStore((s) => s.agentSteps[sessionId] ?? [])
 * 读取某会话的 Agent 步骤。store 初始 `agentSteps: {}`，因此任意 sessionId
 * 对应值在首次都为 undefined，`?? []` 会在【每次 getSnapshot 调用】返回一个
 * 全新的 [] 引用。Zustand v5 底层基于 useSyncExternalStore，用 Object.is 比较
 * 前后快照：新引用 ≠ 旧引用 → 触发重渲染 → 再次调用 getSnapshot → 又返回新 []
 * → 无限循环 → React error #185。
 *
 * 正确做法：fallback 必须是稳定的模块级常量引用。
 */
describe('sandbox store: BrowserUsePanel steps selector stability (react #185)', () => {
  it('agentSteps 初始为空对象，任意 sessionId 对应值未定义', () => {
    const st = useSandboxStore.getState();
    expect(st.agentSteps).toEqual({});
    expect(st.agentSteps['sb-nonexistent']).toBeUndefined();
  });

  it('错误 selector（每次 new []）返回不稳定引用 —— 复现 #185 根因', () => {
    const buggy = (s: ReturnType<typeof useSandboxStore.getState>) =>
      s.agentSteps['sb-nonexistent'] ?? [];
    const a = buggy(useSandboxStore.getState());
    const b = buggy(useSandboxStore.getState());
    // 每次 call 都是新数组 → Object.is 判定为变化 → 触发无限重渲染
    expect(a).not.toBe(b);
  });

  it('正确 selector（稳定 fallback）返回稳定引用 —— 修复后不变量', () => {
    const EMPTY_STEPS: never[] = [];
    const fixed = (s: ReturnType<typeof useSandboxStore.getState>) =>
      s.agentSteps['sb-nonexistent'] ?? EMPTY_STEPS;
    const a = fixed(useSandboxStore.getState());
    const b = fixed(useSandboxStore.getState());
    expect(a).toBe(b); // 同一引用，Object.is 不触发重渲染
  });
});
