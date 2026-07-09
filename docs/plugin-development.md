# Claude Code Plugin 接入约束

> 本文档从 `CLAUDE.md` §10 "Claude Code Plugin 接入" 子约束拆分而来。修改 / 新增 Plugin 系统代码时请同步更新。
>
> 顶层 `CLAUDE.md` §10 只保留一句强约束锚点；详细规则按需 Read 本文档。

## 注入方式

- Plugin 通过 SDK `options.plugins`（`SdkPluginConfig[]`）注入，SDK 内部转成 `--plugin-dir <path>` 传给 spawn 的 claude CLI。**不要**走 settings.json 的 `enabledPlugins` 或 `CLAUDE_CODE_PLUGIN_SEED_DIR`（v2 方案已废弃）
- `ContainerInput.plugins` 由 `container-runner.ts` 的两处 spawn 处就地派生新 input（`{ ...input, plugins: loadUserPlugins(ownerId, {runtime}) }`），**禁止原地 mutate** —— 队列/日志/重试路径共享同一 input 引用

## 路径

- Plugin 目录路径必须是已展开的绝对路径
- Docker 模式：`/workspace/plugins/snapshots/{snapshotId}/{mp}/{plugin}`（runtime/{userId} 整个目录只读挂到 /workspace/plugins/，所以容器内一定带 snapshots/ 前缀）
- Host 模式：`path.join(DATA_DIR, 'plugins', 'runtime', userId, 'snapshots', snapshotId, mp, plugin)`
- **不允许**含 `~` 字面量（SDK/CLI 不保证展开）

## 依赖检测

- best-effort 警告，**不**作为启用门槛
- 修正扫描遗漏请改 `config/plugin-deps-override.json` 覆盖表

## Marketplace / Catalog

- 删除 marketplace（`DELETE /api/plugins/marketplaces/:name`）只清除**调用者自己**的 enabled refs，**不删** catalog（catalog 是 admin 共享导入的全局只读集合）
- admin 在宿主机安装 / 更新的 plugin marketplace 会在主进程启动 5s 后 + 每小时自动入 catalog（`POST /api/plugins/catalog/scan` 也手动触发同一逻辑），对所有 member 可见可启用
- 可通过系统设置 `SystemSettings.pluginAutoScan = false` 关闭定时扫描（admin 仍可手动点 `POST /api/plugins/catalog/scan`），适用于不希望本机私有 plugin 自动入共享 catalog 的环境
- 定时器仅在主进程启动时按当前值注册一次，运行时切换需重启服务才能生效

## 运行时行为

- 运行中 agent 进程**不热加载** plugin 变化——启用/禁用后 UI 必须提示"下次新会话生效"
- 第一版仅支持 plugin 内的 commands/agents/hooks/skills/scripts；插件持久数据（`~/.claude/plugins/data/`）与凭据不自动迁移

## Catalog snapshot immutable

- catalog 按内容 hash 寻址（`versions/{contentHash}/`），同一 plugin 的不同版本独立留存
- rollback 自动跟随用户 enable refs 命中的实际 hash，不需要"反向复制"
- Materialize 通过 `copyTreeIsolated`（`fs.copyFileSync(..., COPYFILE_FICLONE)`）：macOS APFS / Linux btrfs/xfs 上初始接近零拷贝，写入时 COW 分裂分配新块；其他文件系统退化为字节拷贝
- 无论何种文件系统，runtime 与 catalog **始终独立 inode**——host 模式 bypass-permissions agent 写穿透不会污染 catalog
- 每个 materialize 出的 plugin 带 `@deepthink-runtime-markers/{mp}/{plugin}.json` 兄弟节点 marker（放在 snapshot 根下、plugin root 之外），下次 materialize 据此识别并通过 rename + backup rollback 迁移老 hard-link runtime（rename 之间仍有极短 ENOENT 窗口，但远短于 rmSync）

## Runtime versioned snapshot

- `runtime/{userId}/snapshots/{snapshotId}/...` 是用户视角的版本化只读视图
- 启用新版本只切用户配置（`users/{userId}/plugins.json`），旧会话继续读旧 snapshot 直到 GC，避免运行中读到半写入目录

## API 设计

- **`PATCH /enabled` 走 mcp 范式**：read-modify-write 单 schema，无 v1→v2 接管路径（v1 cache 布局已删除，存量用户首次访问 enabled 列表为空属预期）
- **container-runner 双路径预构建**：host / docker spawn 之前都先 `materializeUserRuntime(ownerId)`；`prepareHostPlugins` helper 与 `buildVolumeMounts` 内联 materialize **必须对称**，否则两条路径会出现 runtime 不一致

## 已废弃 endpoint

- `POST /api/plugins/sync-host` 与 `GET /api/plugins/available-on-host` 已在 PR1 删除，新代码不要再引用
