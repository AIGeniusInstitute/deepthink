# 执行状态: opencode-binary-path

- **分支**: refactor/opencode-binary-path
- **worktree**: ~/deepthink/.worktrees/opencode-binary
- **开始**: 2026-07-17
- **状态**: 编码完成,进入测试验证

## 改动清单(已实施)

### 后端 src/
- [x] `runtime-config.ts`:`OpencodeConfig` 删 `bunPath`/`opencodePath`,新增 `binaryPath`;DEFAULT/get/save 同步
- [x] `schemas.ts`:`OpencodeConfigSchema` 字段替换
- [x] `routes/config.ts`:`/opencode/test` 改为 `spawn(binaryPath, ['--version'])`,返回 `version`
- [x] `container-runner.ts`:容器模式 + 宿主机模式 env 改 `OPENCODE_BINARY_PATH`;删 bun 自动安装分支;删 `saveOpencodeConfig`/`ensureBunInstalled` import
- [x] `index.ts`:删 `ensureBunInstalled` import + 启动期预热块
- [x] `bun-installer.ts`:已 `git rm`

### 容器 agent-runner
- [x] `container/agent-runner/src/opencode-engine.ts`:startServe 改 `binaryPath` + `spawn(binaryPath, ['serve', ...])`;runOpencodeEngine 读 `OPENCODE_BINARY_PATH`

### 前端 web/
- [x] `OpencodeEngineSection.tsx`:type/默认值/字段/UI/test 结果展示/说明文案 全部改为 binaryPath
- [x] `CodexEngineSection.tsx`:placeholder + 文案 跨平台(Mac/Ubuntu/Windows + which/where)

### 测试
- [x] `tests/units/opencode-config-roundtrip.test.ts`:fixture 改 binaryPath;新增 legacy 字段回归用例

## 残留验证(grep 已确认 clean)
- src/ 无 `bunPath`/`opencodePath`/`OPENCODE_BUN_PATH`/`OPENCODE_SOURCE_PATH`
- src/ 无 `ensureBunInstalled`/`bun-installer`
- web/src/ 无旧字段
- container/agent-runner/src/ 无旧字段

## 待办
- [ ] 运行 vitest 单元测试
- [ ] 运行 tsc 类型检查(根 + agent-runner)
- [ ] 前端构建
- [ ] 全仓最终 grep 残留检查
