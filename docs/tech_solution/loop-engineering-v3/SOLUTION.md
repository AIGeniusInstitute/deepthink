# 技术方案：Loop Engineering v3 — 验收加固与单测补齐

分支：`feat/loop-engineering-v3`
关联 PRD：`docs/prd/loop-engineering-v3/PRD.md`
作者：AI Coder
日期：2026-07-08

## 1. 整体策略

**Surgical Changes 原则**：本期不重写 v2 任何业务代码，只对 4 个纯解析函数加 `export` 关键字（每个函数 1 个 token 改动），并新增 2 个测试文件。改动面 < 100 行，零行为变更。

```
v2 现状（main HEAD）
  │
  ├── src/loop-commands.ts       parseMaxTurns  (private)
  ├── src/loop-commands.ts       parseWorkflow  (private)
  ├── src/loop-orchestrator.ts   parseSuggestedExt (private)
  ├── src/supervisor.ts          parseDecision  (private)
  │
  ▼  v3 改动
  ├── 加 export 关键字（4 处，4 行改动）
  ├── tests/units/loop-engineering.test.ts  +3 describe, +11 test
  └── tests/units/supervisor-decision.test.ts  新建, 1 describe, 6 test
```

## 2. v2 验收证据矩阵

### 2.1 需求 1：四类循环

```
点 🎯 目标 chip
  → LoopModeSwitcher.tsx mode='goal'
  → onSend 构造 "/goal <目标> max_turns=N"
  → POST /api/chat/send
  → index.ts dispatch 'goal' (1500 附近)
  → handleGoalCommand → createLoopRunRecord + executeGoalLoop (后台)
  → 返回 { reply, loopRunId }
  → attachments.loop_card 写入
  → MessageBubble 检测 → InlineLoopCard 渲染
```

| 证据点 | 文件:行 | 验证 |
|--------|---------|------|
| UI 入口 | `web/src/components/chat/ChatView.tsx` | 挂载 `<LoopModeSwitcher />` |
| 4 chip | `web/src/components/chat/LoopModeSwitcher.tsx` | chat / goal / time / proactive |
| 命令分发 | `src/index.ts` | dispatch 'goal' / 'loop' / 'schedule' / 'proactive' / 'adaptive' / 'skill_evolution' |
| 状态机 | `src/loop-orchestrator.ts` | `executeGoalLoop` / `executeAdaptiveLoop` / `executeSkillEvolutionLoop` |
| 命令解析 | `src/loop-commands.ts` | `handleGoalCommand` / `handleLoopCommand` / `handleScheduleCommand` / `handleProactiveCommand` |

### 2.2 需求 2：DAG + 自适应 + 技能自进化

| 证据点 | 文件:行 | 验证 |
|--------|---------|------|
| 内联卡片 | `web/src/components/chat/MessageBubble.tsx` | `attachments.loop_card` 分支 |
| 卡片实现 | `web/src/components/loops/InlineLoopCard.tsx` | 5s 轮询 + 取消按钮 |
| DAG 渲染 | `web/src/components/loops/LoopDagPanel.tsx` | SVG 横向流程 + 边 |
| 节点抽屉 | `web/src/components/loops/LoopDagPanel.tsx` | `TraceDetailDrawer` |
| 编辑回写 | `src/routes/loops.ts:129` | `PATCH /api/loops/:id/trace/:nodeId` |
| edited_at 列 | `src/db.ts` | `loop_trace_nodes.edited_at` ensureColumn |
| adaptive | `src/loop-orchestrator.ts:595` | `executeAdaptiveLoop` |
| skill_evolution | `src/loop-orchestrator.ts:747` | `executeSkillEvolutionLoop` |

### 2.3 需求 3：Supervisor

| 证据点 | 文件 | 验证 |
|--------|------|------|
| 顶栏开关 | `web/src/components/chat/SupervisorToggle.tsx` | 持久化 per-group |
| 挂载点 | `web/src/components/chat/ChatView.tsx` | `<SupervisorToggle />` |
| 决策逻辑 | `src/supervisor.ts` | `runSupervisorPreDispatch` → `parseDecision` |
| 配置 | `src/supervisor-config.ts` | `isSupervisorEnabled` 默认 false |
| SubAgent | `container/agent-runner/src/agent-definitions.ts` | `supervisor` 定义 |
| 路由 | `src/routes/config.ts` | `GET/PUT /api/config/supervisor` |
| 消息渲染 | `web/src/components/chat/MessageBubble.tsx` | `source_kind === 'supervisor'` 紫色 🧭 |

### 2.4 需求 4：顶栏宣传语

```
ChatView.tsx:568
  isDefaultHomeName(group.name, currentUser?.username) ?
    <SloganRotator />  // 15s 轮播 5 条宣传语
    : <h2>{group.name}</h2>  // 自定义组名保留
```

| 证据点 | 文件:行 | 验证 |
|--------|---------|------|
| 条件分支 | `web/src/components/chat/ChatView.tsx:568` | `isDefaultHomeName` 三元 |
| 宣传语列表 | `web/src/components/chat/SloganRotator.tsx` | `SLOGANS` 5 条 |
| 轮播间隔 | `web/src/components/chat/SloganRotator.tsx` | `ROTATE_MS = 15_000` |
| 记忆 | `web/src/components/chat/SloganRotator.tsx` | `STORAGE_KEY = 'deepthink:slogan-index'` |
| 归一化判定 | `web/src/components/chat/SloganRotator.tsx` | `isDefaultHomeName` 排除 'Main' / '${username} Home' / 空串 |

## 3. 实施细节

### 3.1 导出 4 个纯函数（4 行改动）

**`src/loop-commands.ts`**：

```diff
- function parseMaxTurns(args: string): { maxTurns: number; rest: string } {
+ export function parseMaxTurns(args: string): { maxTurns: number; rest: string } {

- function parseWorkflow(args: string): { mode: 'parallel' | 'sequential'; rest: string } {
+ export function parseWorkflow(args: string): { mode: 'parallel' | 'sequential'; rest: string } {
```

**`src/loop-orchestrator.ts`**：

```diff
- function parseSuggestedExt(suggestion: string): number {
+ export function parseSuggestedExt(suggestion: string): number {
```

**`src/supervisor.ts`**：

```diff
- function parseDecision(raw: string): SupervisorDecision | null {
+ export function parseDecision(raw: string): SupervisorDecision | null {
```

**为什么不重构**：4 个函数均为纯解析，无副作用，v2 已在生产使用。本期导出仅为测试可见，不改变调用方、不改变实现。

### 3.2 测试文件 1：扩展 `tests/units/loop-engineering.test.ts`

在文件末尾追加 3 个 describe 块（不动既有 4 个 describe）：

```ts
import { parseMaxTurns, parseWorkflow } from '../../src/loop-commands.js';
import { parseSuggestedExt } from '../../src/loop-orchestrator.js';

describe('loop-commands: parseMaxTurns', () => {
  test('parses explicit max_turns=N', () => {
    const r = parseMaxTurns('some goal max_turns=7');
    expect(r.maxTurns).toBe(7);
    expect(r.rest).toBe('some goal');
  });
  test('defaults to 5 when absent', () => {
    const r = parseMaxTurns('some goal');
    expect(r.maxTurns).toBe(5);
    expect(r.rest).toBe('some goal');
  });
  test('clamps 0 to 1', () => {
    const r = parseMaxTurns('goal max_turns=0');
    expect(r.maxTurns).toBe(1);
  });
  test('clamps over-limit to 10', () => {
    const r = parseMaxTurns('goal max_turns=99');
    expect(r.maxTurns).toBe(10);
  });
});

describe('loop-commands: parseWorkflow', () => {
  test('parses parallel', () => {
    const r = parseWorkflow('goal workflow=parallel');
    expect(r.mode).toBe('parallel');
    expect(r.rest).toBe('goal');
  });
  test('parses sequential', () => {
    const r = parseWorkflow('goal workflow=sequential');
    expect(r.mode).toBe('sequential');
  });
  test('defaults to sequential', () => {
    const r = parseWorkflow('goal');
    expect(r.mode).toBe('sequential');
  });
});

describe('loop-orchestrator: parseSuggestedExt', () => {
  test('parses next_turns=3', () => {
    expect(parseSuggestedExt('next_turns=3')).toBe(3);
  });
  test('parses numeric prefix', () => {
    expect(parseSuggestedExt('2 more turns')).toBe(2);
  });
  test('returns 0 for empty', () => {
    expect(parseSuggestedExt('')).toBe(0);
  });
  test('returns 0 for invalid', () => {
    expect(parseSuggestedExt('no number here')).toBe(0);
  });
});
```

### 3.3 测试文件 2：新建 `tests/units/supervisor-decision.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { parseDecision } from '../../src/supervisor.js';

describe('supervisor: parseDecision', () => {
  test('parses clarify', () => {
    const d = parseDecision('{"action":"clarify","question":"哪个项目?"}');
    expect(d?.action).toBe('clarify');
    expect(d?.question).toBe('哪个项目?');
  });
  test('parses delegate', () => {
    const d = parseDecision('{"action":"delegate","instruction":"跑测试"}');
    expect(d?.action).toBe('delegate');
    expect(d?.instruction).toBe('跑测试');
  });
  test('parses auto', () => {
    const d = parseDecision('{"action":"auto","instruction":"优化后指令"}');
    expect(d?.action).toBe('auto');
  });
  test('strips markdown fences', () => {
    const d = parseDecision('```json\n{"action":"delegate","instruction":"x"}\n```');
    expect(d?.action).toBe('delegate');
    expect(d?.instruction).toBe('x');
  });
  test('returns null for invalid JSON', () => {
    expect(parseDecision('not json')).toBeNull();
  });
  test('returns null for unknown action', () => {
    expect(parseDecision('{"action":"maybe"}')).toBeNull();
  });
});
```

## 4. 验证流程

```
1. git checkout feat/loop-engineering-v3（基于 main）
2. npm rebuild better-sqlite3  # 若 native module 版本不匹配
3. make typecheck              # 期望全绿
4. npx vitest run              # 期望 1078 + 17 = 1095 通过 / 1 预存失败
5. grep 静态复核 4 项需求      # 期望全部命中
6. 写测试报告
7. commit + push + 合并 main + push
```

## 5. 回滚策略

若新增测试发现 v2 bug，则：
- 轻微 bug（解析边界）：本期直接修
- 严重 bug（状态机崩溃）：本期回滚测试，单独开 issue 修 v2

## 6. 不做的事

- 不改 v2 业务代码
- 不改 UI 组件
- 不改 DB schema
- 不改路由
- 不改 IM 协议
- 不修 feishu-card.test.ts 超时（预先存在失败，单独 issue）
