# PRD: OpenCode 引擎二进制化 + Codex 路径提示跨平台

- **需求编号**: opencode-binary-path
- **提出时间**: 2026-07-17
- **负责人**: Code Agent
- **状态**: 已确认方案,进入实施

---

## 1. 背景

DeepThink 支持三种 Agent 执行引擎:atomcode、codex、opencode。其中 atomcode 与 codex 已统一采用 **单一 `binaryPath` 二进制路径** 范式(直接 spawn 二进制,无外部运行时依赖)。唯独 **OpenCode 引擎仍依赖源码路径 + Bun 运行时**:

- 配置项 `bunPath`(Bun 可执行文件)+ `opencodePath`(opencode 源码入口 `packages/opencode/src/index.ts`)
- 启动方式:`bun run <opencodePath> serve --hostname ... --port ...`
- 副作用:必须预装 Bun v1.3.14+(后端启动期还会异步触发 `bun-installer` 自动下载),且要求宿主机上存在 opencode 源码仓库。

这导致:

1. **部署链路长**:用户需先装 Bun、再 clone opencode 源码、最后配置两个路径。
2. **范式不一致**:与 atomcode/codex 的「填一个二进制路径即可」体验割裂。
3. **运维负担**:Bun 版本升级、源码同步都是额外维护点。

此外,Codex 引擎设置页的路径提示仅覆盖 Unix:

- placeholder:`/opt/homebrew/bin/codex 或 ~/codex/target/release/codex`(无 Windows)
- 文案:`可通过 which codex 查找`(`which` 在 Windows 不存在)

DeepThink 桌面端明确支持 Mac/Ubuntu/Windows(见 `desktop/` 多平台构建产物),该提示对 Windows 用户无效。

## 2. 目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | OpenCode 引擎接入方式从「源码 + Bun」改为「单一二进制路径」 | 配置项收敛为 `binaryPath`;启动命令为 `<binaryPath> serve ...`;不再依赖 Bun 运行时与源码 |
| G2 | OpenCode 配置范式与 atomcode/codex 对齐 | 三引擎均用 `binaryPath` 字段,前端字段、后端 schema、env 注入方式一致 |
| G3 | Bun 自动安装逻辑随之下线 | `bun-installer` 不再被启动期或容器模式调用;`OPENCODE_BUN_PATH` env 不再注入 |
| G4 | Codex 路径提示兼容 Mac/Ubuntu/Windows | placeholder 与文案同时覆盖三平台,`which`/`where` 双命令 |
| G5 | 旧配置向后兼容 | 已有 `opencode.json` 的 `bunPath`/`opencodePath` 不致配置加载失败;读时缺 `binaryPath` 回退默认空值 |

## 3. 非目标

- 不改变 OpenCode 的 serve 协议、SSE 事件流、provider 配置生成逻辑(`opencode.jsonc` 写入逻辑保持不变)。
- 不改变 codex / atomcode 引擎的运行逻辑,仅改 codex 前端提示文案。
- 不引入 opencode 二进制的自动下载/安装器(本期用户手动填写二进制路径;自动安装留待后续迭代)。
- 不改造 `dist/`、`desktop/release/` 内已构建产物(由发布流程重建,不在本期代码改动范围)。

## 4. 用户故事

**US-1(运维/自部署用户)**:作为在 Mac 上自部署 DeepThink 的用户,我希望在「设置 → OpenCode 引擎」里只填一个 `opencode` 二进制路径就能启用引擎,无需再装 Bun、无需 clone opencode 源码仓库。

**US-2(Windows 用户)**:作为 Windows 用户,我希望 Codex 引擎设置页的路径提示能告诉我 Windows 下的默认安装路径和查找命令(`where codex`),而不是只给 Unix 的 `which codex`。

**US-3(已配置老用户)**:我已经配置过 OpenCode(含 `bunPath`/`opencodePath`),升级后引擎设置页不应白屏或报错,我能平滑迁移到新的 `binaryPath` 字段。

## 5. 功能需求

### 5.1 OpenCode 引擎二进制化

- **F1.1** 后端 `OpencodeConfig` 删除 `bunPath`、`opencodePath`,新增 `binaryPath: string`(语义:opencode 二进制绝对路径,与 atomcode/codex 一致)。
- **F1.2** `getOpencodeConfig` / `saveOpencodeConfig` / `toPublicOpencodeConfig` / `DEFAULT_OPENCODE_CONFIG` 同步更新字段;旧字段不再读/写(向后兼容:读时若存在旧字段则忽略,不抛错)。
- **F1.3** `OpencodeConfigSchema`(zod)用 `binaryPath` 替换两个旧字段。
- **F1.4** `/api/config/opencode/test` 端点:由 `spawn(bunPath, ['--version'])` 改为 `spawn(binaryPath, ['--version'])`;空值时返回「OpenCode 二进制路径未配置」。
- **F1.5** `container-runner.ts` 注入:用 `OPENCODE_BINARY_PATH=<binaryPath>` 替换 `OPENCODE_BUN_PATH`+`OPENCODE_SOURCE_PATH`;容器模式与宿主机模式(hostEnv)两处同步;删除容器模式下的 bun 自动安装分支(`ensureBunInstalled` 调用)。
- **F1.6** `container/agent-runner/src/opencode-engine.ts`:
  - `startServe` 参数从 `{ bunPath, opencodePath, ... }` 改为 `{ binaryPath, ... }`;
  - 启动命令从 `spawn(bunPath, ['run', opencodePath, 'serve', ...])` 改为 `spawn(binaryPath, ['serve', ...])`;
  - 校验从「bun/opencode 源码存在」改为「binaryPath 存在」;
  - env 读取 `OPENCODE_BINARY_PATH`,空值报错文案同步更新。
- **F1.7** 后端启动期 `index.ts` 的 `ensureBunInstalled()` 预热调用下线。
- **F1.8** `bun-installer.ts` 成为无人调用的死代码 → 删除该文件及其全部引用。
- **F1.9** 前端 `OpencodeEngineSection.tsx`:删「Bun 二进制路径」+「OpenCode 源码入口路径」两个输入,合并为单一「OpenCode 二进制路径」输入;描述文案同步去掉「需预装 Bun + 源码」表述。

### 5.2 Codex 路径提示跨平台

- **F2.1** `CodexEngineSection.tsx` placeholder 改为同时示例三平台路径(Mac homebrew / Linux usr-local / Windows AppData)。
- **F2.2** 提示文案改为:`macOS/Linux 可用 which codex;Windows 可用 where codex 查找。`

## 6. 数据迁移与兼容

- 旧 `opencode.json`(含 `bunPath`/`opencodePath`)在升级后:`getOpencodeConfig` 通过 `{ ...DEFAULT, ...parsed }` 展开,旧字段被新 schema 忽略,`binaryPath` 缺省为空字符串 → 用户需重新填写一次 `binaryPath`。不抛错、不白屏。
- 不做旧→新字段自动映射(Bun 路径 ≠ opencode 二进制路径,无法可靠转换),仅在升级说明里提示用户重新配置。

## 7. 验收清单

- [ ] `OpencodeConfig` / schema / 前端 type 三处字段一致,均含 `binaryPath`,无 `bunPath`/`opencodePath`。
- [ ] `opencode-engine.ts` spawn 命令为 `<binaryPath> serve ...`,无 `bun`/`run` 参数。
- [ ] `OPENCODE_BINARY_PATH` 注入两处(container + host),`OPENCODE_BUN_PATH`/`OPENCODE_SOURCE_PATH` 全仓消失。
- [ ] `bun-installer.ts` 已删除,无残留引用。
- [ ] Codex 前端 placeholder 含三平台示例,文案含 `which`+`where`。
- [ ] 单元测试通过(含更新后的 fixture);`npm run typecheck`/构建通过。
- [ ] 旧 `opencode.json` fixture 加载不抛错。

## 8. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 已用源码方式跑通的老用户升级后引擎失效 | 中 | 字段不自动迁移但加载不报错;设置页提示重新配置;技术方案记录迁移说明 |
| opencode 二进制在不同平台 `serve` 子命令/参数与源码版一致 | 中 | 改造前已确认 opencode CLI 二进制支持 `serve --hostname --port`(与源码入口一致) |
| `dist/`、`desktop/release/` 旧产物仍含旧逻辑 | 低 | 由发布流程重建,本期不动;在测试报告中注明 |
| 删除 bun-installer 误伤其他调用方 | 低 | 已确认仅 opencode 链路引用,全仓 grep 验证无残留 |
