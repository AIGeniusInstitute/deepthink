# 测试报告 · Agent 工作区目录支持选择用户本机目录

- **日期**：2026-10-29
- **需求原文**：「agent 的工作区目录，支持选择用户本机目录作为工作区。」
- **PRD**：`docs/prd/workspace-local-dir/PRD.md`
- **方案**：`docs/tech_solution/workspace-local-dir/TECH_SOLUTION.md`
- **结论**：新增测试 **21/21 通过**（§3）；全量回归**零新增失败**（§4，stash 基线对照证明失败集合逐条一致）；后端 + 前端 `tsc --noEmit` 均干净（§2）

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Node（跑 vitest） | v22.22.2（`~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`） |
| 测试框架 | vitest（`node_modules/vitest/vitest.mjs run`） |
| 运行方式 | 后端路由/模块级测试，mock `config`/`authMiddleware`/`web.js`，临时目录做数据根与挂载白名单根 |

> **Node 版本说明**：本机 PATH 的 node 是 v24，而 `better-sqlite3` 原生模块是按 Node 22 ABI 编译的
> （生产 DeepThink 桌面端自带 `resources/node/node.exe` v22.11.0），直接跑会报
> `NODE_MODULE_VERSION 127 vs 137`。因此全部测试在 Node 22 下执行。该 ABI 不匹配是**本机既有环境问题**，
> 与本次改动无关（§4 基线对照可证）。

---

## 2. 类型检查

```
cd ~/deepthink && npx tsc --noEmit       → 无输出（干净）
cd ~/deepthink/web && npx tsc --noEmit   → 无输出（干净）
```

---

## 3. 新增测试（21/21 通过）

文件：`tests/workspace-custom-dir.test.ts`（已加入 `make test-smoke` 门禁集）。

```
Test Files  1 passed (1)
     Tests  21 passed (21)
```

| 分组 | 项数 | 覆盖 |
|---|---|---|
| `resolveWorkspaceRoot` | 2 | 无 `customCwd` 回落 `data/groups/{folder}`；有则取 `customCwd`；`resolveScriptCwd` 走同一规则 |
| `validateCustomCwd` | 6 | 相对路径 400；目录不存在 400；合法路径通过；白名单外 403；`.ssh` 屏蔽模式 403；**平台数据目录（DATA_DIR 内）400** |
| `POST /api/groups` | 5 | container 模式 + `custom_cwd` 200（不再限制 host-only）；host 模式 200；与 `init_source_path`/`init_git_url` 互斥 400；白名单外 403；member 403 |
| `PATCH /api/groups/:jid` | 6 | 设置 `custom_cwd`；`null` 清除；`''` 清除；非法路径拒绝且**旧值不变**；非 owner member 403；home 容器允许改目录（改 `execution_mode` 仍 403） |
| `buildVolumeMounts` | 2 | `customCwd` 作为 `/workspace/group` 挂载源；无 `customCwd` 时用 `GROUPS_DIR` |

设计要点：

- **校验三处同源**：创建/修改（`validateCustomCwd`）、运行时（`checkCustomCwdAllowedAtRuntime`，防 DB 注入/白名单收紧）、容器挂载（`buildVolumeMounts`），全部收敛到 `src/workspace-root.ts`，测试分别命中。
- 测试夹具的 `created_by` 必须等于操作者：web 群组 `canModifyGroup` 要求 `group.created_by === user.id`（admin 也不豁免），member 越权用例专门把 `created_by` 改成 owner 后再 PATCH。
- 临时工作区根刻意放在 DATA_DIR **之外**——DATA_DIR 内会被新规则拒绝，夹具会被自己的校验打死。

### 覆盖之外（如实声明）

- **未做真机 Docker e2e**：容器挂载在 `buildVolumeMounts` 单元级验证了挂载源选择，未在本环境跑真实 `docker run` 冒烟（Windows 开发机 Docker 场景受限）。
- 安全不变式（重建/删除工作区不触碰本机目录）是**代码走查确认**：`removeFlowArtifacts`/`resetWorkspaceForGroup`/`deleteGroupData` 只操作平台目录（`data/groups/`、`data/sessions/` 等），没有对 `customCwd` 的删除路径。

---

## 4. 全量回归（stash 基线对照，零新增失败）

方法：`git stash -u` 暂存全部改动 → 在纯净树跑全量 → `git stash pop` 恢复 → 对比失败集合。

| 轮次 | Test Files | Tests |
|---|---|---|
| 基线（不含本次改动） | 23 failed \| 163 passed \| 4 skipped (190) | 15 failed \| 2499 passed \| 16 skipped |
| 本次改动 | 23 failed \| 163 passed \| 4 skipped (190) | 15 failed \| **2520** passed \| 16 skipped |

- 通过数差 **+21** 恰为新增测试数，失败数相同。
- 两轮失败用例逐条 `diff` 对比：**集合完全一致**（含此前最可疑的
  `plugin-expander-routing-bugs.test.ts`（customCwd 相关）、`session-files.test.ts`、
  `claude-context-resolver.test.ts`、`db-transactions.test.ts`——它们在基线上同样失败）。
- **结论：本次改动零回归**；23 个失败文件全部为本机既有环境问题，典型成因：
  - `EBUSY: resource busy or locked, unlink ...\messages.db`——Windows 文件锁，测试清理临时 SQLite 时句柄未释放（`db-transactions`、`graph-terminal-state`、`opc` 等文件级失败）。
  - POSIX 路径假设——`plugin-expander-routing-bugs` 断言 `'/Users/alice/projects/repo'`，Windows 下 `path.resolve` 归一成 `C:\Users\alice\...`；`node-resolver`/`session-files`（broken symlink）同类。
  - HOME 环境差异——`web-search-config` 的 `$HOME/zhipu_web_search/.env` 回落用例。
  - `feishu-card.test.ts` 为 CLAUDE.md 已记载的偶发 5s 超时 flaky。

---

## 5. 手工核对清单（代码走查）

| 项 | 结果 |
|---|---|
| 工作区根单一来源 | `resolveWorkspaceRoot` 一处定义，5 处重复拼路径（groups/files/workspace-config/script-runner/container-runner）全部收敛 |
| 删除/重建工作区不删本机文件 | ✅ 三个删除函数只操作平台目录；前端重建确认弹窗对 `custom_cwd` 群组追加「本机目录中的文件不会被删除」提示 |
| 用户 `CLAUDE.md` 不被覆盖 | ✅ `writeAgentProjectClaudeMd` 对 `customCwd` 目录下已存在且无注入标记的 `CLAUDE.md` 跳过写入 |
| 修改对下次运行生效 | ✅ 运行时校验 + 挂载在每次启动重新解析，无需迁移 |
| 文档同步 | ✅ `docs/API.md`（POST/PATCH `custom_cwd` 语义）、`CLAUDE.md` §2.4/§3.4 已更新 |
