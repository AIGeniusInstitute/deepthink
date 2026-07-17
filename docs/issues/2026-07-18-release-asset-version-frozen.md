# bug: Release workflow 产物文件名版本号始终为 1.0.0，不随 tag 变化

> 触发时间：2026-07-18（v1.0.5 Release 发现）
> 影响：tag 推到 `v1.0.5` 后，GitHub Release 三平台产物文件名仍是 `1.0.0`（如 `DeepThink-1.0.0-arm64.dmg`、`DeepThink Setup 1.0.0.exe`、`deepthink-desktop_1.0.0_amd64.deb`），与 Release 标题 `DeepThink v1.0.5` 不一致
> 修复版本：v1.0.6（待发）

## 1. 用户现象

从 GitHub Release 页面（`https://github.com/AIGeniusInstitute/deepthink/releases/tag/v1.0.5`）看：

```
DeepThink v1.0.5 Latest
@github-actions released this 15 minutes ago
 v1.0.5

Assets
DeepThink-1.0.0-arm64.dmg              482 MB
DeepThink-1.0.0.AppImage               361 MB
DeepThink-1.0.0.dmg                    499 MB
deepthink-desktop_1.0.0_amd64.deb     343 MB
DeepThink Setup 1.0.0.exe              447 MB
```

Release 标题是 `DeepThink v1.0.5`，但每个产物文件名的版本段都是 `1.0.0`。

## 2. 问题描述

Release workflow（`.github/workflows/release.yml`）从 git tag 解析版本号用于 Release 标题，但**没有把该版本号同步到 `desktop/package.json` 的 `version` 字段**。electron-builder 用 `desktop/package.json` 的 `version` 字段命名所有产物：

- macOS dmg：`DeepThink-${version}-arm64.dmg`、`DeepThink-${version}.dmg`
- dmg 标题：`DeepThink ${version}`（见 `desktop/build/mac-arm64.json` 的 `dmg.title`）
- Linux：`deepthink-desktop_${version}_amd64.deb`、`DeepThink-${version}.AppImage`
- Windows：`DeepThink Setup ${version}.exe`

由于 `desktop/package.json` 的 `version` 自项目初始化以来一直是硬编码的 `"1.0.0"`，从未随 tag bump，所以无论 tag 是 `v1.0.5` 还是 `v2.0.0`，产物文件名恒为 `1.0.0`。

## 3. 根因

**代码层面**：

1. `desktop/package.json`：
   ```json
   { "name": "deepthink-desktop", "version": "1.0.0", ... }
   ```
   `version` 硬编码 `1.0.0`，发版时不更新。

2. `desktop/build/*.json`（electron-builder 配置）没有 `version` 字段，electron-builder 回退读取 `package.json` 的 `version`。`dmg.title` 用 `DeepThink ${version}` 也来自同一来源。

3. `.github/workflows/release.yml` 的 build job（`build-mac-arm64` / `build-mac-x64` / `build-win` / `build-linux`）在 `make desktop-pack-*` 前没有把 tag 版本写入 `desktop/package.json`。只有 `release` job 在最后用 `GITHUB_REF_NAME` 生成 Release 标题——但那时产物文件名已经定型。

**外部依据**：
- electron-builder 文档：产物文件名与 `version` 模板变量取自 `package.json` 的 `version`（或 build config 的 `extraMetadata.version`）。
  https://www.electron.build/configuration/configuration#metadata

## 4. 复现路径

1. 本机执行 `node -p "require('./desktop/package.json').version"` → 输出 `1.0.0`。
2. 推任意 `v*` tag（如 `v1.0.5`）触发 Release workflow。
3. workflow 跑完后看 Release Assets：文件名版本段全是 `1.0.0`，与 tag 不符。

## 5. 诊断方法

```bash
# 1. 确认 desktop/package.json 当前 version
node -p "require('./desktop/package.json').version"
# 预期（修复前）：1.0.0

# 2. 确认 build config 无 version 覆盖
grep '"version"' desktop/build/*.json
# 预期：只有 mac-arm64.json / mac-x64.json 的 dmg.title 里出现 ${version}，无独立 version 字段

# 3. 确认 workflow build job 没有同步版本号
grep -n "version\|ref_name" .github/workflows/release.yml
# 预期（修复前）：只有 release job 的 Determine release version 步骤用到 GITHUB_REF_NAME
```

## 6. 修复方案

在 `.github/workflows/release.yml` 的 4 个 build job（`build-mac-arm64` / `build-mac-x64` / `build-win` / `build-linux`）的 `actions/checkout@v4` 之后、pack 步骤之前，各插入一步 `Sync desktop version from tag`：

```yaml
      - name: Sync desktop version from tag
        shell: bash
        run: |
          RAW="${{ inputs.version || github.ref_name }}"
          VER="${RAW#v}"
          echo "Desktop version: $VER"
          node -e "const fs=require('fs');const f='desktop/package.json';const p=JSON.parse(fs.readFileSync(f));p.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$VER"
```

**选型理由**：

- **版本号来源** `${{ inputs.version || github.ref_name }}`：兼容两种触发——tag push 时 `github.ref_name` = `v1.0.5`；`workflow_dispatch` 手动触发时取 `inputs.version`（用户传入的 tag 名）。与 `release` job 的 `Determine release version` 步骤逻辑一致。
- **去 `v` 前缀**：tag 是 `v1.0.5`，但 electron-builder 的 version 字段必须是纯 semver `1.0.5`，用 `${RAW#v}` shell 参数扩展剥离。
- **改 `desktop/package.json` 而非 Makefile/build config**：这是 CI 一次性 checkout，就地改 `package.json` 最外科、不动 Makefile 的 4 个 pack target，也不动 build config。本地 `make desktop-pack-mac` 仍用 `1.0.0` 不受影响（本地无发布语义）。
- **副作用收益**：electron-builder 生成的 `latest*.yml`（`latest-mac.yml` / `latest.yml` / `latest-linux.yml`）也用同一 version，这些 yml 是 electron-updater 自动更新协议的元数据，一并修正，避免未来自动更新因版本号不匹配而失效。

## 7. 处理卡住的状态

不适用——产物已发布只是命名错误，无 stuck 运行态。

如需修正已发布的 v1.0.5 资产名，可：

```bash
# 删旧 release + tag，重新跑 workflow
make release-delete VERSION=v1.0.5
# 重新打 tag 并 push 触发重建
git tag -a v1.0.5 -m 'Release v1.0.5' && git push origin v1.0.5
```

## 8. 经验沉淀 / 预防

- **发版 checklist 增加**：tag push 前确认 `desktop/package.json` 的 `version` 已同步——但人工易漏，本修复已把同步动作内建到 workflow，无需人工 bump。
- **巡检**：Release 发布后，肉眼检查 Assets 列表里任一文件名版本段是否等于 tag 版本；不一致即说明版本同步链路又断了。
- **可选后续优化**（未做，留作参考）：把 `desktop/package.json` 的 `version` 字段改为由 `git describe --tags` 单一真相源驱动，或在 Makefile 的 4 个 `desktop-pack-*` target 支持 `DESKTOP_VERSION` 环境变量透传 `-c.extraMetadata.version`。当前问题只出在 CI，没必要扩大改动面。
