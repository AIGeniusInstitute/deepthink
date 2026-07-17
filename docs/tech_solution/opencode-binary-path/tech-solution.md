# 技术方案: OpenCode 引擎二进制化 + Codex 路径提示跨平台

- **需求**: opencode-binary-path
- **分支**: refactor/opencode-binary-path(worktree: `.worktrees/opencode-binary`)
- **方案版本**: v1
- **日期**: 2026-07-17

---

## 1. 设计原则

- **Simplicity First**:把两个路径字段(bun + 源码)收敛为一个 `binaryPath`,删掉 Bun 运行时依赖与自动安装器,不引入替代性的「opencode 二进制自动下载器」(本期不做)。
- **Surgical Changes**:只改与 opencode 路径链路、codex 提示文案直接相关的文件;不动 serve 协议、provider 生成、SSE 流、atomcode/codex 运行逻辑。
- **范式对齐**:`binaryPath` 字段名、校验风格、test 端点形态均对齐 `AtomcodeConfig`/`CodexConfig`。

## 2. 数据模型变更

### 2.1 `src/runtime-config.ts` — `OpencodeConfig`

**Before**:
```ts
export interface OpencodeConfig {
  enabled: boolean;
  bunPath: string;        // 删
  opencodePath: string;   // 删
  host: string;
  basePort: number;
  portRange: number;
  password: string;
  providerID: string;
  modelID: string;
  workingDir: string;
  providers: OpencodeProvider[];
  updatedAt: string | null;
}
```

**After**:
```ts
export interface OpencodeConfig {
  enabled: boolean;
  /** opencode 二进制绝对路径(与 atomcode/codex 的 binaryPath 一致) */
  binaryPath: string;
  host: string;
  basePort: number;
  portRange: number;
  password: string;
  providerID: string;
  modelID: string;
  workingDir: string;
  providers: OpencodeProvider[];
  updatedAt: string | null;
}
```

- `DEFAULT_OPENCODE_CONFIG`:`bunPath:''`/`opencodePath:''` → `binaryPath:''`。
- `getOpencodeConfig`:读 `parsed.binaryPath`(string 校验,缺省 `''`);旧字段因 `{...DEFAULT, ...parsed}` 仍可安全展开但被忽略 → 向后兼容。
- `saveOpencodeConfig`:合并 `binaryPath: typeof cfg.binaryPath === 'string' ? cfg.binaryPath : current.binaryPath`。
- `toPublicOpencodeConfig`:无逻辑变化(本就展开 rest),字段替换后自动生效。

### 2.2 `src/schemas.ts` — `OpencodeConfigSchema`

```ts
export const OpencodeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  binaryPath: z.string().max(512).optional(),     // 替换 bunPath/opencodePath
  host: z.string().max(64).optional(),
  ...
});
```

## 3. 后端路由变更 — `src/routes/config.ts`

### 3.1 `POST /api/config/opencode/test`

**Before**: `spawn(cfg.bunPath, ['--version'])` → 返回 `{ ok, bunVersion }`。
**After**: `spawn(cfg.binaryPath, ['--version'])` → 返回 `{ ok, version }`(与 `/codex/test` 字段命名对齐)。

- 空值守卫:`if (!cfg.binaryPath) return c.json({ ok:false, error:'OpenCode 二进制路径未配置' }, 200)`。
- 超时/错误处理保持原结构,仅替换命令与返回字段名。

## 4. 容器/宿主 env 注入 — `src/container-runner.ts`

### 4.1 容器模式 envLines(L869-903)

**Before**:
```ts
envLines.push(`OPENCODE_BUN_PATH=${opencodeCfg.bunPath}`);
envLines.push(`OPENCODE_SOURCE_PATH=${opencodeCfg.opencodePath}`);
```
**After**:
```ts
envLines.push(`OPENCODE_BINARY_PATH=${opencodeCfg.binaryPath}`);
```
- 校验:`if (!opencodeCfg.enabled || !opencodeCfg.binaryPath)` 抛错文案改为「...opencode binaryPath 为空...」。
- 删除 `if (!opencodeCfg.bunPath)` 的容器模式 bun 缺失分支(不再需要 bun)。

### 4.2 宿主机模式 hostEnv(L1995-2014)

**Before**:
```ts
if (!opencodeCfg.bunPath) {
  const { bunPath } = await ensureBunInstalled();
  opencodeCfg = saveOpencodeConfig({ bunPath });
  ...
}
hostEnv['OPENCODE_BUN_PATH'] = opencodeCfg.bunPath;
hostEnv['OPENCODE_SOURCE_PATH'] = opencodeCfg.opencodePath;
```
**After**:
```ts
if (!opencodeCfg.binaryPath) { throw new Error('OpenCode 引擎未启用或 binaryPath 为空。请在 设置 → OpenCode 引擎 中配置 opencode 二进制路径。'); }
hostEnv['OPENCODE_BINARY_PATH'] = opencodeCfg.binaryPath;
```
- 删除 `ensureBunInstalled` 导入与调用块。

## 5. 后端启动期 — `src/index.ts`

L10512-10514 `void ensureBunInstalled().then(...)` 预热块整段删除,连带其上方的注释/日志。

## 6. Bun 安装器下线 — `src/bun-installer.ts`

- 删除整个文件。
- 确认引用面:`grep -rn "bun-installer\|ensureBunInstalled\|BUN_BINARY_PATH\|BUN_VERSION" src/` 应只剩本文件;删除后再次 grep 确认无残留。

## 7. 容器 agent-runner — `container/agent-runner/src/opencode-engine.ts`

### 7.1 文件头注释(L9)

`spawn bun run <opencodePath> serve` → `spawn <binaryPath> serve`。

### 7.2 `startServe` 签名与实现(L213-258)

```ts
async function startServe(opts: {
  binaryPath: string;        // 替换 bunPath + opencodePath
  basePort: number;
  portRange: number;
  host: string;
  password: string;
  workingDir: string;
  log: (m: string) => void;
  logFile?: string;
}): Promise<{ baseUrl: string; process: ChildProcess; port: number }> {
  const { binaryPath, basePort, portRange, host, password, workingDir, log, logFile } = opts;
  if (!binaryPath) throw new Error('OPENCODE_BINARY_PATH is empty');
  if (!fs.existsSync(binaryPath)) throw new Error(`opencode binary not found at ${binaryPath}`);
  ...
  const args = ['serve', '--hostname', host || '127.0.0.1', '--port', String(port)];
  log(`Spawning opencode serve: ${binaryPath} ${args.join(' ')} (cwd=${workingDir})`);
  const proc = spawn(binaryPath, args, { stdio:['ignore','pipe','pipe'], cwd: workingDir, env: childEnv });
  ...
}
```

关键变化:`args` 去掉 `'run', opencodePath` 前缀;spawn 直接用 `binaryPath`。

### 7.3 `runOpencodeEngine`(L604-624)

```ts
const binaryPath = process.env.OPENCODE_BINARY_PATH?.trim() ?? '';
...
if (!binaryPath) {
  writeOutput({ status:'error', result:null,
    error:'OPENCODE_BINARY_PATH 未注入。请在 设置 → OpenCode 引擎 中配置 opencode 二进制路径,并确保群组 engine=opencode。',
    turnId });
  return;
}
```
L660 `startServe({ binaryPath, ... })`。

### 7.4 dist 产物

`container/agent-runner/dist/opencode-engine.js` 为构建产物,本期不手改;由 `container/build.sh` 重建。在测试报告中注明。

## 8. 前端变更 — `web/src/components/settings/`

### 8.1 `OpencodeEngineSection.tsx`

- 接口字段:`bunPath`/`opencodePath` → `binaryPath`;默认值同步。
- 删除「Bun 二进制路径」(L163-174)与「OpenCode 源码入口路径」(L176-187)两个 `<div>`。
- 新增单一「OpenCode 二进制路径」输入:
  - Label:`OpenCode 二进制路径`
  - id:`opencode-binary`
  - placeholder:`macOS: /opt/homebrew/bin/opencode · Linux: /usr/local/bin/opencode · Windows: %LOCALAPPDATA%\opencode\opencode.exe`
  - 文案:`opencode 二进制的绝对路径。macOS/Linux 可用 which opencode;Windows 可用 where opencode 查找。`
- 顶部描述(L143-147)去掉「需预装 Bun 运行时 + opencode 源码(Bun + TypeScript + Effect)」,改为「需预装 opencode 二进制(支持 serve 子命令)」。

### 8.2 `CodexEngineSection.tsx`(L144-153)

- placeholder(L149):
  `macOS: /opt/homebrew/bin/codex · Linux: /usr/local/bin/codex · Windows: %LOCALAPPDATA%\codex\codex.exe`
- 文案(L152):
  `Codex CLI 的绝对路径。macOS/Linux 可用 which codex;Windows 可用 where codex 查找。`

## 9. 测试变更 — `tests/units/opencode-config-roundtrip.test.ts`

- `baseConfig` fixture:`bunPath:'/bin/bun', opencodePath:''` → `binaryPath:'/usr/local/bin/opencode'`。
- 第 122-141 测试中 `bunPath:'/bin/bun'` → `binaryPath:'...'`。
- 新增 1 个回归用例:加载含旧字段(`bunPath`/`opencodePath`)的 parsed 对象时,`getOpencodeConfig` 风格的 `{...DEFAULT, ...parsed}` 展开不抛错、`binaryPath` 默认空。该用例用纯对象模拟,无需真实文件 IO。

## 10. 验证策略

| 层级 | 命令 | 通过标准 |
|---|---|---|
| 单元测试 | `npx vitest run tests/units/opencode-config-roundtrip.test.ts` | 全绿 |
| 全量单元 | `npm test`(若仓库根有) | 不新增失败 |
| 类型检查 | `npx tsc --noEmit`(根) + agent-runner tsconfig | 无 TS 报错 |
| 前端构建 | `cd web && npm run build` | 构建成功 |
| 残留 grep | `grep -rn "OPENCODE_BUN_PATH\|OPENCODE_SOURCE_PATH\|opencodePath\|bunPath\|ensureBunInstalled\|bun-installer" src/ container/agent-runner/src/ web/src/` | 无残留(opencode 链路) |

## 11. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/runtime-config.ts` | OpencodeConfig 字段 + get/save/public/默认 |
| `src/schemas.ts` | OpencodeConfigSchema |
| `src/routes/config.ts` | /opencode/test 端点 |
| `src/container-runner.ts` | env 注入两处 + 删 bun 自动安装分支 |
| `src/index.ts` | 删启动期 bun 预热 |
| `src/bun-installer.ts` | 整文件删除 |
| `container/agent-runner/src/opencode-engine.ts` | startServe + runOpencodeEngine |
| `web/src/components/settings/OpencodeEngineSection.tsx` | 字段 + UI |
| `web/src/components/settings/CodexEngineSection.tsx` | placeholder + 文案 |
| `tests/units/opencode-config-roundtrip.test.ts` | fixture + 新回归用例 |

## 12. 不改动项

- `dist/`、`desktop/release/`(由发布流程重建)
- atomcode / codex 引擎运行逻辑
- opencode serve 协议、provider `opencode.jsonc` 生成、MCP bridge、SSE stream 解析
- `container/agent-runner/dist/*`(构建产物)
