# 测试报告: opencode-binary-path

- **分支**: refactor/opencode-binary-path
- **worktree**: ~/deepthink/.worktrees/opencode-binary
- **测试日期**: 2026-07-17
- **结论**: ✅ 通过(目标改动全部验证通过;2 个无关失败为预存环境问题)

---

## 1. 测试范围

| 层级 | 目标 | 覆盖改动 |
|---|---|---|
| 单元测试 | opencode 配置契约 | runtime-config / schemas 字段替换、legacy 兼容 |
| 类型检查(根) | src/ 全量 | runtime-config/schemas/routes/config/container-runner/index |
| 类型检查(agent-runner) | container/agent-runner/src | opencode-engine.ts spawn 改造 |
| 类型检查(web) | web/src | OpencodeEngineSection / CodexEngineSection |
| 前端构建 | vite build | 前端字段+文案改造无运行时/构建错误 |
| 残留 grep | 全链路 | 确认旧字段/env/文件无残留 |

## 2. 执行结果

### 2.1 单元测试 ✅

```
npx vitest run tests/units/opencode-config-roundtrip.test.ts
Test Files  1 passed (1)
Tests       6 passed (6)
Duration    568ms
```

含新增回归用例 `legacy config with old bunPath/opencodePath fields does not break schema`:验证旧 `opencode.json`(含 `bunPath`/`opencodePath`)回存时 zod strip 未知键、`binaryPath` 可独立写入,不抛错。

### 2.2 类型检查 ✅

| 命令 | 退出码 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json`(根) | 0 |
| `npx tsc --noEmit -p container/agent-runner/tsconfig.json` | 0 |
| `npx tsc --noEmit -p web/tsconfig.json`(临时链接主检出 node_modules) | 0 |

### 2.3 前端构建 ✅

```
npx vite build
✓ built in 29.14s
PWA precache 81 entries
```

无 TSX/类型/构建错误。`SettingsPage` chunk 正常产出。

### 2.4 残留检查 ✅

`grep -rn "OPENCODE_BUN_PATH|OPENCODE_SOURCE_PATH|opencodePath|bunPath|ensureBunInstalled|bun-installer" src/ container/agent-runner/src/ web/src/ tests/` → 仅 `tests/units/opencode-config-roundtrip.test.ts` 的 legacy 兼容用例(刻意保留的旧字段 fixture)。

## 3. 无关失败项(非本次回归)

全量 `npx vitest run` 出现 2 个失败文件,经与 main 干净检出对比确认为**预存环境问题**,非本次改动引入:

| 失败 | 原因 | 证据 |
|---|---|---|
| `tests/chat-agent-messages.test.ts`(0 test,import 报错) | worktree 的 `web/node_modules` 未安装 `zustand` | main 检出跑同一测试同样报 `Cannot find package 'zustand'` |
| `tests/feishu-card.test.ts`(1 test 超时 5000ms) | 偶发,dynamic import 慢 | 单独重跑通过(191 passed) |

本次改动**不触及** feishu 卡片构建与 chat store,二者无因果关系。

## 4. 覆盖回归结论

- **G1 二进制化**:`opencode-engine.ts` spawn 已为 `<binaryPath> serve ...`,无 `bun`/`run` 前缀 ✅
- **G2 范式对齐**:三引擎(atomcode/codex/opencode)统一 `binaryPath` ✅
- **G3 Bun 下线**:`bun-installer.ts` 已删,启动期/容器/宿主三处均无 `ensureBunInstalled` 调用,`OPENCODE_BUN_PATH` env 消失 ✅
- **G4 Codex 跨平台**:placeholder 含 Mac/Ubuntu/Windows 三平台示例,文案含 `which`+`where` ✅
- **G5 向后兼容**:legacy 字段用例证明旧配置不致加载失败 ✅

## 5. 未覆盖项与说明

- `dist/`、`desktop/release/`、`container/agent-runner/dist/opencode-engine.js` 等已构建产物未在本期重建——由发布流程(`Makefile`/`container/build.sh`/桌面打包)统一重建,不在代码改动范围。需在发布前执行 `container/build.sh` 重建 agent-runner dist。
- 端到端引擎拉起测试(真实 `opencode serve`)需运行时环境,本期以「spawn 命令正确性 + 类型 + 配置契约」为验证边界;真实 serve 验证留待部署侧冒烟。

## 6. 建议的部署侧冒烟

1. 发布前 `cd container && bash build.sh` 重建 agent-runner dist。
2. 在设置页填入真实 `opencode` 二进制路径,点「测试 OpenCode」应返回版本号。
3. 群组切 engine=opencode 发一条消息,确认 `opencode-serve.log` 出现 `Spawning opencode serve: <binaryPath> serve ...`。
