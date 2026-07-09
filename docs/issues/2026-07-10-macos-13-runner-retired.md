# bug: GitHub Actions macOS x64 runner (macos-13) 已下线，x64 dmg 构建 job 永久排队

> 触发时间：2026-07-09 ~ 2026-07-10
> 影响：v1.0.2 Release workflow 中 `Build macOS (x64)` job 在 GitHub Actions 队列中卡 12+ 小时不动，runner 永远不会被分配
> 修复版本：v1.0.3（待发）

## 1. 用户现象

从 Actions UI 看 `Build macOS (x64)` 这个 job：

```
Started 12h 4m 30s ago
Requested labels: macos-13
Waiting for a runner to pick up this job...
Evaluating build-mac-x64.if
Evaluating: success()
Result: true
```

四个 build job（Linux / mac arm64 / mac x64 / Windows）里，只有 x64 这一个一直 `queued`、`runner_name` 为空，arm64 / Linux / Windows 都正常成功。说明这不是排队高峰，而是 runner 端根本没有可用 image。

## 2. 问题描述

`.github/workflows/release.yml` 把 x64 job 写成 `runs-on: macos-13`。GitHub Actions 在 2026 年已经把 `macos-13`（Ventura, Intel）runner image 从 GA 列表中移除，不再为此标签部署 runner，导致任何 target `macos-13` 的 job 会无限期挂在队列里，直到 6 天超时被自动取消。

## 3. 根因

对照 [`actions/runner-images` README 的 Available Images 表](https://github.com/actions/runner-images)，2026-07 当前可用的 macOS runner image 已经只剩：

| macOS 版本 | arch | YAML 标签 | 状态 |
|---|---|---|---|
| macOS 15 | x64 | `macos-latest-large`、`macos-15-large`、`macos-15-intel` | GA |
| macOS 15 Arm64 | arm64 | `macos-latest`、`macos-15`、`macos-15-xlarge` | GA |
| macOS 14 | x64 / arm64 | `macos-14-large`、`macos-14` | **已 deprecated**，2026-11-02 完全停用 |
| macOS 26 | arm64 / x64 | `macos-26` 等 | 2026-06 起 `macos-latest` 已切到 macos-26 |

`macos-13` **完全不在列表里**，GitHub 已经彻底下线该 image，请求此标签的 job 不会有任何 runner pick up。

另外两条相关公告佐证：
- [issue #13518](https://github.com/actions/runner-images/issues/13518) — macOS 14 Sonoma 已进入 deprecation 流程
- [issue #14167](https://github.com/actions/runner-images/issues/14167) — 2026-06 起 `macos-latest` 标签切到 macos-26

## 4. 复现路径

1. push 一个 `v*` tag（例如 `v1.0.2`）
2. 触发 `.github/workflows/release.yml` Release workflow
3. 4 个 build job 同时入队
4. arm64 / Linux / Windows 三个 job 在几分钟内拿到 runner 开始执行
5. **`Build macOS (x64)` job 长时间停在 `Waiting for a runner to pick up this job...`，永远不动**
6. 后续 `release` job 因 `needs: [..., build-mac-x64, ...]` 永远不会被触发，整个 Release 流程挂死

## 5. 诊断方法

```bash
# 1. 拉取当前卡住的 run 的 jobs 状态
curl -s "https://api.github.com/repos/AIGeniusInstitute/deep-think/actions/runs/<run_id>/jobs" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for j in data.get('jobs', []):
    print(f\"{j['name']:30s} | status={j['status']:10s} | conclusion={str(j.get('conclusion')):10s} | labels={j.get('labels')} | runner_name={j.get('runner_name')}\")"
```

观察输出：x64 job 的 `status=queued`、`runner_name` 为空，labels 仍是 `['macos-13']`。其他三个 job `status=completed`、`runner_name` 已分配。

```bash
# 2. 查 GitHub 官方当前可用 image 列表
curl -s "https://api.github.com/repos/actions/runner-images/contents/README.md" \
  | python3 -c "import json,sys,base64; print(base64.b64decode(json.load(sys.stdin)['content']).decode())" \
  | grep -iE "macos-1[0-9]|available images"
```

输出里如果找不到 `macos-13` 这一行，说明该 image 已下线。

## 6. 修复方案

### `.github/workflows/release.yml`

```diff
   build-mac-x64:
     name: Build macOS (x64)
-    runs-on: macos-13
+    runs-on: macos-15-intel
```

同步更新上方的注释块，说明为什么不用 macos-13：

```diff
   # ─────────────────────────────────────────────────────────
   # macOS x64：Intel dmg
   # 必须用 Intel runner：native module 必须在 x64 host 上编译，否则 x64 dmg 在 Intel Mac 上因 ABI 不匹配崩溃
-  # 必须用 Intel runner（macos-13）：native module 必须在 x64 host 上编译，否则 x64 dmg 在 Intel Mac 上因 ABI 不匹配崩溃
+  # 注意 macos-13 已被 GitHub 完全下线，改用 macos-15-intel（GA、x64、非 deprecated）
   # ─────────────────────────────────────────────────────────
```

### 选 `macos-15-intel` 的理由

- **GA、非 deprecated**：不在 deprecation 名单里，未来 1+ 年不会被突然下线
- **x64 host**：满足 native module（better-sqlite3、`desktop-rebuild-natives`）必须在 x64 host 编译的约束，产出仍能在 Intel Mac 上跑
- **非 larger-runner**：不带 `-large` / `-xlarge` 后缀，不消耗 larger-runner 计费额度，走免费分钟数
- **明确 intel 标签**：相比 `macos-15-large` 这种"标签里有 large 但其实也是 x64"的写法，`macos-15-intel` 在语义上更清晰，未来 Apple Silicon 全面迁移时易于识别

## 7. 处理卡住的 run

修复 yml 不会自动救活已 queued 的 run。需要：

1. 到 Actions 页面手动 `Cancel workflow` 当前卡住的 run（run id 28994121862）
2. commit + push yml 修复
3. 删掉 v1.0.2 tag 重新打，或者直接发新 tag（如 `v1.0.3`）触发新 run
4. 新 run 的 `Build macOS (x64)` 应在数分钟内被 runner pick up

## 8. 经验沉淀 / 预防

### 8.1 不要把 runner label 写死成"已下线版本"

CI 里 `runs-on:` 写死成具体 minor 版本（如 `macos-13`）有"突然被 GitHub 下线"的隐患。优先级建议：

1. **首选 `-latest`**（如 `macos-latest`）—— 自动跟随 GitHub 升级，但代价是被动接受 OS 大版本变化
2. **次选"明确 GA 的非 deprecated 标签"**（如 `macos-15-intel`）—— 显式锁定，避免被动迁移，但要定期对齐 actions/runner-images 公告
3. **避免"已 deprecated 或已下线的具体版本"**（如 `macos-13`、`macos-14`）—— 一旦 GitHub 拔掉，CI 直接挂死

x64 这个 job 因为约束是"必须 Intel host"，只能走选项 2，需要定期关注 [actions/runner-images issues 带 Announcement 标签](https://github.com/actions/runner-images/labels/Announcement) 的公告。

### 8.2 定期巡检 CI 健康度

至少每月一次检查：
- workflow run 是否有 job 长时间 `queued` 超过 1 小时
- runner image 是否即将进入 deprecation

GitHub 会提前 1 年左右发 Announcement，但默认不会主动通知到仓库 owner。建议把 [actions/runner-images](https://github.com/actions/runner-images) 的 Announcement 标签 issue 订阅到团队周报。

### 8.3 约束测试加一条 CI runner 可用性检查

未来如果加 CI 健康检查脚本，可以加一条断言：

```bash
# 校验所有 workflow 文件里没有用到已下线的 runner label
RETIRED_LABELS="macos-13 macos-12 macos-11 ubuntu-18.04 ubuntu-20.04"
for label in $RETIRED_LABELS; do
  if grep -rE "runs-on:.*$label" .github/workflows/; then
    echo "ERROR: 发现已下线 runner label: $label"
    exit 1
  fi
done
```

### 8.4 卡死 job 不要等超时

GitHub Actions 默认 job 超时是 6 天（360 hours）。如果看到 job `queued` 超过 30 分钟且其他 platform job 都正常 pick up，基本可以判定为 runner 不可用，直接 cancel + 修 yml + 重发 tag，不要等。
