# 迭代 2 · 运行轨迹「展开完整轨迹」验收证据

- 需求来源：用户反馈 —— `/runtime-monitor` 运行详情 → 运行轨迹**有截断省略**，需要能展开看完整数据
- 变更文件：`web/src/components/runtime-monitor/RunDetailPanel.tsx`（**1 个文件，+53 / -8**）
- 环境：隔离实例 `http://127.0.0.1:9997`（生产 `~/.deepthink-9999` 的 `sqlite3 .backup` 快照），账号 `admin / 88888888`
- 结论：**真正修复**（12/12 通过，且旧代码在同一份数据上如实证伪）

---

## 1. 验收方式：同数据 A/B（不是"新代码跑绿就算过"）

只跑新代码通过，证明不了"用户原来真的看不到"。所以脚本设计成**同一个脚本、同一份数据、
只换前端构建产物**：

```bash
# 新代码
cd <worktree> && (cd web && npm run build)
node docs/test_report/.../ui-acceptance-expand-trace.mjs http://127.0.0.1:9997 <out-new>
#   → result-new-code.json：12/12 全绿

# 旧代码（把本次改动 patch 掉再重建，数据一个字不动）
git diff > /tmp/rm-e2e/fix.patch && git checkout -- web/src/components/runtime-monitor/RunDetailPanel.tsx
(cd web && npm run build)
node .../ui-acceptance-expand-trace.mjs http://127.0.0.1:9997 <out-old>
#   → result-old-code.json：前 5 步同样通过（现象复现），第 6 步红
git apply /tmp/rm-e2e/fix.patch && (cd web && npm run build)   # 还原
```

| | 新代码 | 旧代码 |
|---|---|---|
| 1 管理员登录 | ✅ | ✅ |
| 2 打开运行监控页 | ✅ 20 行 | ✅ 20 行 |
| 3 定位被裁轨迹（复现现象） | ✅ 12/20 条有裁切，最大隐藏 **192080px** | ✅ **同上（现象完全一致）** |
| 4 重开目标运行、runId 稳定 | ✅ `…oc_d002a8c3…#8959`，4518 步，1595 个元素被裁 | ✅ 同上 |
| 5 折叠态截图 | ✅ | ✅ |
| 6 **展开按钮存在** | ✅ 文案「展开完整轨迹」 | ❌ **红：轨迹区没有「展开完整轨迹」按钮 —— 用户无路可走** |
| 7 点击展开后不再裁切 | ✅ 6669 个元素 `line-clamp:none`，溢出 0；1595 个可视高度变大 | — |
| 8 与后端 payload 逐字对账 | ✅ 6669 个非空字段全中（最长 406 字符） | — |
| 9 展开态截图 | ✅ | — |
| 10 再点收起可逆 | ✅ 6669 个元素回到 `line-clamp:3` | — |
| 11 换运行自动复位 | ✅ | — |
| 12 原子来源不渲染死按钮 | ✅ 定时任务来源无摘要运行未渲染按钮 | — |

**旧代码的红是有信息量的红**：它红在"用户看不到展开入口"这一步（第 6 步），
而不是"选择器找不到元素"——脚本用的是**结构选择器**（轨迹列表内、只有一个标签子元素、
文本以 `入参 `/`出参 ` 开头），新旧代码上都存在。见 §4 的坑 3。

## 2. 截图

| 文件 | 内容 |
|---|---|
| `01-collapsed-long-trace.png` | **折叠态**：4518 步的长轨迹，入参/出参均被截成 3 行、以 `…` 结尾 |
| `02-expanded-long-trace.png` | **同一屏展开态**：同一位置文本完整铺开，无省略号、无裁切 |
| `03-aaas-collapsed.png` | 开放平台 AaaS 样本折叠态（用户点名要监控的 agent service 链路） |
| `04-aaas-expanded.png` | 同一条 AaaS 运行展开态 |
| `05-old-code-red.png` | **旧代码的失败现场**：轨迹区只有「运行轨迹 / 4518 步」，没有任何展开控件 |
| `06-switch-run-resets.png` | 切到另一条运行后回到折叠态（展开态未串台） |
| `07-atomic-no-button.png` | 定时任务来源的成功运行：**没有**渲染展开按钮（不产生死按钮） |

## 3. 量到的关键数字（源于 `result-new-code.json`）

| 指标 | 值 |
|---|---|
| 7 天窗口内有视觉裁切的运行 | **12 / 20** |
| 目标运行 | `chat:feishu:oc_d002a8c3c0bcf831e0af3a03928d5391#8959`，4518 步 |
| 折叠态被裁元素 | **1595** 个，累计隐藏 **192080 px** |
| 展开后元素总数 / 处于 `line-clamp` | 6669 / **0** |
| 展开后仍视觉溢出（`scrollHeight > clientHeight+2`） | **0** |
| 展开后可视高度变大的原被裁元素 | **1595**（= 折叠时被裁的全部） |
| 逐字对账字段 | **6669** 个非空字段全部在 DOM 中出现（最长 406 字符） |
| AaaS 样本 | `open-platform:13515427-…`，2 步，最长字段 178 字符，展开后完整可见 |

## 4. 三个差点让验收失去意义的方法论坑（已写进 issue 文档 §8）

1. **`textContent` 在 CSS 裁剪下依然是全文** —— 断言"页面上有这段文字"会在截断存在时照样通过。
   第一版脚本的判据是"存在 `line-clamp:3` 的元素"，结果选中了一条**一个字都没被裁**的运行，
   报「隐藏 0px」，等于什么都没验。**正确判据是几何量**：`scrollHeight > clientHeight` 才算真被裁。
2. **AaaS 那条一度红得没有信息量** —— 第一次 A/B 拿生产 `:9999` 跑，7 天窗口里 20 行没有一行被裁，
   红在"定位"这一步，证明不了任何事。换成**同一份数据的隔离快照**后才有区分度。
3. **选择器必须新旧代码两边都存在** —— 用本次新加的 `data-testid` 去选，旧代码会红在"找不到元素"，
   这种红没有信息量。改用结构选择器后，旧代码如实红在"没有展开按钮"。

另外两处环境坑（与本功能无关但会污染结果）：PWA 的 Service Worker 会 precache 旧 JS，
rebuild 后仍跑老代码 → 新建 context 时传 `serviceWorkers: 'block'`；`/tmp` 下的脚本要从绝对路径
import 仓库内的 `node_modules/playwright-core/index.mjs` 并显式传 `executablePath`。

## 5. 覆盖缺口（诚实登记）

- **移动端视口未实测**：本次只在 1440×1000 下验收。展开长文本在窄屏下的换行表现未验证。
- **`定时任务` 分支靠种子数据打通**：本机生产库里 `定时任务 / 沙箱 / 评测` 三个来源一条运行都没有，
  该分支在真实数据上走不到。往**隔离快照**插了一条种子记录后才跑通（`scheduled_tasks` +
  `task_run_logs`，`status='success'`、`error=NULL`），截图 `07-atomic-no-button.png` 即该场景。
- **展开只到"库里存的那一份"**：`thinking` 步写入时即被 `slice(0,500)`
  （`container/agent-runner/src/trace-node-allocator.ts:316,324`），生产 119 行里 108 行已触顶；
  `turn` 步上限 400（`agent-runner/src/index.ts:2413`）。**这些行展开后仍只有 500/400 字符**，
  属于容器运行时的既有决策，本次按 Surgical Changes 未改，已在 issue 文档 §3.1 登记。
- **AaaS 写入侧上限尚未被真实流量压过**：生产 `open_platform_runs` 当前 **0 行**，
  页面上可见的 8 条 AaaS 运行全部由探针调用产生、只存在于隔离快照。埋点链路有单测 + 探针覆盖，
  但真实流量下是否会触及 `SUMMARY_MAX = 500` 有待上线后复核。

## 6. 产物清单

```
iteration-2-trace-expand/
├── EVIDENCE.md                       # 本文件
├── ui-acceptance-expand-trace.mjs    # A/B 验收脚本（结构选择器，新旧代码通用）
├── expand-trace-aaas.mjs             # AaaS 专项取证脚本
├── result-new-code.json              # 新代码：12/12 通过
├── result-old-code.json              # 旧代码：红在第 6 步「没有展开按钮」
├── aaas-result.txt                   # AaaS 样本的量测输出
└── screenshots/                      # 7 张，见 §2
```
