# 2026-09-12 评测中心 Drift 评分 toFixed 崩溃

## 1. 用户现象
评测中心前端「漂移检测」tab 打开后整页空白；此前点击「结果分析」tab 内的某条结果卡片后，后续所有 tab（漂移 / 新建项目对话框 / 发起评测对话框）也变为近空白页（6488 字节截图）。其他 tab（概览 / 数据集 / 用例 / 评分标准 / 运行 / 结果）正常。

## 2. 问题描述
`EvalCenterPage.tsx` 的 `DriftTab` 组件对 `drift_score` 字段调用 `.toFixed(2)`，但该字段来自 PostgreSQL `NUMERIC` 列，经 JSON 序列化后是**字符串**（如 `"0.5"`），字符串没有 `toFixed` 方法，抛 `TypeError: c.toFixed is not a function`。该错误是 React 渲染期未捕获异常，导致整个 DriftTab 子树卸载为空白；又因该 pageerror 在 Playwright 点击结果卡片后才暴露，掩盖了真实根因——后续 tab 的空白实为同一次渲染崩溃的连带表现。

## 3. 根因
- **类型层**：`web/src/api/eval-center.ts` 的 `DriftReport.drift_score` 声明为 `number`，但 PG `NUMERIC` 经 `pg` 驱动 + JSON 序列化返回 `string`，TS 类型与运行时实际不符，静态检查无法发现。
- **代码层**：`EvalCenterPage.tsx` 两处直接 `.toFixed(2)`：
  - 检测结果卡片：`{d.drift_score?.toFixed(2) ?? 0}`
  - 历史报告行：`({r.drift_score?.toFixed(2)})`
- **对照**：同页 `pass_rate` 用 `(r.pass_rate * 100).toFixed(0)` 未崩，因 `*` 隐式把字符串强转为 number，结果仍是 number，`toFixed` 可用——证明问题仅在「直接对可能为字符串的字段调 toFixed」。

## 4. 复现路径
1. `cd ~/deepthink && make start-prod PORT=9999`（已起，evalpg-5436 PG 容器 Up）
2. 浏览器登录 → `/eval-center`
3. 选「冒烟数据集」→ 选 v1 published 版本（设置 `curVersion`，DriftTab 才渲染检测按钮）
4. 点「漂移检测」tab
5. 页面空白；DevTools Console 报 `c.toFixed is not a function`

自动化复现：见 `scripts/eval-center-gate.sh` 的 drift 断言段，或 `node -e`（playwright-core）切到漂移 tab 后读 `pageerror`。

## 5. 诊断方法
```bash
# 1) 确认 PG drift_score 是字符串
COOKIE="deepthink_session=<token>.<sig>"
curl -s -H "Cookie: $COOKIE" "http://localhost:9999/api/eval-center/drift/reports?dataset_version_id=<vid>" | jq '.[0].drift_score | type'
# → "string"

# 2) 前端 pageerror 捕获
node -e "
const {chromium}=require('playwright-core');
const fs=require('fs');
const [n,v]=fs.readFileSync('/tmp/eval-cookie-line.txt','utf-8').trim().split('\\n').pop().split('=');
(async()=>{
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'],headless:true});
  const ctx=await b.newContext({viewport:{width:1440,height:1000}});
  await ctx.addCookies([{name:n,value:v,domain:'localhost',path:'/'}]);
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://localhost:9999/eval-center',{waitUntil:'networkidle'});
  // ... 选数据集+版本 ...
  await p.getByRole('tab',{name:/漂移检测/}).click();
  await p.waitForTimeout(1000);
  console.log(errs);
  await b.close();
})();
"
```

## 6. 修复方案
`web/src/pages/EvalCenterPage.tsx`，两处 `drift_score?.toFixed(2)` → `Number(drift_score ?? 0).toFixed(2)`：

```diff
- {d.drift_score?.toFixed(2) ?? 0}
+ {Number(d.drift_score ?? 0).toFixed(2)}

- ({r.drift_score?.toFixed(2)})
- ({Number(r.drift_score ?? 0).toFixed(2)})
```

**选型理由**：`Number()` 显式把 PG NUMERIC 字符串转 number，语义最清晰、改动最小（外科手术原则）。不选 `parseFloat`（对 `null`/`undefined` 返回 NaN 需再兜底）、不改 API 层类型声明（`drift_score: number` 的声明对纯前端消费方足够，PG 字符串是传输层细节，不应污染业务接口契约——若后续发现更多字段受害再考虑统一在 API client 层 coerce）。

## 7. 处理卡住的状态（不适用）
无运行态卡死。崩溃是渲染期，刷新或切到其他 tab 即恢复；数据无损坏。

## 8. 经验沉淀 / 预防
- **PG NUMERIC → JSON 是字符串**：凡 PG `NUMERIC`/`DECIMAL` 列经 HTTP JSON 暴露给前端，前端类型声明写 `number` 是**谎言**。后续所有对该类字段的数值方法调用（`.toFixed` / `.toPrecision` / `Math.round`）必须先 `Number()`。
- **巡检**：`grep -rn "toFixed\|toPrecision" web/src/pages/` 对命中行核对字段来源是否 PG NUMERIC。
- **类型层根治（后续）**：可在 `apiFetch` 返回层或 API client 对已知 NUMERIC 字段统一 `Number()` 转换，让接口契约与运行时一致；本次仅修 drift_score（Surgical Changes，不扩大改动面）。
- **测试教训**：漂移 tab 此前无截图验收，故该 bug 在「后端 TC1-TC20 全过」后才暴露——前端渲染崩溃必须靠真实浏览器截图 + pageerror 监听捕获，curl 测不到。
