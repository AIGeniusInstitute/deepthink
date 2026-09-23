# 桌面打包链因 electron-builder 自动发布缺 token 导致四平台构建全挂、GitHub Release 无法产出

## 1. 用户现象

推送 tag `v1.4.0` 后，GitHub Actions 的 Release workflow 跑完是**失败**，GitHub Release v1.4.0 **没有创建**：

```
GET /repos/AIGeniusInstitute/deepthink/releases/tags/v1.4.0  →  HTTP 404
```

Actions 页面上四个平台构建（macOS arm64 / macOS x64 / Windows x64 / Linux x64）**全部红色**，最后的 "Publish GitHub Release" 是**灰色 skipped**。仓库里最后一个成功的 Release 停留在 v1.2.0（2026-08-28）。

## 2. 问题描述

`release.yml` 由 tag 推送触发后，四个 build job 的步骤状态完全一致：

| 步骤 | 结果 |
|---|---|
| Run actions/checkout@v4 | ✅ |
| Run actions/setup-node@v4 | ✅ |
| Sync desktop version from tag | ✅ |
| **Install dependencies**（`make install`） | ✅ |
| **Build & pack macOS (arm64)** / (x64) / Windows / Linux（`make desktop-pack-*`） | ❌ ❌ ❌ ❌ |
| Upload artifacts | ⏭️ skipped（被上一步阻断） |

四个平台**在同一个逻辑步骤失败**，说明不是平台相关问题，而是打包链里某个与平台无关的公共环节。

由于 release job 声明了 `needs: [build-mac-arm64, build-mac-x64, build-win, build-linux]`，四个 build job 全失败 → release job 直接 skip → Release 资产无从汇总上传。

## 3. 根因

**`desktop/build/{mac-arm64,mac-x64,win,linux}.json` 里的 `publish` 配置，让 electron-builder 在 CI + tag 场景下自动尝试发布到 GitHub，而构建 job 没有提供 token。**

引入点：`cddcc9a`（2026-09-04，「运维工具链 + 一键部署 + 桌面打包配置完善」）给四个打包配置各加了 5 行：

```json
"publish": {
  "provider": "github",
  "owner": "AIGeniusInstitute",
  "repo": "deepthink"
}
```

这条改动的提交说明是「显式 publish 配置（electron-updater 自动更新健壮化）」，但它的副作用是把打包步骤从「只打包」变成了「打包 + 尝试发布」。

### 触发链路（源码级，electron-builder 25.1.8）

**第一步：CI tag 构建 → 自动推导发布策略**

`app-builder-lib/out/publish/PublishManager.js:51-66`：

```js
if (publishOptions.publish === undefined) {          // 命令行没传 --publish
    if (process.env.npm_lifecycle_event === "release") {
        publishOptions.publish = "always";
    } else {
        const tag = getCiTag();
        if (tag != null) {
            log.info({ reason: "tag is defined", tag }, "artifacts will be published");
            publishOptions.publish = "onTag";        // ← 命中这里
        } else if (isCi) {
            publishOptions.publish = "onTagOrDraft";
        }
    }
}
const publishPolicy = publishOptions.publish;
this.isPublish = publishPolicy != null && publishOptions.publish !== "never" && (...);
```

`electron-publish/out/publisher.js:82-92` 的 `getCiTag()` 在 GitHub Actions 上读的是：

```js
(process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : null)
```

tag 推送时 `GITHUB_REF_TYPE=tag`、`GITHUB_REF_NAME=v1.4.0` → `getCiTag()` 返回 `"v1.4.0"` → `publish = "onTag"` → `isPublish = true`。

本地实测（本仓库 `desktop/` 下用真实安装的 electron-publish）：

```
$ GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v1.4.0 CI=true node -e "...getCiTag()..."
getCiTag() = "v1.4.0"
GH_TOKEN = null  GITHUB_TOKEN = null
```

**第二步：`publish` 配置存在 → 一定构造 GitHub publisher**

`app-builder-lib/out/publish/PublishManager.js:334-356`：

```js
async function resolvePublishConfigurations(publishers, ...) {
    if (publishers == null) {
        let serviceName = null;
        if (!isEmptyOrSpaces(process.env.GH_TOKEN) || !isEmptyOrSpaces(process.env.GITHUB_TOKEN)) {
            serviceName = "github";
        }
        ...
        if (serviceName != null) { return [(await getResolvedPublishConfig(...))]; }
    }
    if (publishers == null) {
        return [];          // ← 没有 publish 配置且没有 token → 空数组，不建 publisher
    }
    return await bluebird.map(asArray(publishers), it => getResolvedPublishConfig(...));  // ← 有配置 → 建
}
```

配合 `PublishManager.js:309-333` 的 `getPublishConfigs`（依次查 target → platform → `config.publish`）：**配置文件里有 `publish` 就直接走最后一行去构造 publisher，「有没有 token」根本不参与判断。**

**第三步：构造 publisher 时因缺 token 抛异常**

`electron-publish/out/gitHubPublisher.js:22-24`：

```js
token = process.env.GITHUB_RELEASE_TOKEN ? process.env.GITHUB_RELEASE_TOKEN
      : process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
    throw new InvalidConfigurationError(
      `GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"`);
}
```

`release.yml` 的四个 build job 只注入了两个环境变量：

```yaml
env:
  NODE_VERSION: v24.18.0
  ELECTRON_BUILDER_BINARIES_MIRROR: https://npmmirror.com/mirrors/electron-builder-binaries/
```

`GitHubToken` / `GH_TOKEN` / `GITHUB_RELEASE_TOKEN` **一个都没有** → 抛 `InvalidConfigurationError` → electron-builder 非零退出 → `make desktop-pack-*` 失败 → 该 job 的 "Build & pack" 步骤变红。

### 为什么能确定是它

| 证据 | 说明 |
|---|---|
| **时间线吻合** | `cddcc9a` 2026-09-04 加入 `publish` 配置；v1.2.0 是 2026-08-28（**成功**），v1.3.0 是 2026-09-05（**失败**），v1.4.0 2026-09-23（**失败**） |
| **平台无关** | 四个 `desktop/build/*.json` 都被加了同一段配置，正好对应四个 job 同时红 |
| **失败步骤吻合** | 唯一会用到这四个配置文件的地方就是 `make desktop-pack-*` 里的 `electron-builder --config build/<platform>.json` |
| **上一个成功版本无此配置** | `git show v1.2.0:desktop/build/mac-arm64.json` 中没有 `publish` 段；v1.2.0 的 Release 四个平台资产（含 `DeepThink.Setup.1.2.0.exe`）齐全 |
| **workflow 未变** | `release.yml` 自 2026-07-18 起未改动，排除 workflow 侧引入 |

Release workflow 触发历史（`/actions/workflows/release.yml/runs`）：

```
2026-09-23  tag=v1.4.0   completed/failure   id=35819723882
2026-09-05  tag=v1.3.0   completed/failure   id=33982097942
2026-08-28  tag=v1.2.0   completed/success   id=33165188830   ← 最后一个绿色
2026-08-06  tag=v1.1.0   completed/failure   id=31123689713
```

## 4. 复现路径

不需要打 tag，本地即可复现「CI + tag」的判定条件：

```bash
cd desktop
GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v1.4.0 CI=true \
  node -e "const{getCiTag}=require('electron-publish/out/publisher');console.log(getCiTag())"
# → v1.4.0    （说明 auto-publish 已被激活）

# 再看配置文件里是否有 publish 段
grep -A4 '"publish"' build/mac-arm64.json
```

要完整复现四个平台红掉，需要 `make desktop-pack-*` 跑到底，本地成本高（十几到几十分钟），CI 上复现最直接：推送任意 `v*` tag 或 `workflow_dispatch`。

## 5. 诊断方法

```bash
# 1) 看某个 run 的逐步骤结果（公开仓库 jobs 接口免鉴权，能定位到具体步骤）
curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/runs/<RUN_ID>/jobs?per_page=20" \
  | python3 -c "
import json,sys
for j in json.load(sys.stdin)['jobs']:
    print(f\"### {j['name']} -> {j['conclusion']}\")
    for s in j['steps']:
        print('   ', s['conclusion'], s['name'])
"

# 2) 看 Release 是否真的没建出来
curl -s -o /dev/null -w '%{http_code}\n' \
  https://api.github.com/repos/AIGeniusInstitute/deepthink/releases/tags/v1.4.0
# → 404

# 3) 列出所有 Release workflow 运行，找最后一个绿色
curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/workflows/release.yml/runs?per_page=30" \
  | python3 -c "
import json,sys
for r in json.load(sys.stdin)['workflow_runs']:
    print(r['created_at'], r.get('head_branch'), r['status']+'/'+r['conclusion'])
"

# 4) 定位桌面配置引入点
git log --oneline --date=short --format='%h %ad %s' v1.2.0..v1.3.0 -- desktop/

# 5) 确认 build job 没有注入任何 token
grep -n -B2 -A4 'Build & pack' .github/workflows/release.yml
```

> 注意：GitHub API 的 **日志下载**（`/actions/runs/<id>/logs`）需要 admin 权限，非仓库管理员会拿到 `403 Must have admin rights to Repository`。上面的 **jobs 接口**是公开的，能拿到「哪个步骤红」但拿不到报错文本；要拿到 `InvalidConfigurationError` 原文，请在 Actions 页面直接点开失败步骤，或让有权限的同学下载日志。

## 6. 修复方案

`Makefile` 的四个打包目标，给 `electron-builder` 显式加 `--publish never`：

```diff
+# 打包步骤一律加 `--publish never`：desktop/build/*.json 里的 publish 配置只用于生成
+# 自动更新元数据（app-update.yml / latest*.yml），但 electron-builder 只要看到该配置，
+# 在 CI + tag 推送场景下就会自动推导出 publish=onTag 并构造 GitHub publisher，进而要求
+# GH_TOKEN；构建 job 没有该 token，会在打包收尾抛 InvalidConfigurationError 让整步失败。
 desktop-pack-mac: desktop-build desktop-rebuild-natives desktop-clean-stale-mount
-	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/mac-arm64.json
+	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/mac-arm64.json --publish never

 desktop-pack-mac-x64: desktop-build desktop-rebuild-natives desktop-clean-stale-mount
-	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/mac-x64.json
+	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/mac-x64.json --publish never

 desktop-pack-win: desktop-build desktop-rebuild-natives
-	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/win.json
+	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/win.json --publish never

 desktop-pack-linux: desktop-build desktop-rebuild-natives
-	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/linux.json
+	cd $(DESKTOP_DIR) && npx $(NPM_FLAGS) electron-builder --config build/linux.json --publish never
```

### 选型理由

为什么是「加 `--publish never`」而不是「删掉 `publish` 配置」：

- `publish` 配置本身有正当用途——它是 electron-builder 生成 **`app-update.yml` / `latest*.yml`** 等自动更新元数据的依据（`getPublishConfigsForUpdateInfo`）。删掉会丢掉 cddcc9a 想要的「electron-updater 自动更新健壮化」效果。
- `--publish never` 只关掉「打包完顺手往 GitHub 推」这个副作用，**不影响更新元数据的生成**，两条诉求都保住。
- 工程上「构建 job 只负责构建、发布由专门的 release job 负责」也是更干净的职责划分：`release.yml` 的 release job 已经用 `softprops/action-gh-release` + `GITHUB_TOKEN` 汇总四个平台的产物建 Release。如果让 build job 自己 publish，会和这个 job 抢同一个 Release。

## 7. 处理卡住的状态

已经推了 tag 但 Release 缺失（v1.3.0、v1.4.0 都属于这种）时，**不需要删 tag 重推**，修复合并后手动重跑即可：

```bash
# GitHub CLI
gh workflow run release.yml --repo AIGeniusInstitute/deepthink -f version=v1.4.0

# 或走 API（需要 token）
curl -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/workflows/release.yml/dispatches \
  -d '{"ref":"main","inputs":{"version":"v1.4.0"}}'
```

`release.yml` 同时支持 `workflow_dispatch`（`inputs.version` 必填，要求对应 tag 已推到远端），`Sync desktop version from tag` 步骤会用 `inputs.version || github.ref_name` 解析出版本号，所以手动触发与 tag 触发等价。

如果打出来的 Release 有问题需要重来：

```bash
gh release delete v1.4.0 --repo AIGeniusInstitute/deepthink --yes --cleanup-tag   # 连 tag 一起删，慎用
```

## 8. 经验沉淀 / 预防

**1）打包配置里加 `publish` 是有副作用的，不是纯声明。**
electron-builder 只要在配置里看到 `publish`，就会在「CI + tag」场景自动启用发布并索取 token。任何修改 `desktop/build/*.json` 的改动，都应该在 CI 或本地用 `GITHUB_REF_TYPE=tag GITHUB_REF_NAME=vX.Y.Z CI=true` 验证一次打包目标；一条 `--publish never` 能省掉一整轮 4×30 分钟的 CI 排查。

**2）"绿色版本 → 红色版本"之间的 diff 是最强的定位工具。**
本次先把最后一个成功 Release（v1.2.0, 08-28）与第一个失败版本（v1.3.0, 09-05）之间的改动缩到 `v1.2.0..v1.3.0 -- desktop/`，只剩 `cddcc9a` 一个提交，直接命中。比逐个平台翻日志快得多。

**3）四个平台同时红 ≈ 平台无关的公共环节。**
看到 macOS/Windows/Linux 同时挂，优先怀疑 Makefile 目标、共享配置文件、共享脚本，而不是某个平台的工具链。

**4）公开仓库的 `jobs` 接口可以免鉴权定位失败步骤。**
拿不到日志文本，但「哪一步红了」通常已经足够把范围缩到一两个目标上。

**5）本次排查中被证伪的假设（留档，避免后人重复走）**
- ❌ **内置 Node 与编译 Node 的 ABI 错配**：`Makefile` 用 `DESKTOP_NODE_VERSION ?= v22.11.0` 下载内置 Node，而 CI runner 是 Node 24.18.0，`release.yml` 注入的 `NODE_VERSION: v24.18.0` 实际**被 Makefile 覆盖、从未生效**。这个错配真实存在，但 **v1.2.0（绿色）与 v1.3.0（红色）的桌面打包目标逐字节相同**，说明 `desktop-rebuild-natives` 的 ABI 守卫在 CI 上是能过的，**不是本次故障原因**。
  附带确认的两个事实：① `npm_config_target` / `npm_config_runtime` 环境变量在 npm 12 下**仍会传入 lifecycle 脚本**（用探针脚本实测 `target=[v22.11.0]`），本机 npm 12 报的 `npm warn Unknown env config` 只是告警；② better-sqlite3 走 `prebuild-install || node-gyp rebuild`，`prebuild-install` 按**运行它的 Node** 的 ABI 拉取预编译产物（缓存在 `~/.npm/_prebuilds/`），因此重定向只需 `npm_config_target`，而 ABI 不匹配的表现是**干净报错 `ERR_DLOPEN_FAILED` 退出 1**，不是 SIGKILL——SIGKILL 通常意味着 `.node` 文件的签名/完整性坏了。

**6）遗留隐患（建议单独排期，不在本次修复范围）**
`release.yml` 四个 build job 注入的 `NODE_VERSION: v24.18.0` 被 Makefile 的 `DESKTOP_NODE_VERSION ?= v22.11.0` 完全遮蔽，注释却写着「内置 Node 运行时版本需与 runner Node 版本一致」——**注释描述的是一个并未实现的约束**。当前 CI 靠 `npm_config_target` 把 ABI 从 24 重定向到 22 才得以通过；本机若 Node 版本既不是 22 也不是 CI 的 24（例如 Node 26），`make desktop-pack-*` 会在 ABI 守卫处失败。要么让 `DESKTOP_NODE_VERSION` 真正跟随 `NODE_VERSION`，要么把注释改成与实现一致，二选一即可。

**7）巡检建议**
给 Release workflow 加一条失败通知（或每周检查 `gh run list --workflow=release.yml --limit 5`），避免像 v1.3.0 那样「Release 发失败了 18 天没人发现，直到下次发版才暴露」。
