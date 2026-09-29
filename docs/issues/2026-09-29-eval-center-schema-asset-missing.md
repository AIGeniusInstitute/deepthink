# 2026-09-29 — 生产构建丢失运行时资产：Eval Center 的 `eval-schema.sql` 不在 dist/ 里

## 1. 用户现象

服务启动日志里有一条 WARN（不致命，但意味着 Eval Center 整个能力不可用）：

```
[2026-09-29 10:03:13.002] WARN (31676): Eval Center PG init failed (eval center disabled)
    err: {
      "type": "Error",
      "message": "ENOENT: no such file or directory, open '/Users/edy/deepthink/dist/eval-center/eval-schema.sql'",
      "code": "ENOENT",
      "path": "/Users/edy/deepthink/dist/eval-center/eval-schema.sql"
    }
```

`/api/eval-center/*` 全部不可用；前端的 Eval Center 页面拿不到数据。用 `tsx src/index.ts` 开发模式跑则一切正常 —— 只在生产构建（`node dist/index.js`）下出现。

## 2. 问题描述

`src/eval-center/eval-db.ts` 在 `initEvalDb()` 里用**相对于编译产物目录**的路径读取建表 SQL：

```ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));   // → dist/eval-center/
const schemaPath = path.join(__dirname, 'eval-schema.sql');        // → dist/eval-center/eval-schema.sql
const schemaSql = fs.readFileSync(schemaPath, 'utf8');
```

而构建链路里**没有任何一步把这个 `.sql` 拷进 `dist/`**：`tsc` 只产出 `.js`。于是生产构建里该文件必然不存在，`readFileSync` 抛 ENOENT，`initEvalDb()` 失败，Eval Center 被整体禁用（`src/index.ts` 捕获后降级为 WARN）。

开发模式用 `tsx` 直接跑 TS 源码，`__dirname` 指向 `src/eval-center/`，所以文件就在旁边 —— 这解释了"开发正常、生产挂"。

## 3. 根因

### 3.1 代码层面

`tsc`（`tsconfig.json`: `rootDir: ./src`, `outDir: ./dist`）只 emit `.js`，非 TS 资产一律不拷贝。`src/` 下被运行时按路径读取的非 TS 文件只有一个：

```bash
$ find src -type f ! -name "*.ts"
src/pty-worker.cjs                        # 经 ../src/ 读取，不在 dist 内，见 §8
src/eval-center/eval-schema.sql           # ← 本 issue
```

根 package.json 原本的构建脚本是纯 `tsc`：

```json
"build": "tsc",
```

### 3.2 为什么 Docker/K8s 部署也中招（且更隐蔽）

`deploy/docker/Dockerfile.server` 的后端构建阶段**绕过 npm script 直接调 tsc**：

```dockerfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc
```

即使当时有 `postbuild` 之类的钩子，这条 `npx tsc` 也不会触发它。K8s/云部署（`docker-compose.yml` 里 `EVAL_PG_URL` 可用的那套）反而比单机更可能真正启用 Eval Center，所以这里也必须一起修。

> 外部依据：[TypeScript 文档 — Compiler Options / outDir](https://www.typescriptlang.org/tsconfig#outDir)（只 emit JS，不搬运资产）；[electron-builder extraResources](https://www.electron.build/configuration/contents#extraresources) 只打包 `../dist`，不含 `../src`。

## 4. 复现路径

```bash
cd /Users/edy/deepthink

# 1) 干净构建（不依赖增量缓存）
rm -rf dist && npm run build

# 2) 看资产在不在 dist 里 —— 修复前为空
ls dist/eval-center/*.sql

# 3) 跑生产入口，观察启动 WARN
node dist/index.js 2>&1 | grep -A3 "Eval Center"
```

修复前步骤 2 报 `No such file or directory`，步骤 3 出现 §1 的 ENOENT WARN。

## 5. 诊断方法

```bash
# 找出所有"运行时按 __dirname 读文件"的点（这类资产必须在构建时拷贝）
grep -rn "__dirname\|fileURLToPath(import.meta.url)" src/

# 列出 src 下的非 TS 文件（构建时必须显式搬运的候选）
find src -type f ! -name "*.ts"

# 确认生产产物里有没有
ls -l dist/eval-center/

# 直接跑编译产物里的 initEvalDb，不启动整个服务（最快验证）
node -e "import('./dist/eval-center/eval-db.js').then(m=>m.initEvalDb()).then(()=>console.log('INIT_OK'))"

# 端到端（需要 pgvector，见 §6 验证表）
docker run -d --rm --name dt-eval-check -e POSTGRES_PASSWORD=test -p 5436:5432 pgvector/pgvector:pg16
docker exec -e PGPASSWORD=test dt-eval-check psql -U postgres \
  -c "CREATE ROLE eval LOGIN SUPERUSER PASSWORD 'eval123';" \
  -c "CREATE DATABASE eval_center OWNER eval;"
node -e "import('./dist/eval-center/eval-db.js').then(m=>m.initEvalDb()).then(()=>console.log('INIT_OK'))"
```

## 6. 修复方案

三处改动，都指向同一个目的：**让"资产搬运"成为构建脚本的一部分，而不是某个调用方记得去做的动作。**

```diff
 // package.json
-    "build": "tsc",
+    "build": "tsc && node scripts/copy-runtime-assets.cjs",
```

```js
// scripts/copy-runtime-assets.cjs（新增，跨平台：不依赖 mkdir -p / cp）
const ROOT = path.resolve(__dirname, '..');
// src/<rel> → dist/<rel>
const ASSETS = ['eval-center/eval-schema.sql'];
for (const rel of ASSETS) { /* 校验存在 → mkdirSync → copyFileSync */ }
```

```diff
 # deploy/docker/Dockerfile.server（后端构建阶段）
 COPY tsconfig.json ./
 COPY src/ ./src/
+COPY scripts/ ./scripts/
 COPY web/tsconfig.json web/tsconfig*.json ./web/
-RUN npx tsc
+# 用 npm run build 而不是 npx tsc：build 里含运行时资产拷贝，
+# 直接调 tsc 会让生产镜像丢掉该资产，Eval Center 初始化 ENOENT。
+RUN npm run build
```

选型理由：

- **放在 `build` 脚本里而不是 `postbuild`**：`build:all`、`make build`、桌面打包、CI 都走 `npm run build`；`postbuild` 也能覆盖 `npm run build`，但把两步并成一个脚本语义更直白，也避免"有人只跑 tsc"——`Dockerfile.server` 就是这么漏的。
- **用 Node 脚本而不是 `mkdir -p && cp`**：仓库有 Windows 桌面构建（`desktop-pack-win`），npm script 在 cmd.exe 下跑不了 `mkdir -p`。脚本用 `node:fs`，全平台一致。
- **`ASSETS` 用显式清单而不是扫 `src/**`**：运行时资产必须**逐个确认**（哪些真被 `__dirname` 读、放到 dist 的哪个子目录），自动扫描会把不该进产物的东西也带进去。

验证证据（全部实测）：

| 验证项 | 结果 |
|---|---|
| `rm -rf dist && npm run build` | `✅ 已复制 1 个运行时资产到 dist/` |
| `diff src/eval-center/eval-schema.sql dist/eval-center/eval-schema.sql` | 逐字节相同 |
| 真实 PG 端到端：`pgvector/pgvector:pg16` + **未设 `EVAL_PG_URL`**（走默认 `postgresql://eval:eval123@localhost:5436/eval_center`）+ 编译产物 `initEvalDb()` | `INIT_OK` / 日志 `Eval Center PG schema applied` |
| 建表结果 | `eval_center` 库里 16 张表（`agent_trace` / `eval_case_embedding` / `eval_dataset` / `eval_dataset_version` / `eval_drift_report` / …），与 CLAUDE.md「评测中心独立的 16 张表」一致 |
| `make typecheck` | 三项目全通过 |
| `make test-smoke` | 10 文件 / 122 passed |
| `make test` | 1711 passed / 0 failed（148 文件 / 1725 用例） |
| `.github/workflows/test.yml` YAML 解析 | 通过，新步骤位于 checkout 之后、npm install 之前 |

## 7. 处理卡住的状态

不需要。Eval Center 初始化失败是被 `src/index.ts` 捕获并降级为 WARN 的，服务其余部分正常启动（这也是它潜伏至今、只在日志里露头的原因）。修完重启即可。

## 8. 经验沉淀 / 预防

1. **新增"运行时按路径读取"的非 TS 资产时，必须同时加进 `scripts/copy-runtime-assets.cjs` 的 `ASSETS`**。判据：只要在 `src/` 下写了 `fs.readFileSync(path.join(__dirname, ...))`，就要问一句"这个文件在生产构建里存在吗"。

2. **本 issue 的同类风险（已确认，未修）**：`src/terminal-manager.ts:16` 用 `path.resolve(__dirname, '..', 'src', 'pty-worker.cjs')` 读 worker —— 在仓库部署形态下 `..` 恰好回到仓库根，能命中 `src/pty-worker.cjs`；但桌面版打包只带 `../dist`（`desktop/build/*.json` 的 `extraResources` 里**没有** `../src`），所以在 `.dmg` 里该路径解析不到。`terminal-manager` 有 pipe fallback，实际影响待验证，本次未动（避免夹带未经测试的改动）。若要修，正确做法是把这个 worker 也纳入 `copy-runtime-assets.cjs` 并让代码从 `dist/` 侧读取。

3. **`npx tsc` 是构建链路上的静默陷阱**：凡绕过 `npm run build` 直接调编译器的地方，都会丢失 npm script 里的构建后步骤。仓库里现存一处（已在本 issue 修掉）；建议新增 Dockerfile / CI 步骤时统一用 `npm run build`。

4. **`resolveJsonModule: true` 只解决"import 的 JSON 被内联"，不解决"运行时按路径读的文件"**——后者必须拷贝，这条容易混。
