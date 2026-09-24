# CI 门禁 Test (smoke) 自创建以来 100% 失败，从未真正跑过一个测试

- **日期**：2026-09-24
- **影响范围**：`.github/workflows/test.yml`（所有 push 到 main / pull_request 触发）
- **影响时长**：自 2026-08-31 工作流创建起的全部 58 次运行（run #1 → #58）
- **严重级别**：高——CI 门禁完全失效，红灯被当噪音，合并无任何自动化保护

## 1. 用户现象

每次 push 到 main 或开 PR，GitHub Actions 上的 `Test (smoke)` 都是红色 ❌。点进去看，job 在几秒内就失败了，**测试一个都没跑**：

```
Smoke tests (Node 22)   failure
  1. Set up job                      success
  2. Run actions/checkout@v4         success
  3. Setup Node 22                   failure   ← 卡在这里
  4. Install deps (no-save, no audit) skipped
  5. Run smoke tests                  skipped
```

因为门禁从来都是红的，团队已经习惯性忽略它——红灯失去了信号意义。同时 `Release` 工作流是绿的（run #20，v1.5.0 四平台全部构建成功），进一步让人以为"CI 整体是好的"。

## 2. 问题描述

`test.yml` 的 `Setup Node 22` 步骤里用了 `actions/setup-node@v4` 的 `cache: 'npm'`。该缓存能力**必须**在仓库里找到一个 lockfile（`package-lock.json` / `npm-shrinkwrap.json` / `yarn.lock`）来算缓存 key，否则直接报错并以非零退出码中止整个 job。

而本仓库根目录的 `package-lock.json` 被 `.gitignore` 刻意忽略了（依赖始终解析最新版本，见 `CLAUDE.md` §10 关于 SDK 的约定），**CI checkout 出来的仓库里根本没有任何 lockfile**。于是 setup-node 在缓存初始化阶段就抛错，后面的 `Install deps` 与 `Run smoke tests` 全部被跳过。

结果是：这个门禁从诞生第一天起就是坏的，58 次运行，0 次成功，0 次执行过测试。

## 3. 根因

**`.gitignore:33` 忽略 `package-lock.json` × `test.yml:27` 的 `cache: 'npm'` 二者不可兼容。**

- `.gitignore` 第 32-36 行刻意忽略全部 lockfile：
  ```
  32: # Lockfiles（子项目的 package-lock 由构建生成，不需要跟踪）
  33: package-lock.json
  34: container/agent-runner/package-lock.json
  35: web/package-lock.json
  ```
- 本地磁盘上有 `package-lock.json`（319 KB），但它**不在 git 里**：
  ```
  $ git cat-file -e HEAD:package-lock.json
  fatal: path 'package-lock.json' exists on disk, but not in 'HEAD'
  ```
- GitHub 的 check-run annotation 直接给出了报错原文（见 §5 诊断命令）：
  > Dependencies lock file is not found in /home/runner/work/deepthink/deepthink.
  > Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock

**差分验证**：`release.yml` 的 4 个 job 同样用 `actions/setup-node@v4`，但**没有** `cache:` 参数——它全部成功（run #20 `Release` = success）。`test.yml` 是全仓唯一使用 `cache: 'npm'` 的工作流，也是唯一长期失败的。这排除了"runner 环境问题""依赖装不上"等其他解释。

外部依据：[actions/setup-node 官方文档 — Caching packages dependencies](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#caching-packages-dependencies)（缓存依赖 lockfile；找不到即失败）

### 3.b 第二层根因：npm 10 arborist 在无 lockfile 全量解析时崩溃

修掉 `cache: 'npm'` 后，`Setup Node 22` 变为 success，job 继续往下走，**暴露出第二层失败**（run #59，step 4）：

```
  1. Set up job                        success    1s
  2. Run actions/checkout@v4           success    4s
  3. Setup Node 22                     success    4s   ← 第一层已修复
  4. Install deps (no-save, no audit)  failure   88s   ← 卡在这里
  5. Run smoke tests                   skipped    0s
```

88 秒才失败，说明 npm 已经实际工作了一段时间，不是配置校验类错误。本地用**与 CI 完全一致的 npm 10.9.9**（Node 22 自带）在纯净检出上复现：

```
$ npx -y npm@10 install --no-save --no-audit --no-fund   # 无 lockfile、无 node_modules
npm error Cannot read properties of null (reading 'edgesOut')
EXIT=1
```

debug 日志给出了崩溃点与触发包：

```
verbose stack TypeError: Cannot read properties of null (reading 'edgesOut')
    at #loadPeerSet (.../@npmcli/arborist/lib/arborist/build-ideal-tree.js:1289:38)
    at async #loadPeerSet (.../build-ideal-tree.js:1297:11)   ← 递归 3 层
    at async #buildDepStep (.../build-ideal-tree.js:904:11)
    at async Arborist.buildIdealTree (.../build-ideal-tree.js:181:7)
...
silly unfinished npm timer idealTree:node_modules/vitest
silly fetch manifest @vitest/browser-playwright@5.0.1
```

即：**npm 10 的 arborist 在解析 vitest 的 peer 依赖图时崩溃**。该崩溃只在没有 lockfile、必须完整构建 ideal tree 时才触发——有 lockfile 时 `buildIdealTree` 直接读 lock，不走 `#loadPeerSet`，所以本地（有 `package-lock.json`）永远复现不了。这正是本仓库"不跟踪 lockfile"策略与 CI 相撞的第二个副作用。

**对照实验（均在纯净检出 + npm 10.9.9 下）**：

| 安装命令 | 结果 |
|---|---|
| `npm install --no-save --no-audit --no-fund` | ❌ `edgesOut` 崩溃（exit 1，约 90s） |
| `npm install --no-save --no-audit --no-fund --legacy-peer-deps` | ✅ 521 包，16s |
| 同上 + `make test-smoke` | ✅ 10 文件 / 122 用例全绿（exit 0） |

即 `--legacy-peer-deps` 跳过 peer 解析（`#loadPeerSet` 不再被调用），既绕开崩溃，又完整跑通被测目标。

## 4. 复现路径

1. 本地确认 lockfile 未被跟踪：
   ```bash
   git cat-file -e HEAD:package-lock.json   # → fatal: ... does not exist in 'HEAD'
   grep -n lock .gitignore                  # → 33:package-lock.json
   ```
2. 确认 `test.yml` 用了 npm 缓存：
   ```bash
   grep -n "cache:" .github/workflows/test.yml   # → 27:          cache: 'npm'
   ```
3. 随便 push 一个 commit 到 main（或开一个 PR 指向 main），触发 `Test (smoke)`。
4. 在 Actions 页面看到 job 数秒内失败，失败步骤固定为 `Setup Node 22`，`Install deps` 与 `Run smoke tests` 均为 skipped。

## 5. 诊断方法

无需登录、可直接复制粘贴（公开仓库 API）：

```bash
# 1) 某次运行的 job/step 明细——看失败卡在哪一步
RUN_ID=$(curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/workflows/test.yml/runs?per_page=1" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['workflow_runs'][0]['id'])")
curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/runs/$RUN_ID/jobs" \
  | python3 -c "
import json,sys
for j in json.load(sys.stdin)['jobs']:
    print('==', j['name'], j['conclusion'])
    for s in j['steps']:
        print(f\"   {s['number']:>2}. {s['name']:<38} {s['conclusion']}\")"

# 2) 报错原文（annotations 里藏着 setup-node 的真实错误信息，job id 即 check-run id）
JOB_ID=$(curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/runs/$RUN_ID/jobs" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['jobs'][0]['id'])")
curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/check-runs/$JOB_ID/annotations" \
  | python3 -c "import json,sys; [print(a['message']) for a in json.load(sys.stdin)]"

# 3) 历史成功率——确认是长期问题而非偶发
curl -s "https://api.github.com/repos/AIGeniusInstitute/deepthink/actions/workflows/test.yml/runs?per_page=100" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin); rs=d['workflow_runs']
print('total', d['total_count'], '结论分布:', {c: sum(1 for r in rs if r['conclusion']==c) for c in set(r['conclusion'] for r in rs)})"
```

**注意**：下载完整日志需要仓库 admin 权限（`GET /actions/runs/{id}/logs` 匿名访问返回 403），但 **annotations 接口是公开的**，且恰好包含 setup-node 的报错原文——这是本次定位的关键。

本地对照：

```bash
make test-smoke   # 10 个文件 / 122 用例，1.3s，全绿——证明问题在 CI 配置而非测试本身
```

## 6. 修复方案

```diff
--- a/.github/workflows/test.yml
+++ b/.github/workflows/test.yml
@@ -20,16 +20,20 @@ jobs:
     steps:
       - uses: actions/checkout@v4
 
+      # 刻意不开 `cache: 'npm'`：根目录 package-lock.json 被 .gitignore 忽略……
       - name: Setup Node 22
         uses: actions/setup-node@v4
         with:
           node-version: '22'
-          cache: 'npm'
 
+      # --legacy-peer-deps 是必需的：npm 10 在无 lockfile 全量解析时会崩 #loadPeerSet
       - name: Install deps (no-save, no audit)
-        run: npm install --no-save --no-audit --no-fund
+        run: npm install --no-save --no-audit --no-fund --legacy-peer-deps
 
+      # 测试清单的唯一真相源是 Makefile 的 test-smoke target
       - name: Run smoke tests
-        run: npx vitest run \
-          tests/units/json-schema-validator.test.ts \
-          tests/units/graph-validate-node.test.ts \
-          tests/units/harness-eval.test.ts \
-          tests/chat-trace-store.test.ts \
-          tests/open-platform-validation.test.ts \
-          tests/graph-expr.test.ts
+        run: make test-smoke
```

**选型理由**：

1. **去掉 `cache: 'npm'`，而不是把 lockfile 提交进仓**。本仓库的既定策略是"依赖始终解析最新版本"（不跟踪任何 lockfile），提交根 lockfile 会与之直接冲突，且会冻结 SDK 等依赖的版本。缓存是可选优化，不能以破坏既定策略为代价——先让门禁能跑起来。
2. **测试清单改为调用 `make test-smoke`**。这是本次顺带发现的**第二个缺陷**：工作流注释写着"触发 `make test-smoke`"，但实际内联了一份**只含 6 个文件**的副本，而 Makefile 的 `test-smoke` 是 **10 个文件**。差的正是 `memory-write-trace` / `llm-call-trace` / `skill-im-command` / `tool-governance` 这 4 个——`CLAUDE.md` §11 明确要求"新增核心能力（trace / validation / eval 等）须同步加进这个清单"，有人加进了 Makefile 却漏了 CI 这份副本。改为调用 Makefile 后，清单只剩一处，这类漂移不会再发生。
3. **第二层用 `--legacy-peer-deps` 绕过，而不是在 CI 里提交 lockfile**。提交根 `package-lock.json` 是更彻底的解法（有 lock 就不走 `#loadPeerSet`，且 CI 可复现、可 `npm ci`），但它要反转仓库"不跟踪任何 lockfile、依赖始终解析最新版本"的既定策略（`.gitignore:32-36`），属于策略决策而非 bugfix，不在本次改动范围内——留给项目自行决定（见 §8 遗留项）。`--legacy-peer-deps` 的代价是不再安装 peer 依赖（521 包 vs 完整解析 600 包），但已实测被测目标不依赖任何 peer 包。

## 7. 处理卡住的状态

不适用（纯 CI 配置问题，无运行态需要救活）。补跑历史失败：无需 retry，修复推送到 main 后新触发的运行即为首次真实执行。

## 8. 经验沉淀 / 预防

1. **对所有 GitHub Actions 直接 API 可读**：`actions/runs/{id}/jobs`（哪一步失败）+ `check-runs/{job_id}/annotations`（**报错原文**，公开可读，无需 token）。这比翻 UI 或要 admin 权限下载日志快得多，建议作为排查 CI 故障的第一手段。
2. **"长期红灯"要当事故处理，不能当噪音**。这个门禁坏了 24 天、58 次运行，期间所有合并都是无保护的——`CLAUDE.md` §11 把 `make test-smoke` 描述为"CI 的 pull-request 门禁"，文档承诺与实际能力长期背离却无人发现。
3. **重复的清单必然漂移**。本例的 6 vs 10 就是同一份清单抄了两份的必然结果（还是在自己的注释里写明"跑 make test-smoke"的同一份文件里抄错的）。CI 应当调用 Makefile target，而不是复制其内容。
4. **建议加巡检**：定期（或每周）检查 `test.yml` 最近 N 次运行结论，若连续失败即告警。一条 `curl` + `jq` 即可，不必上第三方服务。
5. **遗留项（本次未处理，非失败项，避免扩大改动范围）**：
   - `actions/checkout@v4` 与 `actions/setup-node@v4` 被 GitHub 标为 "Node.js 20 is deprecated... forced to run on Node.js 24"（[2025-09-19 公告](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)），当前仅告警不失败，后续需升到 v5。
   - 未启用任何缓存后，每次运行都要完整 `npm install`（含 better-sqlite3 等原生模块编译），job 耗时上升。若日后要恢复缓存，需先引入一个被跟踪的 lockfile，或改用 `actions/cache` 手动以 `hashFiles('package.json')` 为 key。
   - **是否提交根 `package-lock.json`（策略决策，需项目拍板）**：不提交是本仓库的既定策略（依赖始终解析最新版本），代价是 CI 每次全量解析——本次的 `edgesOut` 崩溃、以及无法启用 npm 缓存、安装不可复现，都源于此。提交 lockfile 可一次性消除这类问题并让 CI 可复现；代价是依赖版本被冻结，需定期更新。两个方向都成立，取决于项目更看重"始终最新"还是"构建可复现"。
   - `--legacy-peer-deps` 不安装 peer 依赖。当前 10 个 smoke 用例只依赖 `src/` 与 `better-sqlite3`（已实测），但不排除未来新增用例需要某个 peer 包；若 CI 报 module not found，先检查是否属于这种情况。
