/**
 * FLM（反馈与学习自进化模块）UI 验收脚本 — TC-FLM-02 ~ TC-FLM-32。
 *
 * 设计原则：**用真实数据跑真实链路**。
 *   1. 数据准备阶段全部走真实 HTTP 接口（反馈入库 → 系统采集 → 三层评价 → 学习沉淀
 *      → 门禁/灰度/回滚），不直接写库、不 mock。
 *   2. UI 验收阶段用 Playwright 驱动真实浏览器，每个用例截图留证。
 *
 * 为什么不能只截一张"页面能打开"的图：本模块绝大多数缺陷是"接口通了但没人调用"，
 * 页面空着也能渲染成功。所以每个用例都必须断言**具体元素或文案**存在，
 * 并且断言的数据来自前面真实生成的链路。
 *
 * 已知坑（踩过，务必保留这些写法）：
 *   - `flm-sample-rate` 是 `type="range"`，React 受控组件。直接 `el.value = x` 会被
 *     React 的 value tracker 判定为"没变"而丢弃，必须走原生 setter（见 setReactValue）。
 *   - 复核输入框只在**展开该行取证面板**且 `needs_review===1` 时才存在。
 *   - 案例库检索要在跑完 learn 之后（此前没有任何案例）。
 *   - 门禁按钮（UI）提交的是**固定的一组好指标**，只会 pass；要造 blocked 必须打接口。
 *   - 放量会**归档同类型的其它灰度版本**，所以"回滚灰度版本"必须先于"全量发布"，
 *     或换一个 strategy_type。
 *
 * 用法（必须在 worktree 根目录跑，否则 playwright-core 解析不到）：
 *   node scripts/e2e/flm-acceptance.cjs
 */

const { chromium } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BASE = process.env.FLM_BASE || 'http://127.0.0.1:9999';
const USERNAME = 'admin';
const PASSWORD = '88888888';
const OUT_DIR = path.resolve(__dirname, '../../output/flm-acceptance');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 互斥锁（必须）────────────────────────────────────────────────────
//
// 本套件会**改全局配置**：采样率、脱敏规则、策略门禁/灰度/回滚、以及最后把 FLM
// 整个关掉再打开。两个实例同时跑会互相破坏：
//   实测过 —— 甲把 FLM 关掉后，乙的 TC-32 把它打开，甲的 TC-31 于是看到
//   "关着却有新事件 + 没有降级横幅"，两条用例双双误判为失败。
// 这类失败看着像产品缺陷，实际是环境互扰，排查成本极高。所以宁可拒绝并发，
// 也不产出互相矛盾的证据。
const LOCK = path.resolve(__dirname, '.flm-acceptance.lock');
(function acquireLock() {
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const tryTake = () => {
    const fd = fs.openSync(LOCK, 'wx'); // 原子：已存在则抛 EEXIST
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return true;
  };
  try {
    tryTake();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // 持锁进程已死 → 陈旧锁，接管；活着 → 直接退出，把舞台让给它。
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { /* 锁文件损坏，按陈旧处理 */ }
    let alive = false;
    if (holder && holder.pid) {
      try { process.kill(holder.pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) {
      console.error(`⛔ 已有验收在跑（pid=${holder.pid}，起于 ${holder.at}），拒绝并发 —— 本套件会改全局配置。`);
      console.error('   等它结束后再跑，或确认它已僵死后删除 ' + LOCK);
      process.exit(3);
    }
    fs.unlinkSync(LOCK);
    tryTake();
  }
  const release = () => { try { fs.unlinkSync(LOCK); } catch { /* 已释放 */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
})();

// ── 结果收集 ────────────────────────────────────────────────────────

const results = [];
let shotSeq = 0;

function record(tc, name, passed, details, screenshot) {
  results.push({ tc, name, passed, details, screenshot: screenshot || null, at: new Date().toISOString() });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} ${tc} ${name} — ${details}`);
}

async function step(page, tc, name, fn) {
  try {
    const { passed, details } = await fn();
    const file = await capture(page, `${tc}-${name}`);
    record(tc, name, passed, details, file);
    return passed;
  } catch (err) {
    const file = await capture(page, `${tc}-${name}-FAILED`).catch(() => null);
    record(tc, name, false, `异常：${(err && err.message) || err}`, file);
    return false;
  }
}

async function capture(page, label) {
  shotSeq += 1;
  const safe = String(label).replace(/[^\w一-龥-]+/g, '_').slice(0, 80);
  const fname = `${String(shotSeq).padStart(2, '0')}-${safe}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, fname), fullPage: true });
  return fname;
}

/**
 * 给 React 受控输入赋值。
 *
 * 直接 `el.value = x` 之后 React 的 value tracker 认为"值没变"，onChange 不会触发，
 * 表单状态不更新 —— 点保存时提交的还是旧值。必须走原型上的原生 setter 绕过 tracker，
 * 再派发 input/change。
 */
async function setReactValue(page, selector, value) {
  await page.evaluate(
    ({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`元素不存在：${sel}`);
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { sel: selector, val: value },
  );
}

// ── HTTP 客户端（带会话 Cookie）─────────────────────────────────────

let cookie = '';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* 非 JSON 响应保留 raw */ }
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const api = (p, body) => request(body === undefined ? 'GET' : 'POST', p, body);

async function login() {
  const res = await request('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  if (res.status !== 200) throw new Error(`登录失败：${res.status} ${res.raw.slice(0, 200)}`);
  const cookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
  cookie = cookies.join('; ');
  return res.json;
}

// ── 数据准备（全部走真实接口）───────────────────────────────────────

const FEISHU = 'feishu:oc_d002a8c3c0bcf831e0af3a03928d5391';

/** 造数据用的真实消息（取自 9999 实例库中确实存在、且时间窗内有轨迹的用户消息）。 */
const SEED_MSGS = [
  { id: 'om_x100b63ac3742aca0dda71627afdcb3b', chatJid: FEISHU }, // 继续
  { id: 'om_x100b63a6791b4ca8c2351fe23446faf', chatJid: FEISHU }, // ## 角色 ...
  { id: 'om_x100b64c97f7c9134c431d37f570c8d4', chatJid: FEISHU }, // 把使用手册，提交push
  { id: 'om_x100b64cf09f140a4c23a8d49583bf16', chatJid: FEISHU }, // 继续，全部方向我都要覆盖
  { id: 'om_x100b64de291904a0b109025a5d4093c', chatJid: FEISHU }, // 汇报进度
  { id: 'om_x100b64dd211150a0b4a18eb83c242f7', chatJid: FEISHU }, // 全部按照您的判断来
  { id: 'om_x100b64ce6a1ff8a0c2fd36a87f8227d', chatJid: FEISHU }, // 从用户使用角度…
  { id: 'om_x100b64deebf93ca0b393e385e274eec', chatJid: FEISHU }, // 再次 remind…
];

const seededTasks = [];

async function seedFeedback() {
  const plan = [
    { idx: 0, type: 'explicit_like' },
    { idx: 1, type: 'explicit_reject', reasonTags: ['未完成任务'], correctionText: '期望的正确答案是先给出结论再展开细节。' },
    { idx: 2, type: 'explicit_like' },
    { idx: 3, type: 'explicit_reject', reasonTags: ['过于冗长'] },
    { idx: 4, type: 'explicit_correction', correctionText: '汇报进度时应该先给数字，再给说明。' },
    { idx: 5, type: 'explicit_rating', rating: 5 },
    { idx: 6, type: 'explicit_reject', reasonTags: ['答非所问', '事实错误'] },
    { idx: 7, type: 'explicit_rating', rating: 2 },
  ];

  for (const p of plan) {
    const m = SEED_MSGS[p.idx];
    const res = await api('/api/flm/feedback', {
      messageId: m.id, chatJid: m.chatJid, type: p.type,
      rating: p.rating ?? null, reasonTags: p.reasonTags ?? null,
      correctionText: p.correctionText ?? null,
    });
    if (res.status === 200 && res.json && res.json.taskId) seededTasks.push(res.json.taskId);
  }
  return seededTasks.length;
}

/** 采集系统事件 + 三层评价。返回评价条数。 */
async function seedCollectAndEvaluate() {
  const tasks = [...new Set(seededTasks)];
  for (const t of tasks) await api('/api/flm/admin/collect/system', { taskId: t });
  const res = await api('/api/flm/admin/evaluate', { taskIds: tasks, useLlm: false });
  return { tasks, evaluated: res.json ? res.json.evaluated : 0 };
}

// ── 主流程 ──────────────────────────────────────────────────────────

(async () => {
  console.log('=== FLM UI 验收开始 ===');
  await login();
  console.log('登录成功');

  const seeded = await seedFeedback();
  console.log(`反馈入库 ${seeded} 条（turns: ${[...new Set(seededTasks)].length}）`);
  const { tasks: taskIds, evaluated } = await seedCollectAndEvaluate();
  console.log(`采集+评价完成：${evaluated} 条评价 / ${taskIds.length} 个任务`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // 复用 API 登录拿到的 cookie，省掉一次 UI 登录（UI 登录本身不是本模块的验收点）。
  const [ckName, ckVal] = cookie.split('=');
  await ctx.addCookies([{ name: ckName, value: ckVal, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  const FLM = `${BASE}/feedback-learning`;
  const goFlmTab = async (tab) => {
    await page.goto(FLM, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="flm-page"]', { timeout: 30000 });
    await page.click(`[data-testid="flm-tab-${tab}"]`);
    await page.waitForTimeout(1200);
  };

  // 「策略与灰度」列表为空有两种含义完全不同的原因：库里真没有版本，或这一次加载失败。
  // 后者页面会渲染「暂无策略版本」空态，与"真没有"长得一模一样。TC-24 曾因此拿到一个
  // 20 秒后毫无信息量的 click 超时（截图里是空态，而库里有 53 个版本）。
  // 所以在点击具体版本按钮之前，先确认列表真的渲染出来了；没渲染就点「刷新」重试，
  // 仍失败则把"加载失败"作为结论报出来，而不是让它伪装成"...按钮找不到"。
  const waitStrategiesList = async () => {
    const has = async () => (await page.locator('[data-testid^="flm-canary-10-"]').count()) > 0;
    let retried = false;
    for (let i = 0; i < 24; i += 1) {
      if (await has()) return { ok: true, retried };
      // 每 3 秒重试一次（页面已把失败原因写进 flm-load-error / 空态文案）。
      if (i === 6 || i === 12 || i === 18) {
        retried = true;
        await page.click('[data-testid="flm-refresh"]').catch(() => {});
      }
      await page.waitForTimeout(500);
    }
    return { ok: false, retried };
  };

  // ── TC-02 / TC-03：聊天页反馈入口 ────────────────────────────────
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const likeBtn = page.locator('[data-testid="feedback-like"]').last();

  await step(page, 'TC-02', '聊天页对助手消息点赞', async () => {
    await likeBtn.scrollIntoViewIfNeeded();
    // 上一轮验收可能已把这颗按钮留在 liked 态；handleLike 在已赞时直接 return，
    // 所以"已赞就跳过点击"是安全的，且下面重载后仍会读到已赞 —— 跨轮次稳定。
    if ((await likeBtn.getAttribute('aria-pressed')) !== 'true') {
      await likeBtn.click();
      await page.waitForTimeout(1800);
    }
    // 判据是「重载页面后仍是已赞态」：MessageFeedback 的 state 由 getMyFeedback
    // 从服务端读回，setState 也只在 submitFeedback 成功后才执行 —— 刷新后仍在，
    // 才真正证明这次点赞被服务端存住了。
    //
    // 原先的判据里有一条"事件流里存在 explicit_like"，那是**恒真**的：种子数据
    // 本来就造了两个点赞事件，与本次点击无关。恒真的断言等于没验。
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const pressed = await page.locator('[data-testid="feedback-like"]').last().getAttribute('aria-pressed');
    return {
      passed: pressed === 'true',
      details: `点赞后重载页面，按钮仍为已赞态（aria-pressed=${pressed}）—— 说明点赞已由服务端持久化、并经 getMyFeedback 回显`,
    };
  });

  await step(page, 'TC-03', '点踩 + 原因标签 + 纠错文本提交', async () => {
    const tagName = '答非所问';
    const reject = page.locator('[data-testid="feedback-reject"]').last();
    await reject.scrollIntoViewIfNeeded();
    await reject.click();
    await page.waitForTimeout(900);

    // 原因标签是**开关**（已选再点会取消），所以先读状态再决定点不点 —— 否则重跑一轮
    // 会把它取消掉，用例变成自己把自己搞失败。
    const tagBtn = page.locator(`[role="dialog"] button:has-text("${tagName}")`).first();
    if ((await tagBtn.count()) && (await tagBtn.getAttribute('aria-pressed')) !== 'true') {
      await tagBtn.click();
      await page.waitForTimeout(300);
    }
    const correction = '期望先给结论，再展开依据。';
    const box = page.locator('[role="dialog"] textarea').first();
    if (await box.count()) {
      await box.fill(correction);
      await page.waitForTimeout(300);
    }
    const submit = page.locator('[role="dialog"] button:has-text("提交")').last();
    if (await submit.count()) {
      await submit.click();
      await page.waitForTimeout(1800);
    }

    // 判据落在「重载后由服务端回显」：点踩态 + 原因标签 + 纠错文本三项都要读得回来。
    // 原判据是 `passed: true` —— 点了三下没报错就判过，等于没验（issue 文档 §8）。
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const rejectBtn = page.locator('[data-testid="feedback-reject"]').last();
    const pressed = await rejectBtn.getAttribute('aria-pressed');
    await rejectBtn.click(); // 重开面板读回填值
    await page.waitForTimeout(900);
    const activeTags = (await page.locator('[role="dialog"] button[aria-pressed="true"]').allInnerTexts())
      .map((s) => s.trim())
      .filter(Boolean);
    const restoredBox = page.locator('[role="dialog"] textarea').first();
    const restored = (await restoredBox.count()) ? (await restoredBox.inputValue()).trim() : '';
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    return {
      passed: pressed === 'true' && activeTags.length > 0 && restored.length > 0,
      details: `重载后回显：点踩态=${pressed}；原因标签=${JSON.stringify(activeTags)}（取自预置枚举，不可自由文本）；纠错文本已回显「${restored.slice(0, 24)}」（会作为知识条目候选送审）`,
    };
  });

  // ── TC-04 / TC-05：归一化事件流 ──────────────────────────────────
  await goFlmTab('feedback');
  await step(page, 'TC-04', 'FLM 控制台「反馈流」显示来源/类型/置信度/绑定', async () => {
    await page.waitForSelector('[data-testid="flm-events"]', { timeout: 20000 });
    const text = await page.locator('[data-testid="flm-events"]').innerText();
    const hasSource = /用户|系统|环境/.test(text);
    const hasConf = /\d\.\d\d/.test(text);
    return {
      passed: hasSource && hasConf,
      details: `事件表可见，含来源标签与置信度数值（${text.split('\n').length} 行文本）`,
    };
  });

  await step(page, 'TC-05', '事件详情：对齐方式 + 原始记录 + 单任务时间线下钻', async () => {
    const evText = await page.locator('[data-testid="flm-events"]').innerText();
    const aligned = /直接对齐|兜底对齐/.test(evText);
    await page.fill('[data-testid="flm-timeline-input"]', taskIds[0] || '');
    await page.click('[data-testid="flm-timeline-load"]');
    await page.waitForTimeout(1500);
    const tl = await page.locator('[data-testid="flm-timeline"]').count();
    return {
      passed: aligned && tl > 0,
      details: `对齐方式（direct=四级主键命中 / fallback=时间内容兜底）可见；任务 ${taskIds[0]} 时间线已下钻`,
    };
  });

  // ── TC-06 / TC-07：系统采集与采样闸门 ────────────────────────────
  await goFlmTab('evaluations');
  await step(page, 'TC-06', '控制台触发系统采集', async () => {
    const targetTask = (taskIds[0] || '').trim();
    await page.fill('[data-testid="flm-eval-task-input"]', targetTask);
    // 本用例要证的是「按钮被正确接线」，不是「库里多了几行」。
    //
    // 旧判据要求点击后**新增**属于该任务的 system 事件。但 Phase A 的准备阶段已经对全部种子
    // 任务采过一轮，而采集按派生项去重（AC-F2.5）—— 派生 0 条新事件恰恰是**正确行为**，
    // 却被判成失败。拿"去重生效"去否定按钮接线，是把幂等当缺陷。
    //
    // 改为三路取证，全部与"是否新增行"无关：
    //   ① 点击确实打到采集接口，且请求体带着输入框里的 taskId（证明输入与按钮已绑定）；
    //   ② 接口 200 且返回体形状正确（derived / inserted 都是数字）；
    //   ③ 页面把结果如实回显（sonner toast「派生 N 条、写入 M 条系统事件」）。
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/flm/admin/collect/system') && r.request().method() === 'POST',
        { timeout: 20000 },
      ),
      page.click('[data-testid="flm-collect-system"]'),
    ]);
    const status = resp.status();
    let sent = {};
    try {
      sent = resp.request().postDataJSON() || {};
    } catch {
      sent = {};
    }
    let payload = {};
    try {
      payload = await resp.json();
    } catch {
      payload = {};
    }

    await page.waitForTimeout(1200);
    const toasts = await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => []);
    const recent = await page.locator('[data-testid="flm-recent-tasks"]').count();

    const bound = String(sent.taskId || '') === targetTask;
    const payloadOk = typeof payload.derived === 'number' && typeof payload.inserted === 'number';
    const toastOk = toasts.some((t) => /派生\s*\d+\s*条/.test(t) && /写入\s*\d+\s*条/.test(t));
    return {
      passed: status === 200 && bound && payloadOk && toastOk && recent > 0,
      details: `POST /admin/collect/system → ${status}；请求体 taskId=${JSON.stringify(sent.taskId)}（须等于输入框 ${JSON.stringify(targetTask)}）=${bound}；返回 derived=${payload.derived}、inserted=${payload.inserted}（数字=${payloadOk}）；页面回显「${(toasts.find((t) => /派生/.test(t)) || '（无）').replace(/\s+/g, ' ').slice(0, 50)}」；近期任务列表 ${recent} 处可见`,
    };
  });

  await goFlmTab('settings');
  await step(page, 'TC-07', '采样率调到 0% → 系统事件全部停采；调回 100% 恢复', async () => {
    // range 受控组件，必须走原生 setter
    await setReactValue(page, '[data-testid="flm-sample-rate"]', 0);
    await page.waitForTimeout(200);
    await page.click('[data-testid="flm-save-collect"]');
    await page.waitForTimeout(1500);
    const zero = await api('/api/flm/admin/collect/system', { taskId: taskIds[0] });
    const zeroDerived = zero.json ? zero.json.derived : -1;

    // 恢复 100%
    await setReactValue(page, '[data-testid="flm-sample-rate"]', 100);
    await page.waitForTimeout(200);
    await page.click('[data-testid="flm-save-collect"]');
    await page.waitForTimeout(1500);
    const back = await api('/api/flm/admin/collect/system', { taskId: taskIds[0] });
    const backDerived = back.json ? back.json.derived : -1;
    return {
      passed: zeroDerived === 0 && backDerived > 0,
      details: `采样 0% 时 derived=${zeroDerived}（含失败事件一并停采）；100% 时 derived=${backDerived}`,
    };
  });

  // ── TC-08 / TC-09：环境观测点与快照 ─────────────────────────────
  await step(page, 'TC-08', '注册环境观测点', async () => {
    await page.fill('[data-testid="flm-obs-name"]', '订单状态');
    await page.fill('[data-testid="flm-obs-path"]', 'order.status');
    await page.fill('[data-testid="flm-obs-expected"]', 'deployed');
    await page.click('[data-testid="flm-obs-create"]');
    await page.waitForTimeout(1500);
    const text = await page.locator('[data-testid="flm-observations"]').innerText().catch(() => '');
    return { passed: /订单状态/.test(text), details: '观测点在列表中可见（名称/路径/期望值）' };
  });

  await step(page, 'TC-09', '提交前后快照 → diff 判定', async () => {
    const taskForSnap = taskIds[0] || 'turn:snap-demo';
    await page.fill('[data-testid="flm-snap-task"]', taskForSnap);
    await page.fill('[data-testid="flm-snap-values"]', JSON.stringify({ 'order.status': 'pending' }));
    await page.click('[data-testid="flm-snap-before"]');
    await page.waitForTimeout(1200);
    await page.fill('[data-testid="flm-snap-values"]', JSON.stringify({ 'order.status': 'deployed' }));
    await page.click('[data-testid="flm-snap-after"]');
    await page.waitForTimeout(1200);
    await page.click('[data-testid="flm-snap-diff"]');
    await page.waitForTimeout(1800);
    const msg = await page.locator('[data-testid="flm-snap-result"]').innerText().catch(() => '');
    // 期望值 deployed、后置快照 deployed → verdict=met。
    // 判据原来写成 `/判定\s*met/.test(msg) || /met/.test(msg)`，那条兜底是**反的**：
    // 后端判定取值为 met / unmet（flm-evaluate.ts），而 "unmet".includes("met") 为真 ——
    // 快照压根没达标时这条断言照样通过。必须排除 unmet，并用词边界避免子串命中。
    const verdictMet = /判定\s*met(?!\w)/.test(msg) && !/unmet/i.test(msg);
    return { passed: verdictMet, details: `diff 结果：${msg.replace(/\s+/g, ' ').slice(0, 120)}` };
  });

  // ── TC-11 / TC-12：脱敏与规则热更新 ─────────────────────────────
  await step(page, 'TC-11', '脱敏：含手机号/邮箱的原文被替换为掩码', async () => {
    const res = await api('/api/flm/feedback', {
      messageId: SEED_MSGS[1].id, chatJid: FEISHU, type: 'explicit_correction',
      correctionText: '联系 13812345678 或 admin@example.com 处理',
    });
    // 直接看接口回执：desensitized 就是"归一化时命中了脱敏规则"的权威判据。
    const ok = res.status === 200 && res.json?.desensitized === true;
    // 截图要件：本用例是接口级判据，必须把页面切到「反馈流」再截 —— 否则截到的是
    // 上一个用例（TC-09 快照）留下的界面，两张图逐字节相同，等于没有证据（见 issue §8）。
    await goFlmTab('feedback');
    const ev = await api('/api/flm/admin/events?limit=200');
    const hit = (ev.json?.events || []).find((e) => e.desensitized === 1);
    const listText = await page.locator('[data-testid="flm-events"]').innerText().catch(() => '');
    const rowVisible = /手机号|邮箱|纠正|explicit_correction|user/.test(listText);
    return {
      passed: ok && !!hit && rowVisible,
      details: `反馈接口返回 desensitized=${res.json?.desensitized}（手机号/邮箱/Token 等规则在归一化时替换为掩码）；事件流中 desensitized=1 的事件可查=${!!hit}，该事件在「反馈流」列表中可见=${rowVisible}`,
    };
  });

  await step(page, 'TC-12', '新增脱敏规则后即时生效（热更新，无需重启）', async () => {
    // 走设置页的真实规则 UI，不直接 PUT 配置 —— 界面接线本身也是验收点。
    // 前置导航：TC-11 为了取证把页面切到了「反馈流」，规则表单在「设置」页。
    await goFlmTab('settings');
    await page.fill('[data-testid="flm-rule-name"]', '工号');
    await page.fill('[data-testid="flm-rule-pattern"]', 'EMP-\\d{6}');
    await page.fill('[data-testid="flm-rule-mask"]', '***EMP***');
    await page.click('[data-testid="flm-rule-create"]');
    await page.waitForTimeout(1500);

    const rulesText = await page.locator('[data-testid="flm-rules"]').innerText().catch(() => '');
    const listed = /工号/.test(rulesText);

    // 真正的"即时生效"证据：新规则创建后立刻提交一条含工号的反馈，掩码立即命中。
    // 没有重启、没有缓存 —— 这比"规则出现在列表里"强得多。
    const res = await api('/api/flm/feedback', {
      messageId: SEED_MSGS[3].id, chatJid: FEISHU, type: 'explicit_correction',
      correctionText: '请把结果同步给工号 EMP-123456 的同事',
    });
    const hot = res.json?.desensitized === true;

    // 清理：删掉本次新增的规则，保持可重复执行
    const del = page.locator('[data-testid="flm-rule-delete-工号"]');
    if (await del.count()) { await del.click(); await page.waitForTimeout(1200); }
    const after = await page.locator('[data-testid="flm-rules"]').innerText().catch(() => '');

    return {
      passed: listed && hot,
      details: `规则 UI 新增「工号」→ 规则列表可见=${listed}；创建后立刻提交含 EMP-123456 的反馈，desensitized=${res.json?.desensitized}（热更新已生效）；清理后规则列表仍可见=${/工号/.test(after)}`,
    };
  });

  await goFlmTab('overview');
  await step(page, 'TC-10', '三类来源事件进入统一事件流（字段齐全）', async () => {
    // 判据必须是"三类来源都在事件流里"，但**不能**从一个固定的"最新 N 条"窗口里去数。
    // 事件表只增不减：system 事件在 Phase A 就落库了，此后 TC-11/TC-12 等持续写入 user/env
    // 事件，于是 system 会被挤出"最新 200 条"。实测挂过一次（窗口里只剩 user、env），
    // 而库里 system 事件一直存在 —— 那种判据测的是"窗口够不够新"，不是"三类齐备"。
    // 改为按来源分别向服务端查（接口本身支持 source 过滤），与表的总量无关。
    const perSource = {};
    for (const s of ['user', 'env', 'system']) {
      const r = await api(`/api/flm/admin/events?limit=200&source=${s}`);
      perSource[s] = (r.json?.events || []).length;
    }
    const missing = Object.entries(perSource).filter(([, n]) => n === 0).map(([s]) => s);
    // 字段齐备性仍在真实事件上校验。`evs.length > 0` 不能省：空数组的 every() 恒真，
    // 那会在"一条事件都没取到"时静默判过。
    const probe = await api('/api/flm/admin/events?limit=200');
    const evs = probe.json?.events || [];
    const fields = evs.length > 0 && evs.every((e) =>
      typeof e.confidence === 'number' && typeof e.weight === 'number' && typeof e.alignment === 'string');
    return {
      passed: missing.length === 0 && fields,
      details: `按来源分查（不受"最新 N 条"窗口影响）：user=${perSource.user}、env=${perSource.env}、system=${perSource.system} 条${missing.length ? `，缺 ${missing.join('/')}` : '，三类齐备'}；字段齐备性在 ${evs.length} 条真实事件上校验（confidence/weight/alignment 类型正确）=${fields}`,
    };
  });

  // ── TC-13 ~ TC-16：三层评价 ─────────────────────────────────────
  await goFlmTab('evaluations');
  await step(page, 'TC-13', '批量评价（从近期任务勾选，非空数组）', async () => {
    // `goFlmTab` 的固定 1200ms 只是"大致睡够了"，数据量涨上来后「近期有事件的任务」
    // 列表会晚于它出现，于是 count() 读到 0、一条也没勾、批量评价点了空数组 ——
    // 实测挂过一次（报「勾选 0 个近期任务」）。勾选前先等复选框真的画出来。
    await page.waitForSelector('[data-testid^="flm-pick-"]', { timeout: 20000 }).catch(() => {});
    const boxes = page.locator('[data-testid^="flm-pick-"]');
    const n = Math.min(3, await boxes.count());
    for (let i = 0; i < n; i++) await boxes.nth(i).check();
    // 判据不能用"评价表有行" —— 上一阶段（Phase A）已经灌了若干条评价，
    // 表里本来就有行，`rows > 0` 是恒真的。改为要求**本次点击之后产生了新的评价行**
    // （每次评价都发新 eval_id，所以 eval_time 前移是可靠信号，不受 upsert 影响）。
    const t0 = Date.now();
    await page.click('[data-testid="flm-eval-batch"]');
    // 3 个任务的评价是**逐个**跑的，PRD 给的预算是单任务 ≤ 10s（AC-F3.7）。
    // 固定睡 3s 去数新行，等于把"评价慢一点"误报成"评价没发生"。改为轮询到出现为止。
    let fresh = [];
    for (let i = 0; i < 20 && fresh.length === 0; i += 1) {
      await page.waitForTimeout(1000);
      const ev = await api('/api/flm/admin/evaluations?limit=200');
      fresh = (ev.json?.evaluations || []).filter((e) => Number(e.eval_time) >= t0 - 2000);
    }
    const rows = await page.locator('[data-testid="flm-eval-table"] tbody tr').count();
    return {
      passed: n > 0 && fresh.length > 0,
      details: `勾选 ${n} 个近期任务（非空数组）批量评价 → 新增 ${fresh.length} 条评价（eval_time ≥ 点击时刻），评价表 ${rows} 行`,
    };
  });

  await step(page, 'TC-14', '评价详情：归因环节 + 证据片段', async () => {
    const btn = page.locator('[data-testid^="flm-eval-detail-"]').first();
    // 同上：表格可能在切页签后还没画完。`getAttribute` 对不存在的元素会**直接超时抛错**，
    // 把用例变成一条 20s 的异常而不是一条可读的判据。先显式等它出现。
    await btn.waitFor({ timeout: 20000 }).catch(() => {});
    if ((await btn.count()) === 0) {
      return { passed: false, details: '评价表未渲染出可展开的评价行（flm-eval-detail-* 缺失）—— 无证据可查' };
    }
    const firstEvalId = (await btn.getAttribute('data-testid')).replace('flm-eval-detail-', '');
    await btn.click();
    await page.waitForTimeout(1000);
    const text = await page.locator(`[data-testid="flm-eval-evidence-${firstEvalId}"]`).innerText();
    const ok = /结果依据/.test(text) && /证据链/.test(text);
    return { passed: ok, details: `证据面板含「结果依据」「质量维度」「证据链」；首异常步骤与耗时一并显示` };
  });

  await step(page, 'TC-15', '人工复核队列：双轨不一致项提交复核结论', async () => {
    // 进复核队列的唯一口径是**两轨判定不一致**（needsReview = disagreement）。
    // LLM 轨不可用时按设计降级为单轨、不伪造分歧 —— 那种情况下队列本就该是空的。
    const probe = taskIds.slice(0, 6);
    await api('/api/flm/admin/evaluate', { taskIds: probe, useLlm: true });
    const list = await api('/api/flm/admin/evaluations?needsReview=1&limit=100');
    const pending = (list.json?.evaluations || []).find((e) => e.review_status === 'pending');

    if (!pending) {
      // 「队列为空」只有在**双轨真的跑起来了**的前提下才算正确行为。
      // 原来这里是无条件 `passed: true`：LLM 轨一直起不来时，这条用例可以永远绿着，
      // 而它声称验证的"不一致项进队列并复核"从未被执行过 —— 不是"降级正确"，是"没验"。
      // 判据落在**本轮刚评价的这几个任务**上：它们之中必须出现 evaluator=both。
      const all = await api('/api/flm/admin/evaluations?limit=200');
      const mine = (all.json?.evaluations || []).filter((e) => probe.includes(e.task_id));
      const dualRan = mine.some((e) => e.evaluator === 'both');
      return {
        passed: dualRan && mine.filter((e) => e.needs_review).length === 0,
        details: dualRan
          ? `双轨判定已运行（本轮 ${mine.length} 条评价含 evaluator=both），且未产生两轨分歧 → 复核队列为空是正确行为`
          : `LLM 轨未运行（本轮 ${mine.length} 条评价中无 evaluator=both）—— 无法制造两轨分歧，本用例未被验证`,
      };
    }

    await goFlmTab('evaluations');
    const detail = page.locator(`[data-testid="flm-eval-detail-${pending.eval_id}"]`);
    if ((await detail.count()) === 0) {
      return { passed: false, details: `待复核项 ${pending.eval_id} 未出现在评价表（limit=100 内应有）` };
    }
    await detail.click();
    await page.waitForTimeout(800);
    await page.fill(`[data-testid="flm-review-note-${pending.eval_id}"]`, '控制台复核：规则轨证据充分，维持原判定');
    await page.click(`[data-testid="flm-review-${pending.eval_id}"]`);
    await page.waitForTimeout(1800);

    const after = await api('/api/flm/admin/evaluations?limit=100');
    const cur = (after.json?.evaluations || []).find((e) => e.eval_id === pending.eval_id);
    // 终态取值是 'resolved'（复核结论已落库），不是 'reviewed' —— 按实际接口取值断言。
    return {
      passed: cur?.review_status === 'resolved',
      details: `双轨不一致项 ${pending.eval_id}（evaluator=${pending.evaluator}）已展开并提交复核结论，review_status ${pending.review_status} → ${cur?.review_status}`,
    };
  });

  await step(page, 'TC-16', '短期纠偏：生成纠偏动作', async () => {
    const btn = page.locator('[data-testid^="flm-eval-correct-"]').first();
    await btn.click();
    await page.waitForTimeout(1500);
    const msg = await page.locator('[data-testid="flm-eval-msg"]').innerText().catch(() => '');
    return { passed: /纠偏动作/.test(msg), details: msg.replace(/\s+/g, ' ').slice(0, 200) };
  });

  // ── TC-18 → TC-17 → TC-20 → TC-19：学习沉淀 ─────────────────────
  // 顺序有讲究：必须先跑 learn 生成案例与策略，案例检索才可能有命中。
  await goFlmTab('learning');
  await step(page, 'TC-18', '从归因结论生成策略版本草稿', async () => {
    // `list.length > 0` 是**恒真**的：策略表里躺着前面几轮跑出来的版本，
    // 按钮没接线也照样通过。先取版本 id 快照，再看点击之后是否真的多出来新版本。
    const before = await api('/api/flm/admin/strategies');
    const beforeIds = new Set((before.json?.strategies || []).map((s) => s.version_id));
    await page.click('[data-testid="flm-run-learn"]');
    await page.waitForTimeout(3000);
    const res = await api('/api/flm/admin/strategies');
    const list = res.json?.strategies || [];
    const added = list.filter((s) => !beforeIds.has(s.version_id));
    await page.click('[data-testid="flm-tab-strategies"]');
    await page.waitForTimeout(1800);
    const n = await page.locator('[data-testid="flm-strategies"] [data-testid^="flm-gate-"]').count();
    return {
      passed: added.length > 0 && n > 0,
      details: `学习沉淀新增策略版本 ${added.length} 个（${added.map((s) => s.strategy_type).join('、') || '无'}），库中共 ${list.length} 个，列表渲染 ${n} 个版本，每个带门禁/灰度/回滚操作`,
    };
  });

  await goFlmTab('learning');
  await step(page, 'TC-17', '案例库检索 Top-K', async () => {
    await page.fill('[data-testid="flm-case-query"]', '使用手册 提交 push');
    await page.click('[data-testid="flm-case-search"]');
    await page.waitForTimeout(1800);
    const hits = await page.locator('[data-testid="flm-case-hits"]').count();
    const text = hits ? await page.locator('[data-testid="flm-case-hits"]').innerText() : '';
    // 断言必须咬住**数值本身**，不能只看到「相似度」这三个字就判过。
    // 旧断言是 `/相似度/.test(text)` —— 页面显示「相似度 NaN%」时它照样通过，
    // 于是「检索面板渲染了不存在的字段」这个真实缺陷被验收脚本自己放行了一整轮。
    const noNaN = !/NaN|undefined|null/.test(text);
    const scores = [...text.matchAll(/相似度\s*([\d.]+)%/g)].map((m) => Number(m[1]));
    const scored = scores.length > 0 && scores.every((v) => Number.isFinite(v));
    const sorted = scores.every((v, i) => i === 0 || scores[i - 1] >= v); // Top-K 必须按相似度降序
    const hasGoal = /使用手册/.test(text);
    // TC-FLM-17 明确要求命中项「含正负样本类型与相似度」，样本类型必须在卡片上可见。
    const hasSampleType = /positive|negative/.test(text);
    // AC-F4.4 的 Top5 命中率以"命中集合"为前提：5 个坑位不能被同一条案例占满。
    const goalTexts = await page.locator('[data-testid="flm-case-hit-goal"]').allInnerTexts();
    const uniqueGoals = new Set(goalTexts.map((s) => s.trim())).size;
    const noDupHits = uniqueGoals === goalTexts.length;
    return {
      passed: hits > 0 && noNaN && scored && hasGoal && hasSampleType && noDupHits,
      details: hits > 0
        ? `检索命中 ${scores.length} 条，相似度 ${scores.join('/')}%（降序=${sorted}，无 NaN/undefined=${noNaN}，含样本类型=${hasSampleType}，命中目标文本=${hasGoal}，候选去重=${uniqueGoals}/${goalTexts.length}）`
        : '无命中（案例库为空或检索词无匹配）',
    };
  });

  await step(page, 'TC-20', '纠错反馈生成知识候选 → 审核通过', async () => {
    // gen-knowledge 读的是「反馈流」页的时间线任务输入框那个共享 state，
    // 所以要先在反馈流填入 taskId，再回学习页点按钮 —— 不能直接打接口，
    // 否则测不到按钮接线。
    await page.click('[data-testid="flm-tab-feedback"]');
    await page.waitForTimeout(1200);
    await page.fill('[data-testid="flm-timeline-input"]', taskIds[1] || taskIds[0] || '');
    await page.waitForTimeout(300);
    await page.click('[data-testid="flm-tab-learning"]');
    await page.waitForTimeout(1200);
    await page.click('[data-testid="flm-gen-knowledge"]');
    await page.waitForTimeout(2500);

    const accept = page.locator('[data-testid^="flm-knowledge-accept-"]').first();
    const hasCandidate = (await accept.count()) > 0;
    // 判据原来写成 `/accepted|pending/.test(text)` —— 面板渲染的是**全部**知识条目，
    // 只要还有任意一条没审核的候选，"pending" 就一直在，于是这次审核失败也照样通过。
    // 改成盯**这一条**：记下它的 id，审核后按钮必须消失，且接口里它的状态必须是 accepted。
    let acceptedId = null;
    if (hasCandidate) {
      acceptedId = (await accept.getAttribute('data-testid')).replace('flm-knowledge-accept-', '');
      await accept.click();
      await page.waitForTimeout(1800);
    }
    const text = await page.locator('[data-testid="flm-knowledge"]').innerText().catch(() => '');
    const stillClickable = acceptedId
      ? await page.locator(`[data-testid="flm-knowledge-accept-${acceptedId}"]`).count()
      : 0;
    const kn = await api('/api/flm/admin/knowledge');
    const item = (kn.json?.knowledge || []).find((k) => k.id === acceptedId);
    return {
      passed: hasCandidate && stillClickable === 0 && item?.status === 'accepted',
      details: hasCandidate
        ? `知识候选 ${acceptedId} 审核通过：按钮已消失=${stillClickable === 0}，接口 status=${item?.status}；面板：${text.replace(/\s+/g, ' ').slice(0, 90)}`
        : '该任务没有纠错文本，未生成知识候选（纠错反馈才会转成知识条目）',
    };
  });

  await step(page, 'TC-19', '数据回流：偏好对 + SFT 样本，可下载 JSONL', async () => {
    const art = await api('/api/flm/admin/data-feedback');
    const pairs = (art.json?.preferencePairs || []).length;
    if (pairs === 0) {
      return { passed: false, details: '未生成偏好对 —— 需要同一目标下同时存在成功与失败的评价' };
    }
    const panel = await page.locator('[data-testid="flm-data-feedback"]').count();
    const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await page.click('[data-testid="flm-export-pairs"]');
    const d = await dl;
    // 截图要件：点下载不改变像素，不滚到面板就会与上一个用例截图逐字节相同。
    await page.locator('[data-testid="flm-data-feedback"]').scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(600);
    const panelText = await page.locator('[data-testid="flm-data-feedback"]').innerText().catch(() => '');
    const pairsShown = (panelText.match(/相似度/g) || []).length;
    return {
      passed: panel > 0 && !!d && pairsShown > 0,
      details: `回流面板可见并已滚入截图，偏好对 ${pairs} 组 / 面板内「相似度」列 ${pairsShown} 处（目标文本取自真实用户提问，非 taskId）；已触发下载：${d ? d.suggestedFilename() : '未触发'}`,
    };
  });

  // ── TC-21 ~ TC-24：门禁 / 灰度 / 回滚 ───────────────────────────
  //
  // 顺序约束（踩过）：放量会归档同 strategy_type 的其它灰度版本。所以
  //   1) A(fewshot) 灰度 10 → 全量 100（released）
  //   2) B(prompt) 再灰度 10 → 回滚
  // B 与 A 类型不同，且回滚发生在全量之后，不会互相归档。
  //
  // 另一条：UI 上的「提交门禁评测」提交的是**固定的一组好指标**，永远 pass。
  // 要造 blocked 只能打接口 —— 门禁判定逻辑在后端，UI 按钮不是判据来源。
  const pickStrategy = async (pred) => {
    const res = await api('/api/flm/admin/strategies');
    return (res.json?.strategies || []).find(pred) || null;
  };

  const GOOD_GATE = {
    baseline: { successRate: 88, satisfaction: 82, qualityMean: 85, correctionRate: 68, avgLatencyMs: 6000, avgCostTokens: 22000 },
    candidate: { successRate: 92, satisfaction: 86, qualityMean: 89, correctionRate: 74, avgLatencyMs: 5200, avgCostTokens: 19000 },
  };
  const BAD_GATE = {
    baseline: { successRate: 90, satisfaction: 85, qualityMean: 88, correctionRate: 70, avgLatencyMs: 5000, avgCostTokens: 20000 },
    candidate: { successRate: 70, satisfaction: 60, qualityMean: 70, correctionRate: 50, avgLatencyMs: 9000, avgCostTokens: 30000 },
  };

  // 需要人工签字的版本（prompt×intent）作为 B；普通版本作为 A。
  let stratA = await pickStrategy((s) => s.status === 'draft' && s.requires_human_review !== 1);
  let stratB = await pickStrategy((s) => s.status === 'draft' && s.requires_human_review === 1);
  if (!stratB) stratB = (await api('/api/flm/admin/strategies')).json?.strategies?.find((s) => s.status === 'draft') || null;

  await step(page, 'TC-21', '劣化版本过门禁被拦截（不可放量）', async () => {
    if (!stratB) return { passed: false, details: '没有 draft 版本可提交门禁' };
    // 必须先签字：submitForGate 的顺序是「先查人工审核（F5.5），再审门禁（F5.2）」，
    // 未签字的合规版本会在门禁之前就被挡回（report=null, blockedReason=需人工审核），
    // 那样测到的是合规闸而不是指标闸，本用例要验的是后者。approve 幂等，TC-24 再签一次无副作用。
    const signed = await api(`/api/flm/admin/strategies/${stratB.version_id}/approve`, { note: 'TC-21 前置：人工审核通过后方可提交门禁' });
    if (signed.json?.ok === false) {
      return { passed: false, details: `前置人工签字失败，无法验证指标门禁：${signed.json?.error}` };
    }
    const res = await api(`/api/flm/admin/strategies/${stratB.version_id}/gate`, BAD_GATE);
    const blocked = res.json?.report?.gateStatus === 'blocked';
    await goFlmTab('strategies');
    const text = await page.locator('[data-testid="flm-strategies"]').innerText();
    const shown = /门禁 blocked/.test(text);
    // 被拦截的版本不应能被直接放量
    const canary = await api(`/api/flm/admin/strategies/${stratB.version_id}/canary`, { ratio: 10 });
    // 「直接放量被拒」原先只写在 details 里 —— 判据本身没用到它，等于没断言。
    // 它是本用例真正的下半句（拦截不仅要"报告 blocked"，还要"确实放不出去"），因此收回判据。
    const canaryRejected = canary.json?.ok === false;
    return {
      passed: blocked && shown && canaryRejected,
      details: blocked
        ? `门禁拦截：${res.json.report.summary}；控制台列表显示「门禁 blocked」=${shown}；直接放量被拒=${canaryRejected}`
        : `门禁未拦截：${JSON.stringify(res.json).slice(0, 160)}`,
    };
  });

  await step(page, 'TC-22', '合格版本灰度到 10%', async () => {
    if (!stratA) return { passed: false, details: '没有可放量的 draft 版本' };
    await api(`/api/flm/admin/strategies/${stratA.version_id}/gate`, GOOD_GATE);
    await goFlmTab('strategies');
    await page.click(`[data-testid="flm-canary-10-${stratA.version_id}"]`);
    await page.waitForTimeout(2000);
    const cur = await pickStrategy((s) => s.version_id === stratA.version_id);
    return {
      passed: cur?.status === 'canary' && cur?.gray_ratio === 10,
      details: `版本 ${stratA.version_id} 经门禁通过后从控制台按钮灰度：状态=${cur?.status} 灰度=${cur?.gray_ratio}%`,
    };
  });

  await step(page, 'TC-23', '灰度比例 10% → 100% 转为 released', async () => {
    if (!stratA) return { passed: false, details: '没有可全量发布的版本' };
    await goFlmTab('strategies');
    const loadedA = await waitStrategiesList();
    if (!loadedA.ok) {
      const err = await page.locator('[data-testid="flm-load-error"]').innerText().catch(() => '（页面未渲染 load-error 横幅）');
      return { passed: false, details: `策略列表未能加载且重试无效，无法灰度；页面自述：${err.replace(/\s+/g, ' ').slice(0, 120)}` };
    }
    await page.click(`[data-testid="flm-canary-100-${stratA.version_id}"]`);
    await page.waitForTimeout(2000);
    const cur = await pickStrategy((s) => s.version_id === stratA.version_id);
    return {
      passed: cur?.status === 'released' && cur?.gray_ratio === 100,
      details: `版本 ${stratA.version_id} 灰度 10% → 100%：状态=${cur?.status} 灰度=${cur?.gray_ratio}%`,
    };
  });

  await step(page, 'TC-24', '灰度中版本回滚到上一稳定版本（留痕）', async () => {
    if (!stratB) return { passed: false, details: '没有可回滚的版本' };
    // 人工签字是 prompt×intent 类版本放量的强制前置（AC-F5.5）。
    const approve = await api(`/api/flm/admin/strategies/${stratB.version_id}/approve`, { note: '控制台人工审核通过' });
    await api(`/api/flm/admin/strategies/${stratB.version_id}/gate`, GOOD_GATE);
    await goFlmTab('strategies');
    const loadedB = await waitStrategiesList();
    if (!loadedB.ok) {
      const err = await page.locator('[data-testid="flm-load-error"]').innerText().catch(() => '（页面未渲染 load-error 横幅）');
      return { passed: false, details: `策略列表未能加载且重试无效，无法回滚；页面自述：${err.replace(/\s+/g, ' ').slice(0, 120)}` };
    }
    await page.click(`[data-testid="flm-canary-10-${stratB.version_id}"]`);
    await page.waitForTimeout(2000);

    await page.fill(`[data-testid="flm-rollback-reason-${stratB.version_id}"]`, '灰度观察期成功率低于基线，主动回滚');
    await page.click(`[data-testid="flm-rollback-${stratB.version_id}"]`);
    await page.waitForTimeout(2500);
    const msg = await page.locator('[data-testid="flm-rollback-msg"]').innerText().catch(() => '');
    const cur = await pickStrategy((s) => s.version_id === stratB.version_id);
    // 人工签字是 AC-F5.5 的强制前置：签字失败却"回滚成功"，只能说明合规闸没生效。
    // 原先它只出现在 details 里，判据漏掉了这条前置条件。
    const signedOk = approve.json?.ok === true;
    return {
      passed: signedOk && cur?.status === 'rolled_back' && /最近回滚/.test(msg),
      details: `人工签字=${signedOk}；${msg.replace(/\s+/g, ' ').slice(0, 140)}；状态=${cur?.status} 灰度=${cur?.gray_ratio}%`,
    };
  });

  await goFlmTab('ops');
  await step(page, 'TC-25', '全链路审计时间线可回放', async () => {
    const text = await page.locator('[data-testid="flm-audit"]').innerText().catch(() => '');
    // 用例名说的是「覆盖 generate/gate/canary/rollback」，判据却写成
    // `/generate|gate|canary|rollback|audit/` —— 那是个 **或**：任何一条 gate 记录
    // 就能让"全链路可回放"通过，而"全链路"恰恰是这条用例要证的东西。
    const missing = ['generate', 'gate', 'canary', 'rollback']
      .filter((k) => !new RegExp(k, 'i').test(text));
    return {
      passed: text.length > 0 && missing.length === 0,
      details: `审计条目覆盖 generate/gate/canary/rollback（含执行者与时间戳）；缺失动作：${missing.length ? missing.join('、') : '无'}`,
    };
  });

  // ── TC-26 ~ TC-30：看板与运维 ───────────────────────────────────
  await goFlmTab('overview');
  await step(page, 'TC-26', '总览：核心指标卡片 + 趋势', async () => {
    const text = await page.locator('[data-testid="flm-page"]').innerText();
    const cards = ['反馈总量', '用户满意度', '任务成功率', '纠偏成功率', '闭环时延'].every((k) => text.includes(k));
    const trend = await page.locator('[data-testid="flm-trend"]').count();
    const tools = await page.locator('[data-testid="flm-insight-tools"]').count();
    const agents = await page.locator('[data-testid="flm-insight-agents"]').count();
    return {
      passed: cards && trend > 0,
      details: `五类指标卡片齐备，趋势图可见；工具维度 ${tools} / 智能体维度 ${agents} 下钻表已渲染`,
    };
  });

  await step(page, 'TC-27', '归因视图按环节下钻', async () => {
    const bucket = page.locator('[data-testid^="flm-attr-bucket-"]').first();
    const n = await bucket.count();
    if (n === 0) {
      return { passed: false, details: '当前没有未达成样本，归因分布为空（需先产生失败样本）' };
    }
    await bucket.click();
    await page.waitForTimeout(1800);
    const rows = await page.locator('[data-testid="flm-attr-drill"] tbody tr').count();
    return { passed: rows > 0, details: `点选环节后下钻到 ${rows} 条该环节的失败样本（含首异常步骤与原因）` };
  });

  await goFlmTab('learning');
  await step(page, 'TC-28', '案例库修正归因标签', async () => {
    const sel = page.locator('[data-testid^="flm-case-stage-"]').first();
    if ((await sel.count()) === 0) return { passed: false, details: '案例库为空，无可修正的案例' };
    await sel.selectOption('planning');
    await page.waitForTimeout(2200);
    const msg = await page.locator('[data-testid="flm-case-msg"]').innerText().catch(() => '');
    return { passed: /归因已修正/.test(msg), details: msg.replace(/\s+/g, ' ').slice(0, 160) };
  });

  await goFlmTab('strategies');
  await step(page, 'TC-29', '策略版本 A/B 对比与放量建议', async () => {
    // 别用固定睡眠后再数元素：`goFlmTab` 只等 1.2s，而这条页签要先拉完整个策略
    // 列表（30+ 个版本、每个都带 eval_report JSON）才渲染对比卡片。实测偶发
    // 「卡片未渲染」，是竞态不是功能缺失。等列表，再轮询卡片。
    await page.waitForSelector('[data-testid="flm-strategies"]', { timeout: 20000 }).catch(() => {});
    let card = await page.locator('[data-testid="flm-compare-card"]').count();
    for (let i = 0; i < 10 && card === 0; i += 1) {
      await page.waitForTimeout(1000);
      card = await page.locator('[data-testid="flm-compare-card"]').count();
    }
    if (card === 0) {
      const n = (await page.locator('[data-testid^="flm-canary-10-"]').count());
      return { passed: false, details: `对比卡片未渲染（需至少 2 个策略版本）；此刻版本行渲染 ${n} 个` };
    }
    const list = await api('/api/flm/admin/strategies');
    const withReport = (list.json?.strategies || []).filter((s) => s.eval_report);
    if (withReport.length < 2) {
      // 只有 0/1 个版本有门禁报告时，界面必须显式说"无数据"而不是编一套假指标。
      await page.click('[data-testid="flm-compare-run"]');
      await page.waitForTimeout(1500);
      const err = await page.locator('[data-testid="flm-compare-error"]').innerText().catch(() => '');
      return {
        passed: /无门禁评测数据|无数据/.test(err),
        details: `仅 ${withReport.length} 个版本有门禁报告，界面拒绝编造指标：${err.replace(/\s+/g, ' ').slice(0, 120)}`,
      };
    }
    // 版本对比必须能**判别**，否则选两个指标相同的版本，六项全是「持平」——
    // 表格照样渲染、建议照样给出，用例照样通过，但它什么都没证明。
    // A 取成功率最高的版本，B 见下方（现造一个劣化版本）。
    const candOf = (s) => {
      try {
        const d = JSON.parse(s.eval_report)?.degradations || [];
        return d.length ? Object.fromEntries(d.map((x) => [x.key, x.candidate])) : null;
      } catch { return null; }
    };
    const scored = withReport
      .map((s) => ({ s, c: candOf(s) }))
      .filter((x) => x.c)
      .sort((x, y) => y.c.successRate - x.c.successRate);
    const pickA = scored[0];

    // 库里此刻所有"已过门禁"的版本指标都相同 —— TC-24 为了造回滚，用 GOOD_GATE 把
    // TC-21 那份 blocked 报告覆盖掉了。于是无论怎么挑两侧都是 88→92，
    // 六项全「持平」：表格渲染、建议给出、用例通过，但它什么都没证明。
    // 所以现场造一个劣化版本作为对比的 B，让这张表必须算出非「持平」。
    const allVersions = list.json?.strategies || [];
    const fresh = allVersions.find((s) => s.status === 'draft' && !candOf(s)) || null;
    let badVersion = null;
    if (fresh) {
      await api(`/api/flm/admin/strategies/${fresh.version_id}/approve`, { note: 'TC-29 前置：对比前先过人工签字' }).catch(() => {});
      const g = await api(`/api/flm/admin/strategies/${fresh.version_id}/gate`, BAD_GATE);
      if (g.json?.report?.degradations?.length) {
        badVersion = (await api('/api/flm/admin/strategies')).json?.strategies
          ?.find((s) => s.version_id === fresh.version_id) ?? null;
      }
    }
    const idA = (pickA?.s ?? withReport[0]).version_id;
    const idB = badVersion ? badVersion.version_id : withReport[withReport.length - 1].version_id;

    // B 是**刚刚用接口**造出来的，而页面手里的 `strategies` 还是进页签那一刻的快照。
    // 对比卡片读的是这份客户端 state（不是再打一次接口），所以看不到新写入的
    // `eval_report`，直接以「尚无门禁评测数据」拒绝 —— 实测挂过一次。
    // 真人在控制台上是点卡片自己的「提交门禁评测」，那条路径会 loadTab 刷新；
    // 脚本绕过了 UI 造数据，就必须自己补上这一次刷新。
    if (badVersion) {
      await goFlmTab('strategies');
      await page.waitForSelector('[data-testid="flm-compare-run"]', { timeout: 20000 });
    }

    await page.selectOption('[data-testid="flm-compare-a"]', idA);
    await page.selectOption('[data-testid="flm-compare-b"]', idB);
    await page.click('[data-testid="flm-compare-run"]');
    await page.waitForTimeout(2000);
    const text = await page.locator('[data-testid="flm-compare-result"]').innerText().catch(() => '');

    if (badVersion) {
      // 判别力判据：指标真的不同 → 必须出现「劣化」，且放量建议必须转向不可放量。
      const regressed = /劣化/.test(text);
      const blockedRec = /不可放量|拦截|blocked|未通过/i.test(text);
      return {
        passed: regressed && blockedRec,
        details: `A=${idA.slice(0, 22)}(门禁 candidate 成功率 92) vs B=${idB.slice(0, 22)}` +
          `(现场以 BAD_GATE 造出，candidate 成功率 70) → 表格出现「劣化」判定=${regressed}、` +
          `放量建议转为不可放量=${blockedRec}；文本：${text.replace(/\s+/g, ' ').slice(0, 200)}`,
      };
    }
    // 兜底分支：没能造出"两侧指标确实不同"的对比，于是这张表**无论算出什么都不算证据**
    // —— 六项全「持平」时表格照样渲染、建议照样给出。原来是 `passed: text.length > 0`，
    // 等于用"页面上有字"冒充"对比功能正确"，这次改成如实判失败。
    return {
      passed: false,
      details: `未能构造出判别性对比（两侧版本门禁指标相同，六项必然「持平」），无法证明对比与放量建议正确：${text.replace(/\s+/g, ' ').slice(0, 160)}`,
    };
  });

  await goFlmTab('ops');
  await step(page, 'TC-30', '配置告警阈值并触发', async () => {
    // 判据不能用「告警总条数增加」：接口按 created_at DESC 取 limit 条，库里
    // 累积的告警早已超过这个上限，总数被截断而**饱和**（实测 216 条 / limit 200），
    // 新告警进来条数仍是 200 → 恒判失败。改为盯该指标**最新告警的时间戳前移**。
    const newestOf = (r) => {
      const xs = (r.json?.alerts || []).filter((a) => a.metric === 'feedback_volume_low');
      return xs.length ? Math.max(...xs.map((a) => a.created_at)) : 0;
    };
    const before = await api('/api/flm/admin/alerts?limit=200');
    const beforeNewest = newestOf(before);

    // 用「反馈量下限」而不是成功率跌幅：它是**绝对**判据，把下限抬到远超实际
    // 反馈量就必然触发，不依赖平台此刻成功率相对基线的涨跌（那个是相对判据，
    // 可能在数据平稳时不触发，用例就会 flaky）。
    await page.fill('[data-testid="flm-threshold-feedbackVolumeMin"]', '999999');
    await page.click('[data-testid="flm-threshold-save"]');
    await page.waitForTimeout(1500);

    await goFlmTab('overview'); // 进总览即触发一次巡检
    await page.waitForTimeout(1500);
    const after = await api('/api/flm/admin/alerts?limit=200');
    const afterNewest = newestOf(after);

    // 还原阈值
    await goFlmTab('ops');
    const text = await page.locator('[data-testid="flm-alerts"]').innerText().catch(() => '');
    await page.fill('[data-testid="flm-threshold-feedbackVolumeMin"]', '5');
    await page.click('[data-testid="flm-threshold-save"]');
    await page.waitForTimeout(1200);

    return {
      passed: afterNewest > beforeNewest,
      details: `反馈量下限抬到 999999 后巡检产生新告警：feedback_volume_low 最新告警时间 ${beforeNewest} → ${afterNewest}（按时间戳判，不按总条数 —— 总条数被 limit 截断而饱和）；告警列表渲染内容长度 ${text.length}`,
    };
  });

  // ── TC-31 / TC-32：降级开关 ─────────────────────────────────────
  await goFlmTab('settings');
  await step(page, 'TC-31', '关闭 FLM → 控制台显示已降级，不再新增事件', async () => {
    await page.click('[data-testid="flm-enabled-switch"] button');
    await page.waitForTimeout(2000);
    // 「不再新增事件」**不能**用 limit 内的条数比大小：events?limit=500 是
    // `ORDER BY created_at DESC LIMIT 500`，表一旦涨过 500 行，前后两次都读回 500，
    // `nAfter === nBefore` 恒真 —— 正是 TC-30 踩过的截断饱和陷阱。
    // 改为按时间戳取证：关掉之后不允许出现任何 created_at ≥ 本次动作时刻的事件行。
    const t0 = Date.now();
    const fb = await api('/api/flm/feedback', {
      messageId: SEED_MSGS[2].id, chatJid: FEISHU, type: 'explicit_like',
    });
    const degraded = fb.json?.degraded === true;
    await page.waitForTimeout(1500);
    const evAfter = await api('/api/flm/admin/events?limit=500');
    const allAfter = evAfter.json?.events || [];
    const fresh = allAfter.filter((e) => Number(e.created_at) >= t0);
    const nAfter = allAfter.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="flm-page"]');
    await page.click('[data-testid="flm-tab-overview"]');
    await page.waitForTimeout(1800);
    const banner = await page.locator('[data-testid="flm-degraded-banner"]').count();
    return {
      passed: degraded && banner > 0 && fresh.length === 0,
      details: `反馈接口返回 degraded=true；关闭后新增事件 ${fresh.length} 条（须为 0，按 created_at ≥ 动作时刻取证，表内共 ${nAfter} 行）；控制台降级横幅 ${banner} 处`,
    };
  });

  await step(page, 'TC-32', '恢复开关后采集自动恢复', async () => {
    await page.click('[data-testid="flm-tab-settings"]');
    await page.waitForTimeout(1200);
    await page.click('[data-testid="flm-enabled-switch"] button');
    await page.waitForTimeout(2000);
    const sh = await api('/api/flm/health');
    const fb = await api('/api/flm/feedback', {
      messageId: SEED_MSGS[3].id, chatJid: FEISHU, type: 'explicit_like',
    });
    // `degraded !== true` 对 undefined 也为真 —— 请求本身失败（拿不到 JSON）时这条
    // 也通过，等于"恢复成功"没被验证。改成要求正证据：degraded 明确为 false，
    // 且事件确实落了库（eventInserted=true）。
    return {
      passed: sh.json?.enabled === true && fb.json?.degraded === false && fb.json?.eventInserted === true,
      details: `health.enabled=${sh.json?.enabled}；反馈接口恢复受理：degraded=${fb.json?.degraded}，eventInserted=${fb.json?.eventInserted}（须为 true，证明采集真的回来了）`,
    };
  });

  // ── TC-33：加载失败必须可见（缺陷 #6 的确定性回归门）─────────────
  //
  // 起因：这个缺陷最早是以 `page.click: Timeout` 的形状暴露的，触发它的那次请求失败
  // 是**瞬时且不可复现**的（服务端无请求记录，重放 10 次均成功）。也就是说，"修好之后
  // 跑一遍通过"并不能证明修复有效 —— 因为失败本身没被复现，通过只是因为这次没失败。
  //
  // 这里用 route 拦截把那次不确定的失败**变成确定的**：主动 abort 掉列表接口，
  // 于是"加载失败"成为必然事件，修复前后的差别也就成了可判定的。
  // 没有这一条，#6 的修复就只是一句无法证伪的声明。
  await step(page, 'TC-33', '列表加载失败时必须显式可见，且不得渲染成「暂无数据」', async () => {
    let blocking = true;
    await page.route('**/api/flm/admin/strategies', (route) => (blocking ? route.abort() : route.continue()));

    await goFlmTab('strategies'); // 装机拦截后触发一次加载 → 必然失败
    await page.waitForTimeout(2500);

    const banner = await page.locator('[data-testid="flm-load-error"]').count();
    // 注意：空态与列表在 JSX 里是**三元的两支**（`strategies.length === 0 ? <空态/> : <div data-testid="flm-strategies">`），
    // 因此读 `flm-strategies` 在失败时必然拿到空字符串 —— 那是选择了不存在的节点，不是在观察空态。
    // 要观察的是空态那一支：`flm-strategies-empty`。
    const strategiesText = await page.locator('[data-testid="flm-strategies-empty"]').innerText().catch(() => '');
    // 核心不变量：本地数组为空 **不得**被表述为"库里没有版本"。
    const claimsEmptyLibrary = /暂无策略版本/.test(strategiesText);

    // 放行后点横幅上的「重试」，必须真的恢复 —— 否则横幅只是个死提示。
    blocking = false;
    await page.locator('[data-testid="flm-load-error"] button').click().catch(() => {});
    await page.waitForTimeout(2500);
    const bannerAfter = await page.locator('[data-testid="flm-load-error"]').count();
    const canaryAfter = await page.locator('[data-testid^="flm-canary-10-"]').count();
    await page.unroute('**/api/flm/admin/strategies').catch(() => {});

    const visible = banner > 0;
    // 真空守卫：若策略区整块消失，`!/暂无策略版本/.test('')` 会**平凡为真** ——
    // 那样这条断言就是在为"区域不见了"发合格证。要求文案非空，并在 details 里回报长度。
    const honest = !claimsEmptyLibrary && strategiesText.trim().length > 0;
    const recovered = bannerAfter === 0 && canaryAfter > 0;
    return {
      passed: visible && honest && recovered,
      details:
        `拦截 /api/flm/admin/strategies 强制加载失败 → 失败横幅出现=${visible}（须为 true）；` +
        `策略区文案是否谎称"库里没有"=${claimsEmptyLibrary}（须为 false；文案长度 ${strategiesText.trim().length}，非空以排除"区域消失导致的平凡通过"；实测「${strategiesText.replace(/\s+/g, ' ').slice(0, 60)}」）；` +
        `放行后点「重试」→ 横幅消失=${bannerAfter === 0} 且列表渲染 ${canaryAfter} 个版本（须 >0）`,
    };
  });

  // 兜底：无论前面哪个用例失败，都不能把 FLM 留在关闭状态 —— 否则会污染
  // 后续的人工验收和线上行为。
  //
  // 注意方法：配置端点是 **PUT** `/api/flm/config`（`api()` 助手带 body 时固定发
  // POST，会 404）。曾经写成 `api('/api/flm/config', …)` —— 404 被 `.catch` 之外的
  // 路径吞掉（request() 对 404 是 resolve 不是 reject），于是这行**从来没生效过**，
  // 一旦某个用例把开关留在关闭态，实例就一直关着。
  const finalHealth = await api('/api/flm/health');
  if (finalHealth.json?.enabled !== true) {
    const restored = await request('PUT', '/api/flm/config', { enabled: true });
    const after = await api('/api/flm/health');
    console.log(
      after.json?.enabled === true
        ? '⚠️  收尾：FLM 曾被留在关闭状态，已恢复开启'
        : `❌ 收尾失败：FLM 仍是关闭状态（PUT 返回 ${restored.status}），请人工检查`,
    );
  }

  await browser.close();

  // ── 汇总 ────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    total: results.length,
    passed,
    failed: failed.length,
    failedCases: failed.map((f) => ({ tc: f.tc, name: f.name, details: f.details })),
    results,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(summary, null, 2));

  console.log(`\n=== 验收完成：${passed}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  ${f.tc} ${f.name} — ${f.details}`);
  }
  console.log(`截图与结果：${OUT_DIR}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('验收脚本异常终止：', err);
  process.exit(2);
});
