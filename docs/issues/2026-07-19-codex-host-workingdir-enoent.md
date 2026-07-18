# Codex 引擎对话报错 `Host agent exited with code 1`：主机模式 workingDir 指向不存在的容器路径

- 日期：2026-07-19
- 影响范围：Web 端 http://127.0.0.1:5173/chat 选择 Codex 引擎（及 OpenCode 引擎）的全部对话失败；AtomCode / Claude 引擎不受影响
- 严重级别：P0（Codex 引擎完全不可用）
- 状态：已修复

## 1. 用户现象

在 http://127.0.0.1:5173/chat 切换到 Codex 引擎后，发送任何消息（`who are u` / `1+1=`）都没有响应，
前端弹出系统消息：

```
系统错误
Host agent exited with code 1: ...
```

随后：

```
admin Home 处理失败，已达最大重试次数
```

浏览器控制台可见 `POST http://127.0.0.1:5173/api/messages` 已完成加载，但后端 host agent 进程
反复以退出码 1 结束、重试耗尽。

## 2. 问题描述

DeepThink 的 agent-runner 在主机模式（host mode，非容器）下调用 Codex 引擎时，执行：

```ts
// container/agent-runner/src/codex-engine.ts
const workingDir = process.env.CODEX_WORKING_DIR?.trim() || WORKSPACE_GROUP; // '/workspace/group'
const args = ['exec', '--json', '--model', model, '--cd', workingDir];
const proc = spawn(binaryPath, args, { cwd: workingDir, ... });
```

`CODEX_WORKING_DIR` 由后端 `src/container-runner.ts` 在主机模式注入（行 1964，修复前）：

```ts
hostEnv['CODEX_WORKING_DIR'] = codexCfg.workingDir || groupDir;
```

而 `codexCfg.workingDir` 取自 `data/config/codex.json`，其默认值在 `src/runtime-config.ts:4196` 为
`/workspace/group`（容器内挂载路径）。持久化文件实测即为该值：

```json
{ "enabled": true, "binaryPath": "/home/me/.local/bin/codex", "defaultModel": "glm-5.2",
  "workingDir": "/workspace/group", ... }
```

由于 `/workspace/group` 是 truthy 字符串，`codexCfg.workingDir || groupDir` 的回退**永不触发**，
主机模式注入的 `CODEX_WORKING_DIR` 恒为 `/workspace/group`。但宿主机上 `/workspace` 目录并不存在
（该路径只在容器内由卷挂载产生）。于是 `spawn(..., { cwd: '/workspace/group' })` 抛出：

```
Error: spawn /home/me/.local/bin/codex ENOENT
  errno: -2, code: 'ENOENT', syscall: 'spawn /home/me/.local/bin/codex',
  path: '/home/me/.local/bin/codex'
```

该未捕获异常使 agent-runner 进程退出码 1 → `Host agent exited with code 1` → 重试耗尽 →
`admin Home 处理失败，已达最大重试次数`。

OpenCode 引擎存在完全相同的缺陷（`container-runner.ts:1998` 同样的死回退；`opencode.json` 的
`workingDir` 同样持久化为 `/workspace/group`；日志 `spawn /home/me/.local/bin/opencode ENOENT`）。
AtomCode 引擎不受影响——其主机模式注入直接用 `groupDir`（`container-runner.ts:1948`），
不读取 cfg.workingDir。

## 3. 根因

- **代码层面**：`src/container-runner.ts` 主机模式 env 注入处，`codexCfg.workingDir || groupDir`
  的 `||` 回退是死代码——`codexCfg.workingDir` 永远携带容器默认值 `/workspace/group`（truthy），
  回退分支永不执行。`groupDir` 这个真正可用的宿主机路径反而被覆盖。
- **配置层面**：`src/runtime-config.ts` 的 `DEFAULT_CODEX_CONFIG.workingDir = '/workspace/group'`
  是**容器内**路径，被当作通用默认写入用户配置；主机模式直接复用该值，导致 cwd 指向不存在的目录。
- **Node 行为**：`child_process.spawn` 在 `cwd` 目录不存在时抛 `spawn <cmd> ENOENT`，错误信息里
  显示的是命令路径而非真正缺失的 cwd 路径——这是 Node.js 的经典误导性错误，极易让人误判为
  「codex 二进制不存在」（实际二进制存在且可执行）。

外部依据：
- Node.js `child_process.spawn` 文档：当 `cwd` 选项指向不存在的目录会抛 ENOENT。
  https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
- 同仓库已合并的 `fix/codex-engine-dirname`（2026-07-18）修的是另一个 bug
  （ESM 下 `__dirname` 未定义），与本次 workingDir/cwd 问题无关；本次 bug 在该修复之后仍存在。

## 4. 复现路径

1. 确认宿主机不存在 `/workspace`：`ls /workspace` → 报「没有那个文件或目录」。
2. 确认 codex 二进制存在：`ls -la /home/me/.local/bin/codex` → 存在（~1.35GB）。
3. 确认持久化配置：`cat /home/me/.config/DeepThink/data/config/codex.json | grep workingDir`
   → `"workingDir": "/workspace/group"`。
4. 后端 `npm run dev` 启动后，浏览器访问 http://127.0.0.1:5173/chat，引擎选 Codex，发送 `1+1=`。
5. 查看最新 host 日志：`ls -t /home/me/.config/DeepThink/data/groups/main/logs/host-*.log | head -1 | xargs cat`
   → stderr 含 `spawn /home/me/.local/bin/codex ENOENT`、`Exit Code: 1`。

## 5. 诊断方法

```bash
# (a) 持久化的 workingDir 是否在宿主机存在
WORKING_DIR=$(grep -o '"workingDir": *"[^"]*"' /home/me/.config/DeepThink/data/config/codex.json | cut -d'"' -f4)
echo "codex workingDir = $WORKING_DIR"
ls -d "$WORKING_DIR"  # 若报 No such file/directory → 即为根因

# (b) 二进制本身是否存在（排除「二进制缺失」误判）
ls -la /home/me/.local/bin/codex && /home/me/.local/bin/codex --version

# (c) 最近一次 host agent 日志的关键行
ls -t /home/me/.config/DeepThink/data/groups/main/logs/host-*.log | head -1 | xargs grep -E 'ENOENT|Exit Code|cwd='
```

`(a)` 输出「不存在」+ `(b)` 输出正常 + `(c)` 出现 `ENOENT` 与 `cwd=/workspace/group`，即可确认本 bug。

## 6. 修复方案

主机模式 env 注入处加守卫：仅当 `cfg.workingDir` 在宿主机真实存在时采纳，否则回退 `groupDir`
（主机模式的 group 工作目录，等价于容器模式的 `/workspace/group` 卷挂载点）。

```diff
--- a/src/container-runner.ts
+++ b/src/container-runner.ts
@@ -1962,7 +1962,12 @@ export async function runHostAgent(input: ContainerInput): Promise<...> {
       hostEnv['CODEX_BINARY_PATH'] = codexCfg.binaryPath;
       hostEnv['CODEX_DEFAULT_MODEL'] = codexCfg.defaultModel;
-      hostEnv['CODEX_WORKING_DIR'] = codexCfg.workingDir || groupDir;
+      // Host 模式下 workingDir 必须是真实宿主机路径。codexCfg.workingDir 默认值
+      // '/workspace/group' 是容器内挂载路径，宿主机不存在 → spawn ENOENT。
+      // 仅当配置值在宿主机真实存在时采纳，否则回退到 groupDir。
+      hostEnv['CODEX_WORKING_DIR'] =
+        codexCfg.workingDir && fs.existsSync(codexCfg.workingDir)
+          ? codexCfg.workingDir
+          : groupDir;
```

OpenCode 引擎（`container-runner.ts:1998`）做完全对称的修复。

**选型理由**：
- **Surgical**：只动主机模式注入两行，不碰容器模式（`container-runner.ts:856/882` 的
  `|| '/workspace/group'` 保持不变，容器内该路径有效）、不碰 agent-runner、不碰 `runtime-config.ts`
  的默认值定义。
- **自愈**：已持久化的错误 `workingDir: '/workspace/group'` 无需数据库迁移——`fs.existsSync` 守卫
  在运行时自动回退到 `groupDir`。
- **保留扩展**：用户若显式配置了一个真实存在的宿主机目录，仍被尊重。
- **不选「改默认值为空」方案**：那需要额外迁移已持久化的 codex.json/opencode.json，且要同步改
  getCodexConfig 的回退；守卫方案一处改动同时覆盖两个引擎与历史配置，更小更稳。

## 7. 处理卡住的状态

- 若 `/chat` 仍显示旧的「思考中」转圈：刷新页面即可（前端状态未持久化）。
- 若 host agent 进程残留：`ps aux | grep agent-runner | grep -v grep`，必要时 `kill` 对应 PID；
  本 bug 不卡住进程（spawn 立即失败退出，无僵尸）。
- 修复后需重启后端 `npm run dev`（`tsx src/index.ts` 非 watch 模式）使 `container-runner.ts` 改动生效。

## 8. 经验沉淀 / 预防

- **「容器路径」与「主机路径」不可共用同一默认值**。任何同时服务于容器/主机两种执行模式的配置字段，
  其默认值应留空（意为「按执行模式取各自默认」），由各模式注入点分别补容器路径或主机路径。
  AtomCode 的写法（主机模式直接用 `groupDir`，不读 cfg.workingDir）是更稳的范式。
- **`spawn <cmd> ENOENT` 的第一怀疑对象是 cwd**，而非命令本身——尤其当 `which <cmd>` 能找到时。
  排查顺序：① 命令路径是否存在；② cwd 目录是否存在；③ PATH（仅当命令是裸名时）。
- **`a || b` 形式的回退要警惕「a 永远 truthy」**。当 a 来自一个有非空默认值的配置项时，
  `|| b` 实际是死代码；应改为显式存在性/有效性校验（如 `fs.existsSync`）。
- **巡检建议**：在 host agent preflight 阶段增加对 `workingDir` 的存在性断言，缺失时直接返回
  `hostModeSetupError`，把误导性的 `spawn ENOENT` 转为可读的配置错误提示。
