# 2026-09-29 — `make start-prod` 编译失败：StreamEvent 类型只加到了同步副本，没加到真相源

## 1. 用户现象

执行 `./scripts/rebuild-restart.sh 9999`，Docker 镜像重建 558s 全部成功，随后进入后端编译阶段直接失败：

```
🔄 检测到 shared/ 类型变更，同步类型...
🔨 检测到后端源码变更，重新编译后端...
npm notice run tsc
src/agent-group/swarm-runner.ts:166:42 - error TS2345: Argument of type '"group_thinking_delta"' is not assignable to parameter of type 'StreamEventType'.
src/agent-group/swarm-runner.ts:179:42 - error TS2345: Argument of type '"group_tool_call"' is not assignable to parameter of type 'StreamEventType'.
src/agent-group/swarm-runner.ts:200:42 - error TS2345: Argument of type '"group_tool_result"' is not assignable to parameter of type 'StreamEventType'.
src/agent-group/swarm-runner.ts:234:42 - error TS2345: Argument of type '"group_token_usage"' is not assignable to parameter of type 'StreamEventType'.
Found 4 errors in the same file, starting at: src/agent-group/swarm-runner.ts:166

make[2]: *** [_build-backend-if-stale] Error 2
make: *** [start-prod] Error 2
```

服务起不来（旧实例已被脚本停掉，端口 9999 空置）。4 个报错全部集中在 `swarm-runner.ts`，看起来像"某次改动漏了类型定义"。

## 2. 问题描述

`src/agent-group/swarm-runner.ts` 需要把席位（seat）的流式事件翻译成群组级事件，用到了 `group_thinking_delta` / `group_tool_call` / `group_tool_result` / `group_token_usage` 四种 `StreamEventType`。

这四种类型在**提交时确实存在**，但只存在于 `shared/stream-event.ts` 的**构建产物副本**里，真相源里没有。构建流程的 `_check-sync` 目标检测到 `shared/` 比副本新，执行 `make sync-types`，把副本按真相源**无条件覆盖** → 4 个类型从类型联合中凭空消失 → 生产者（`swarm-runner.ts`）与消费者（`web/src/components/agent-group/GroupChatArea.tsx`）同时类型报错，后端编译中断。

关键点：**这是"改副本 = 白改"的教科书案例**（CLAUDE.md §3.2 / §10 明令禁止），只是它没有在提交时暴露，而是延迟到下一次构建 sync 才爆。

## 3. 根因

### 3.1 代码层面

`git show HEAD:shared/stream-event.ts`（真相源）与 `git show HEAD:src/stream-event.types.ts`（副本）在同一个位置**不一致**：

```diff
   | 'group_seat_status' | 'group_floor_changed'
+  | 'group_thinking_delta' | 'group_tool_call' | 'group_tool_result' | 'group_token_usage'
   | 'run_started' | 'run_status_changed' | 'run_completed';
```

差分只出现在副本一侧，且是 commit **11bd17f**（`fix: 修复 Agent Group Chat 辩论上下文传递 + execution_mode + Docker 部署`）引入的：

```
 container/agent-runner/src/stream-event.types.ts   |   1 +     ← 手改了副本
 src/stream-event.types.ts                          |   1 +     ← 手改了副本
 web/src/stream-event.types.ts                      |   1 +     ← 手改了副本
 shared/stream-event.ts                             |           ← 真相源没动 ❌
```

`web/src/stream-event.types.ts` 同样在后续提交中以同样方式被手改。

### 3.2 基础设施层面（为什么没在提交时被抓到）

- `make sync-types`（`scripts/sync-stream-event.sh`）的语义是 `cmp -s` 不一致就 `cp` 覆盖——**单向、静默、无告警**。副本里的手改内容会被无声抹掉，不会报错。
- 一致性校验 `scripts/check-stream-event-sync.sh` **只在 `make typecheck` 时执行**（`Makefile:361`）。而 `make start-prod` → `_start-direct` 的构建链路是 `_check-sync → _build-*-if-stale`（`Makefile:193-196`），**跑的是 sync 而不是 check**。也就是说：构建路径上不存在"先校验再覆盖"这个动作。
- CI 门禁 `make test-smoke` 只跑 10 个测试文件，不含 `tsc`，所以副本漂移也无法在 PR 阶段被拦截。

触发条件（任一即可）：`shared/*.ts` 被 touch（mtime 变新）、或副本被 touch。本例是开发过程中 `shared/` 的 mtime 变新，被 `_check-sync` 的 `find shared/ -newer <target>` 命中。

> 外部依据：[CLAUDE.md §3.2 流式显示管道](../../CLAUDE.md)明确"`shared/` 下任何一个文件都是单向同步源，它在 `src/`、`web/src/`、`container/agent-runner/src/` 下的同名副本会在 `make build` / `make sync-types` 时被**无条件覆盖**。改副本 = 白改。"

## 4. 复现路径

```bash
cd /Users/edy/deepthink

# 1) 确认漂移：真相源没有 4 个类型，副本有
grep -c group_token_usage shared/stream-event.ts \
  src/stream-event.types.ts web/src/stream-event.types.ts \
  container/agent-runner/src/stream-event.types.ts
# 修复前输出：shared=0，三个副本=1

# 2) 触发同步（等价于 make start-prod 里的 _check-sync）
make sync-types

# 3) 编译后端 → 复现 4 个 TS2345
npm run build
```

步骤 3 会原样输出第 1 节里的 4 条 `TS2345`。修好后同一条命令输出 `BUILD_EXIT=0`。

## 5. 诊断方法

```bash
# 真相源 vs 三个副本的一致性（应在 sync 前跑，能直接看出漂移）
./scripts/check-stream-event-sync.sh

# 只看类型联合这一行
grep -n "group_seat_status" shared/stream-event.ts src/stream-event.types.ts \
  web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts

# 谁手改了副本（找罪魁）
git log --oneline -5 -- src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts

# 谁在用这 4 个事件类型（生产者 + 前端消费者）
grep -rn "group_thinking_delta\|group_tool_call\|group_tool_result\|group_token_usage" \
  src web/src container/agent-runner/src shared | grep -v stream-event.types.ts
```

## 6. 修复方案

**唯一改动：把 4 个事件类型补进真相源 `shared/stream-event.ts`，再跑 `make sync-types` 让三个副本由源头生成。**

```diff
 // shared/stream-event.ts
   | 'group_message_created' | 'group_message_delta' | 'group_message_done'
   | 'group_seat_status' | 'group_floor_changed'
+  | 'group_thinking_delta' | 'group_tool_call' | 'group_tool_result' | 'group_token_usage'
   | 'run_started' | 'run_status_changed' | 'run_completed';
```

选型理由：

- **只改真相源，不动副本**——这是 CLAUDE.md 的硬约束；改副本下次 sync 必被覆盖，属于重复踩坑。
- **不删除 `swarm-runner.ts` 里的用法**——这 4 个事件是 Agent Group Chat 流式辩论（"看到前序席位的思考/工具调用")的真实能力，`web/src/components/agent-group/GroupChatArea.tsx:307-437` 已实现对应渲染，删掉等于回退刚验收的功能。
- **副本被 sync 重新生成后与 HEAD 逐字节相同**——所以本次 commit 的有效改动只有 `shared/stream-event.ts` 的 1 行（`git diff --stat` 实测），无额外噪音。

验证证据：

| 步骤 | 结果 |
|---|---|
| 复现（真相源无类型 + `make sync-types` + `npm run build`） | 4 条 `TS2345`，与线上报错逐字一致 |
| 修复后 `make sync-types` + `./scripts/check-stream-event-sync.sh` | `All shared type copies are in sync.` |
| 修复后 `npm run build`（后端） | 退出码 0，`dist/index.js` 生成 |
| `make typecheck`（后端 + 前端 + agent-runner 三项目） | 全部通过 |
| `make test-smoke`（CI 门禁 10 文件） | 122 passed |
| `make test`（全量 148 文件 / 1725 用例） | `1 failed | 144 passed | 3 skipped` —— 唯一失败 `tests/feishu-card.test.ts` 为已知超时抖动，单文件重跑 94 passed 全绿 |

## 7. 处理卡住的状态

不需要。本次是**启动期编译失败**，进程根本没起来（旧实例已被 `rebuild-restart.sh` 正常 SIGTERM 停掉，见 `logs/deepthink-9999.log` 的 `Shutdown complete`），没有残留的 stuck 运行态。修完重跑 `./scripts/rebuild-restart.sh 9999` 即可。

## 8. 经验沉淀 / 预防

1. **新增 `StreamEventType` 永远只改 `shared/stream-event.ts`**，然后 `make sync-types`。判据：`git diff` 里如果出现 `src/stream-event.types.ts` / `web/src/stream-event.types.ts` / `container/agent-runner/src/stream-event.types.ts` 的改动，**本次提交就是错的**（这三个文件与真相源内容应由 sync 生成，不应单独出现在 diff 中）。可加一条 pre-commit 检查：diff 命中这三个路径即拒绝提交并提示"改 shared/"。

2. **把一致性校验前移到构建链路的 sync 之前**（当前只在 `make typecheck` 跑，`Makefile:361`）。建议在 `_check-sync`（`Makefile:246`）里先跑 `./scripts/check-stream-event-sync.sh`，校验失败就**报错中止**，而不是静默 `sync-types` 覆盖——把"副本漂移"暴露成一条明确的错误信息，而不是延迟到 tsc 阶段变成 4 条莫名其妙的 `TS2345`。这是一处构建脚本改动，本次未实施（保持修复外科手术式最小化），建议单独提一个改动。

3. **CI 门禁补 `tsc`**：`make test-smoke` 只跑 10 个测试文件，不编译。类型层漂移要到 `make build` 才暴露。若能接受几十秒的耗时，把 `make typecheck-backend` 加入 PR 门禁可提前拦截同类问题（`make typecheck` 已含 `check-stream-event-sync.sh`）。

4. **同类风险面**：`shared/` 下另有 `image-detector.ts`、`channel-prefixes.ts` 也是单向真相源，有完全相同的失效模式（见 CLAUDE.md §3.2）。第 1、2 条同样适用。
