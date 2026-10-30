# 工作区指定本机目录后，Agent 实际仍跑在 data/groups/{folder} 默认目录

> 日期：2026-10-30 · 关联需求：`docs/prd/workspace-local-dir/PRD.md`（v1.8.3 功能「工作区目录支持选择用户本机目录」）· 影响面：桌面版 / `start-prod` / `bootstrap.sh` 等设置了 `DEEPTHINK_DATA_DIR` 的部署，host 与 container 两种执行模式

## 1. 用户现象

创建工作区时选定了本机目录（如 `C:\Users\chenguangjian\mi`），保存成功、文件面板也以该目录为根；但 Agent 实际干活时读写的仍是平台默认目录 `安装目录/data/groups/{folder}`（如 `data/groups/main/xxx`、`data/groups/flow-mvtiwlx4-mbdk/xxx`），用户指定的真实项目目录里什么都没发生。

## 2. 问题描述

工作区根目录的解析在两处各有一套：

- **launcher 侧（`src/container-runner.ts`）**：`resolveWorkspaceRoot(group)` = `customCwd || data/groups/{folder}`，解析正确，并把结果注入 agent-runner 子进程的 `DEEPTHINK_WORKSPACE_GROUP` env（host 运行日志头也正确打印 `Working Directory: C:\Users\chenguangjian\mi`）。
- **runner 侧（`container/agent-runner/src/index.ts` 的 `processOneTask`）**：存在一个「分布式共享 PVC」分支——只要 `DEEPTHINK_DATA_DIR` 非空，就按 `DATA_DIR/groups/{groupFolder}` **无条件重算** `WORKSPACE_GROUP`（连同 `WORKSPACE_IPC` / `WORKSPACE_GLOBAL` / `WORKSPACE_MEMORY` 一并覆盖），把 launcher 的决定整个丢弃。

于是 SDK `query({ cwd: WORKSPACE_GROUP })` 拿到的是重算后的默认目录，Agent 全程在 `data/groups/{folder}` 里读写文件。

## 3. 根因

`container/agent-runner/src/index.ts`（修复前）：

```ts
const DATA_DIR = process.env.DEEPTHINK_DATA_DIR || '';
...
if (DATA_DIR && containerInput.groupFolder) {
  const gf = containerInput.groupFolder;
  WORKSPACE_GROUP = path.join(DATA_DIR, 'groups', gf);   // ← 无条件覆盖，customCwd 丢失
  WORKSPACE_IPC = path.join(DATA_DIR, 'ipc', gf);        // ← sub-agent/tasks-run IPC 命名空间被抹平
  WORKSPACE_GLOBAL = containerInput.workspaceGlobal || path.join(DATA_DIR, 'groups', 'global');
  WORKSPACE_MEMORY = containerInput.workspaceMemory || path.join(DATA_DIR, 'memory', gf);
}
```

该分支本意是给 K8s 分布式 agent-runner pod 用的（pod 用共享 PVC 的 `DATA_DIR` 布局），但它把「`DEEPTHINK_DATA_DIR` 存在」当成了「分布式模式」的唯一判据。而：

1. **桌面版恒设 `DEEPTHINK_DATA_DIR`**：`desktop/src/backend-supervisor.ts` 的 `buildEnv()` 无条件注入 `DEEPTHINK_DATA_DIR: dataDir`；`make start-prod` / `scripts/bootstrap.sh` / `scripts/deepthink-watchdog.sh` 同样显式导出它。
2. **host 模式子进程继承整个 `process.env`**：`src/container-runner.ts` 的 `hostEnv = { ...process.env }`，`DEEPTHINK_DATA_DIR` 原样漏给 agent-runner。
3. `ContainerInput` 当时**没有** `workspaceGroup` 字段，runner 只能靠 env / 推导拿工作区根，PVC 分支又把 env 判负。

结果：`custom_cwd` 只要在设置了 `DEEPTHINK_DATA_DIR` 的部署里就必然失效；只有裸 `make start`（不带该 env）才碰巧正确。

**证据链**（桌面版真实运行态，组 `web:3c4fef58-…`，folder=`flow-mvtiwlx4-mbdk`，`custom_cwd=C:\Users\chenguangjian\mi`，host 模式）：

1. DB：`registered_groups.custom_cwd = C:\Users\chenguangjian\mi`（配置本身正确）。
2. host 运行日志头：`data/groups/flow-mvtiwlx4-mbdk/logs/host-2026-10-29T13-35-58-570Z.log` → `Working Directory: C:\Users\chenguangjian\mi`（launcher 解析正确）。
3. SDK transcript 目录：`data/sessions/flow-mvtiwlx4-mbdk/.claude/projects/C--Users-chenguangjian-AppData-Roaming-DeepThink-data-groups-flow-mvtiwlx4-mbdk` —— Claude CLI 的 projects 目录按 cwd 编码（非字母数字全部替换为 `-`），该编码串**唯一对应** cwd `C:\Users\chenguangjian\AppData\Roaming\DeepThink\data\groups\flow-mvtiwlx4-mbdk`（= `DATA_DIR/groups/{folder}`），且整个会话生命周期内不存在 customCwd 的编码目录（`C--Users-chenguangjian-mi`）。
4. `path.join(DATA_DIR, 'groups', gf)` 恰好就是 PVC 分支的输出值——与 ③ 逐字符吻合。

## 4. 复现路径

1. 桌面版（或 `DEEPTHINK_DATA_DIR=~/.deepthink/data make start`）启动 DeepThink。
2. 以 admin 登录，新建工作区 → 高级选项 → 工作区来源选「使用本机目录」，选 `~/mi`（挂载白名单内），执行模式 host（或 container）。
3. 在该工作区发一条消息，让 Agent 创建/写入任意文件（如「在当前目录建 a.txt」）。
4. 观察：文件出现在 `data/groups/{folder}/a.txt`，`~/mi/` 里没有。
5. 佐证：`ls data/sessions/{folder}/.claude/projects/` 只有 `C--…-data-groups-{folder}` 编码目录。

## 5. 诊断方法

```bash
# ① 确认该组配置了 custom_cwd
sqlite3 "$DATA_DIR/db/messages.db" \
  "SELECT jid, folder, execution_mode, custom_cwd FROM registered_groups;"

# ② 看 SDK 实际 cwd（transcript 目录按 cwd 编码）：
ls "$DATA_DIR/sessions/{folder}/.claude/projects/"
# 若只有 C--…-data-groups-{folder} 而没有 customCwd 的编码目录 → 命中本 bug

# ③ 复核 host 日志头的意图值（应为 customCwd）
grep "Working Directory" "$DATA_DIR/groups/{folder}/logs/"host-*.log
```

## 6. 修复方案

原则：**工作区根只由 launcher 解析一次（`resolveWorkspaceRoot`），并经 `ContainerInput.workspaceGroup` 显式下发；runner 侧的 PVC 推导只兜底空缺，绝不覆盖显式值。**

```diff
// container/agent-runner/src/utils.ts —— 新增纯函数（可单测）
+export function resolveTaskWorkspaces(input, opts): TaskWorkspacePaths
+// 优先级：payload > env（DEEPTHINK_WORKSPACE_*）> PVC 推导（DEEPTHINK_DATA_DIR）> 容器默认

// container/agent-runner/src/index.ts —— PVC 分支改为调用上述解析
-    if (DATA_DIR && containerInput.groupFolder) {
-      const gf = containerInput.groupFolder;
-      WORKSPACE_GROUP = path.join(DATA_DIR, 'groups', gf);
-      WORKSPACE_IPC = path.join(DATA_DIR, 'ipc', gf);
-      WORKSPACE_GLOBAL = containerInput.workspaceGlobal || path.join(DATA_DIR, 'groups', 'global');
-      WORKSPACE_MEMORY = containerInput.workspaceMemory || path.join(DATA_DIR, 'memory', gf);
-      ...
-    }
+    const taskWorkspaces = resolveTaskWorkspaces(containerInput, {
+      env: { group: process.env.DEEPTHINK_WORKSPACE_GROUP, ... },
+      dataDir: DATA_DIR,
+    });
+    WORKSPACE_GROUP = taskWorkspaces.group;
+    ...

// src/container-runner.ts —— launcher 显式下发（host 传宿主机路径，container 传挂载目标）
+  hostInput:  { ...input, workspaceGroup: groupDir, ... }            // resolveWorkspaceRoot + realpath + 二次校验后
+  dockerInput:{ ...input, workspaceGroup: '/workspace/group', ... }  // buildVolumeMounts 的挂载目标

// src/index.ts —— 分布式 taskInput 同步带上（与 workspaceGlobal/workspaceMemory 同一模式）
+  workspaceGroup: resolveWorkspaceRoot(group),
```

选型理由：

- **payload 显式契约**（而非继续只靠 env）：env 通道正是本次被 `DEEPTHINK_DATA_DIR` 继承击穿的地方，且分布式 pod 拿不到 host 的 env；`ContainerInput` 已有 `workspaceGlobal`/`workspaceMemory` 先例，补齐 `workspaceGroup` 让四个工作区路径同一套规则。
- **PVC 推导降级为兜底**：真实 K8s pod（`deploy/k8s/agent-runner.yaml`）不设 `DEEPTHINK_WORKSPACE_GROUP` env，只设 `AGENT_RUNNER_MODE`/`REDIS_URL`/`DEEPTHINK_DATA_DIR`，旧 host 无 payload 时仍按 `DATA_DIR/groups/{folder}` 推导——分布式行为不变。
- **IPC/GLOBAL/MEMORY 一并按同优先级修正**：同一个分支的同源缺陷（host 模式 sub-agent 的 `ipc/{folder}/agents/{agentId}` 命名空间、per-user 全局记忆目录都会被 PVC 推导抹平），一次修净，不拆成两个 issue。

回归测试：`tests/workspace-custom-dir.test.ts` 新增 `resolveTaskWorkspaces` 5 个用例（env 的 customCwd 不被 DATA_DIR 重算、payload 最优先、PVC 兜底行为不变、分布式 payload 契约、容器默认），已在 `make test-smoke` 清单内。

## 7. 处理卡住的状态

- **已存在的会话**：bug 期间的 SDK transcript 落在默认目录的 encoded path 下。修复后 `customCwd` 会话的 transcript 目录换到新 encoded path，旧会话 resume 找不到旧 transcript 时按「新会话」继续（`extractSessionHistory` 返回 null 的既有降级），不影响使用；如需旧上下文，把 `data/sessions/{folder}/.claude/projects/C--…-data-groups-{folder}/*.jsonl` 复制为 customCwd 的 encoded 目录名即可。
- **桌面版需要重装/重启**：修复涉及 `container/agent-runner`（dist）与后端（`src/container-runner.ts`、`src/index.ts`），须 `make build`（或 `make desktop-build`）后重启桌面应用才生效——桌面版跑的是打包进 `resources/` 的编译产物。

## 8. 经验沉淀 / 预防

1. **「环境变量存在」≠「某种部署形态」**：用 `DEEPTHINK_DATA_DIR` 推断「分布式 PVC 模式」是错误耦合——它是通用数据目录开关（桌面版/start-prod/bootstrap 都会设）。分布式判定应看 `AGENT_RUNNER_MODE`/`REDIS_URL`，或干脆只做「显式值优先、推导兜底」。
2. **同一状态不要两处解析**：launcher 已经用 `resolveWorkspaceRoot` 解析过工作区根，runner 再按 `groupFolder` 反推必然出现分歧。跨进程传状态走 `ContainerInput` 显式字段，env 只做兼容层。
3. **验证 cwd 的土办法**：Claude CLI 的 transcript projects 目录名是 cwd 的编码（非字母数字 → `-`），`ls data/sessions/{folder}/.claude/projects/` 一眼看出 Agent 到底跑在哪个目录——比翻日志可靠，建议纳入工作区类改动的手工验收清单。
4. **桌面版产物同步**：`desktop/release/…/resources/` 里的 backend 与 agent-runner 是各自独立编译拷贝的，只更新其一会出现「backend 新、runner 旧」的混搭（本次排障即先怀疑过版本漂移）。打包前统一走 `make desktop-build`。
