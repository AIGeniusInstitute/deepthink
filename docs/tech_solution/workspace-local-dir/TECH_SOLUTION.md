# 技术方案 — Agent 工作区目录支持选择用户本机目录

> 文档版本：v1.0 · 编写日期：2026-10-29 · Owner：Code Agent
> 关联：`docs/prd/workspace-local-dir/PRD.md`

## 1. 现状与差距

「自定义工作目录」已有半套实现（`registered_groups.custom_cwd`）：

| 能力 | 现状 | 差距 |
|------|------|------|
| host 模式 `custom_cwd` | ✅ 创建时可设（admin + 白名单校验，`src/routes/groups.ts` 创建校验链） | — |
| container 模式 `custom_cwd` | ❌ 创建时直接 400（`custom_cwd is only valid for host mode`） | 挂载源固定 `data/groups/{folder}`（`src/container-runner.ts` `buildVolumeMounts`） |
| 创建后修改 | ❌ `GroupPatchSchema` 无 `custom_cwd` | `web:main` 的 customCwd 前置条件（`src/routes/config.ts`）实际不可满足 |
| 消费点一致 | ⚠️ `customCwd || GROUPS_DIR/{folder}` 散落 5 处 | `src/script-runner.ts` 不认 customCwd（定时脚本 cwd 错误） |
| 运行时二次校验 | ✅ host 模式有（`runHostAgent` 内联 allowlist 循环） | container 模式无；host 的实现与 `mount-security.ts` 的 `findAllowedRoot` 重复 |

## 2. 方案总览

**一个规则、一个入口、三道校验**：

1. **一个规则**：新增 `src/workspace-root.ts`，`resolveWorkspaceRoot(group)` = `group.customCwd || data/groups/{folder}`，作为工作区根目录的唯一真相源，替换全部散落实现；
2. **一个入口**：`custom_cwd` 统一走 `validateCustomCwd()`（绝对路径 → 存在且为目录 → `realpathSync` → `allowedRoots` + `blockedPatterns` → 拒绝 `DATA_DIR` 内部路径），POST 创建与 PATCH 修改共用；
3. **三道校验**：创建时（POST/PATCH）、运行时（`runHostAgent` / `runContainerAgent` 启动前，防 DB 注入与白名单收紧）、容器挂载（`buildVolumeMounts` 挂载源即解析后的工作区根）。

### 2.1 数据流（改动后）

```
config/mount-allowlist.json（allowedRoots / blockedPatterns）
        │
POST /api/groups  { execution_mode, custom_cwd? }     PATCH /api/groups/:jid { custom_cwd | null }
        │  validateCustomCwd()（创建/修改共用）                │
        ▼                                                    │
registered_groups.custom_cwd（两种执行模式通用）◀──────────────┘
        │
每条消息 → GroupQueue → runContainerAgent / runHostAgent
   ├─ container: buildVolumeMounts → -v resolveWorkspaceRoot(group):/workspace/group
   │             运行时二次校验（存在 + allowlist）→ docker run
   └─ host: groupDir = resolveWorkspaceRoot(group)
             运行时二次校验（保留原有 defense-in-depth）
             → spawn agent-runner { cwd: groupDir }
运行时消费：resolveWorkspaceRoot 统一解析
   files 路由根 / workspace-config 的 .claude 根 / script-runner cwd / 插件展开 cwd（host）
```

### 2.2 语义决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 权限 | `custom_cwd` 维持 admin（`hasHostExecutionPermission`）专属，两模式一致 | 与 `init_source_path` 同级的安全敏感操作；放开给 member 需单独评审（PRD A1） |
| 修改生效时机 | 不强制停运行中的 Agent，下一次运行生效；文件面板立即切换 | 避免打断长任务（PRD A2）；`runHostAgent`/`runContainerAgent` 每次运行都重新解析根目录 |
| `custom_cwd` 与 `init_*` | 互斥，400 | 初始化拷贝/克隆以默认工作区为目标，与「本机目录即工作区」语义冲突（PRD B1） |
| 清空语义 | PATCH 传 `null` 或 `''` → 恢复默认 `data/groups/{folder}` | 后端 `customCwd: undefined`，schema 不区分 null/空串，handler 归一 |
| 重建/删除工作区 | 只动平台目录（`removeFlowArtifacts` / `resetWorkspaceForGroup` 现状已如此），绝不删本机目录 | 防止毁掉用户真实项目（PRD A3/F6） |
| 平台运行时数据 | `logs/`、IM `downloads/`、`sessions/` 留在平台目录 | 不向用户项目目录写非项目文件（PRD A4） |
| `conversations/` 归档 | 随工作区（PreCompact hook 写 `WORKSPACE_GROUP/conversations`），host 模式现状即如此 | 与既有 host customCwd 行为一致 |
| 工作区 `CLAUDE.md` 身份注入 | `customCwd/CLAUDE.md` 不存在或含系统 marker 才写；用户自有文件绝不覆盖 | 防止 Agent Studio 身份注入毁掉项目 CLAUDE.md（PRD A6）；顺带修复 host customCwd 下注入文件落在默认目录、Agent 根本读不到的隐性缺口 |
| `DATA_DIR` 内路径 | 拒绝（400） | 防止工作区指向别的 group 目录互相覆盖，或被平台清理逻辑误删（PRD A5） |

## 3. 改动清单

### 3.1 后端

**新增 `src/workspace-root.ts`**（唯一真相源）：

```ts
export function resolveWorkspaceRoot(group: Pick<RegisteredGroup, 'folder' | 'customCwd'>): string
// = group.customCwd || path.join(GROUPS_DIR, group.folder)

export function validateCustomCwd(customCwd: string): { ok: true; realPath: string } | { ok: false; error: string; status: 400 | 403 }
// 绝对路径 → 存在且为目录 → realpathSync → findAllowedRoot/matchesBlockedPattern → 拒绝 DATA_DIR 内部

export function checkCustomCwdAllowedAtRuntime(realPath: string): { ok: true } | { ok: false; error: string }
// 运行时二次校验（DB 注入 / 白名单收紧防御），runHostAgent / runContainerAgent 共用
```

**`src/schemas.ts`**：`GroupPatchSchema` 增加 `custom_cwd: z.string().nullable().optional()`（`undefined` 不改；`null`/`''` 清除）。

**`src/routes/groups.ts`**：
- POST：`custom_cwd` 校验链抽出为 `validateCustomCwd()`；删除 `custom_cwd is only valid for host mode` 限制，改为两模式通用 + `custom_cwd` 本身要求 admin（容器模式补显式权限检查）；`custom_cwd` 与 `init_source_path`/`init_git_url` 互斥；`customCwd` 无条件写入 `RegisteredGroup`。
- PATCH：支持 `custom_cwd`（沿用 `canModifyGroup` + admin 权限门槛；home 容器允许改 `custom_cwd`，仍不允许改执行模式）；`...existing` spread 语义不变。

**`src/container-runner.ts`**：
- `buildVolumeMounts`：`/workspace/group` 挂载源改为 `resolveWorkspaceRoot(group)`（admin home 与非 admin 两个分支）。
- `runContainerAgent`：启动前对 `customCwd` 做运行时二次校验 + 存在性检查，失败以 `ContainerOutput` 错误返回（对齐 host 模式行为）。
- `runHostAgent`：内联 allowlist 循环替换为 `checkCustomCwdAllowedAtRuntime`（行为不变）。
- `writeAgentProjectClaudeMd`：目标改为 `resolveWorkspaceRoot(group)/CLAUDE.md`；customCwd 场景仅当文件不存在或含系统 marker（`（由 Agent Studio 注入）` / `（系统注入`）时写入，否则跳过并记日志。

**消费点收敛（`resolveWorkspaceRoot`）**：
- `src/routes/files.ts` `getFileRootOverride`：`customCwd` 不再限 host 模式（容器模式文件面板根同为本机目录；`getAgentAbsolutePath` 容器分支仍返回 `/workspace/group/...`，容器内视角不变）。
- `src/routes/workspace-config.ts` `getWorkspaceRoot`：删本地实现，改用 `resolveWorkspaceRoot`。
- `src/script-runner.ts` `runScript`：cwd 改为按 folder 反查 group 后 `resolveWorkspaceRoot`（修复定时脚本任务 cwd 缺口）。
- `src/plugin-expander-context.ts`：host 分支逻辑本就等价，不动（容器分支 `/workspace/group` 是容器内路径，正确）。

**不改**（有意保留）：`removeFlowArtifacts` / `resetWorkspaceForGroup`（只清平台目录，天然不碰本机目录）；`src/im-downloader.ts`（IM 下载固定平台目录）；`src/index.ts` home sibling 继承链（已透传 `customCwd`）。

### 3.2 前端（`web/`）

| 文件 | 改动 |
|------|------|
| `components/chat/CreateContainerDialog.tsx` | 容器模式「工作区来源」新增「使用本机目录」单选（admin 可见）+ `DirectoryBrowser`；`custom_cwd` 与 empty/local/git 互斥切换；提交时容器模式也传 `custom_cwd` |
| `components/chat/WorkspaceDirDialog.tsx`（新增） | 「工作目录」编辑对话框：展示当前目录（本机目录 / 默认 `data/groups/{folder}/`）、`DirectoryBrowser` 选择、恢复默认按钮、风险与生效时机提示 |
| `components/chat/ChatGroupItem.tsx` | 工作区下拉菜单新增「工作目录…」（`canModify` 且 admin 可见） |
| `components/layout/UnifiedSidebar.tsx` | 挂载 `WorkspaceDirDialog`；「重建工作区」确认文案在 custom_cwd 场景注明本机文件不删 |
| `pages/ChatPage.tsx` | 同上，重建工作区文案条件化 |
| `stores/chat.ts` | 新增 `updateWorkspaceDir(jid, customCwd: string \| null)` → `PATCH /api/groups/:jid` |
| `types.ts` | `GroupInfo.custom_cwd` 已存在，复用 |

### 3.3 测试

新增 `tests/workspace-custom-dir.test.ts`（沿用 `tests/routes-groups-owner-acl.test.ts` 的路由测试骨架：mock `config.js` 数据目录 + `authMiddleware` 环境变量切用户 + `groupRoutes.request()`）：

1. `resolveWorkspaceRoot`：默认 / customCwd 两种解析；
2. POST 创建：容器模式 + `custom_cwd` 成功落库并回显；`custom_cwd` 与 `init_source_path` 互斥 400；相对路径 400；不存在 400；白名单外 403；敏感路径（`.ssh`）403；`DATA_DIR` 内部 400；member 403；
3. PATCH 修改：设置 / 清空（`null` 与 `''`）/ 校验拒绝 / member 403 / home 容器允许改目录但执行模式仍禁改；
4. `buildVolumeMounts` 挂载源为 customCwd（容器模式）；
5. `runScript` cwd 落在 customCwd。

之后：`make typecheck` + `make test` 全量回归；`make test-smoke` 清单加入新文件。

### 3.4 文档

- `docs/API.md`：POST / PATCH `custom_cwd` 语义更新；
- `CLAUDE.md`：§2.4（customCwd 说明）、§3.4（挂载策略表）同步；
- `docs/test_report/workspace-local-dir/TEST_REPORT.md`：测试报告。

## 4. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 容器 bind-mount 本机目录的文件属主问题（Linux 上容器 `node` uid 1000 与宿主目录属主不一致） | 文档注明；与既有 `additionalMounts` 机制同源，不引入新风险面 |
| 用户把工作区切到目录后误以为「重建工作区」会清空 | 文案明确注明本机文件不删（U3） |
| PATCH 与运行中 Agent 并存的短暂双目录 | 已知行为（PRD A2/B4），文案注明「下一次运行生效」 |
| `writeAgentProjectClaudeMd` 误写用户 CLAUDE.md | marker 判定：非系统文件不写（F6） |

回滚：改动均为加性 + 单一解析入口替换；回滚即还原 `custom_cwd` 为 host-only + PATCH 不支持。
