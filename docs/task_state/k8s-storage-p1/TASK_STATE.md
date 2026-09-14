# K8s 分布式存储改造 Phase 2 — 任务状态

> 日期: 2026-09-14
> 分支: `feat/k8s-storage-p1`
> Phase 1: Provider 配置 + MCP 配置 → PostgreSQL (v65/v66 migration)
> Phase 2: Skills/Plugin 大文件 → MinIO + 全量工作区文件 S3 切换 + Supervisor flags → Redis

---

## 已完成任务

### Task 1: Skills/Plugin 大文件迁移到 MinIO ✅

**变更文件**:
- `src/routes/skills.ts` (+54/-18 行)
- `src/skill-content-utils.ts` (+38 行)
- `src/container-runner.ts` (S3 fallback read 路径)
- `src/runtime-config.ts` (export readProviderConfigFromDb/writeProviderConfigToDb)

**改动要点**:
1. **Skills Manifest → PostgreSQL**: `readSkillsManifest`/`writeSkillsManifest` 改为 DB-first 读写，使用 `provider_configs` 表 (config_key=`skills-manifest:{userId}`)。文件仍作为 fallback 写入，确保向后兼容。
2. **Skills Content → MinIO**: `writeSkillContent` 在本地原子写入后，同步 mirror 到 S3 (`putWorkspaceFile` with groupFolder=`__skills__`, filePath=`{userId}/{skillId}/SKILL.md`)。
3. **容器读取 S3 fallback**: `getSkillContentsForTurn` 在文件系统 fallback 1 之后、fallback 2 之前新增 S3 查询 (`getWorkspaceFile`)，确保 Pod A 安装的 skill 在 Pod B 也可被挂载。
4. `applyTurnMounts` 改为 async (映及 3 个调用点: docker start、host start、index.ts task dispatch)。
5. 导出 `readProviderConfigFromDb`/`writeProviderConfigToDb` 供 routes/skills.ts 使用。

### Task 2: 全量工作区文件 S3 切换 ✅

**变更文件**:
- `src/routes/files.ts` (+61 行)

**改动要点**:
1. 新增 3 个 S3 helper 函数 (在 routes/files.ts 顶部):
   - `mirrorFileToS3(groupFolder, filePath, content)` — 写入后 best-effort mirror
   - `deleteFileFromS3(groupFolder, filePath)` — 删除后 best-effort 清理
   - `readFileFromS3(groupFolder, filePath)` — 读前 try S3 first, 返回 null 则走本地
2. 写入路径 S3 镜像:
   - **上传** (POST /:jid/files): `mirrorFileToS3` after `fs.writeFileSync`
   - **文本保存** (PUT /:jid/files/content/:path): `mirrorFileToS3` after `fs.renameSync`
   - **二进制保存** (PUT /:jid/files/binary/:path): `mirrorFileToS3` after `fs.renameSync`
3. 读取路径 S3-first:
   - **文本读取** (GET /:jid/files/content/:path): `readFileFromS3` before `fs.readFileSync`

### Task 3: Supervisor mode 标志迁移到 Redis ✅

**变更文件**:
- `src/supervisor-config.ts` (+88/-45 行)

**改动要点**:
1. Redis hash `deepthink:supervisor-config` 作为主存储 (field=chatJid, value=JSON GroupMode)。
2. 读路径: Redis HGETALL → 文件 fallback；Redis miss 时从文件种子返回。
3. 写路径: Redis MULTI HSET/HDEL (事务) + 文件 fallback (best-effort)。
4. 新增 `getRedisPub()` helper 复用 `isRedisConnected()` (from redis-bus.ts)。
5. 无 Redis 时全链路 fallback 到文件，零退化。

---

## 未推进项 (不在本次范围)

_（全部已推进完成）_

---

## Phase 2.5: S3 同步接线 (2026-09-14)

### Task 4: 文件删除/移动/搜索/下载/预览 S3 同步 ✅

**变更文件**:
- `src/routes/files.ts` (+120/-60 行)

**改动要点**:
1. **DELETE handler** (~line 1525): 软删除成功后调用 `deleteFileFromS3` (best-effort, non-blocking)
2. **MOVE handler** (~line 1648): `moveFile` 成功后调用 `moveWorkspaceFile` S3 copy+delete
3. **RENAME handler** (~line 1695): `renameFile` 成功后调用 `moveWorkspaceFile` S3 copy+delete
4. **SEARCH handler**: 改为 async，新增 S3 `listWorkspaceFiles` 源，结果与本地 fs 合并去重
5. **DOWNLOAD handler**: 改为 async，本地文件不存在时 `readFileFromS3` fallback，Range 请求支持
6. **PREVIEW handler**: 改为 async，同 download 模式：本地文件不存在时 S3 fallback，完整 CSP 头 + Range 支持 + MIME 检测

**验证 (2026-09-14 kind Docker 冒烟)**:
- Upload + 本地删除 → Download 200 (S3 fallback 生效)
- Upload + 本地删除 → Preview 200 (S3 fallback 生效)
- Rename → S3 moveWorkspaceFile 同步
- Soft Delete → S3 deleteFileFromS3 同步 + Download 404
- Search → 返回匹配文件 (含 S3 列表)

---

## 合并状态

- [x] TypeScript 编译通过 (0 new errors)
- [x] 容器化回归测试 (Docker + kind — 2026-09-14 验证)
- [x] Phase 2.5 S3 同步接线完成并冒烟验证
- [ ] Git commit & push