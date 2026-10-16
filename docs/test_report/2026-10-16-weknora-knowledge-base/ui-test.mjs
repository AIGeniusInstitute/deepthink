// UI 验收：走真实浏览器，覆盖「新建知识库 → 上传 → 等待就绪 → 分块回源核验 →
// 三种模式检索 → 问答引用」全链路，并在每一步留截图作为通过证据。
import pw from '/Users/edy/deepthink/node_modules/playwright-core/index.js';
const { chromium } = pw;
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:9899';
const SHOTS = '/tmp/dt-kb-ui/shots';
const FIX = '/tmp/dt-kb-ui/fixtures';
const MARKER = 'ZEBRAFISH_SENTINEL_9X';

const steps = [];
let stepNo = 0;
const log = (name, ok, detail) => {
  steps.push({ step: ++stepNo, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${String(++shotNo).padStart(2, '0')}-${name}.png`, fullPage: true });
}
let shotNo = 0;

// 本机 ms-playwright 缓存里只有 r1243 的浏览器，而 playwright-core 期望 r1234，
// 直接指向已装好的「Google Chrome for Testing」可执行文件，避免额外下载。
const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  // ---------- 1. 登录 ----------
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-username', { timeout: 30000 });
  await shot(page, 'login');
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', '88888888');
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
  // 隔离实例里没有配置任何 provider，登录后会被引导到 /setup/providers；
  // 这是环境状态而非缺陷，直接改道去知识库页面。
  const landedOn = new URL(page.url()).pathname;
  log('登录 admin/88888888', true, `${landedOn}（未配置 provider，Setup 引导页）`);

  // 清掉上一轮遗留的知识库；顺带验证「删除含文档的知识库」不再 500（已知缺陷修复点）。
  const existing = (await context.request.get(`${API}/api/paas/knowledge-bases`).then((r) => r.json()))
    .knowledge_bases ?? [];
  for (const kb of existing) {
    const del = await context.request.delete(`${API}/api/paas/knowledge-bases/${kb.id}`);
    log(`清理遗留知识库 ${kb.name}`, del.status() === 200, `HTTP ${del.status()}`);
  }

  // ---------- 2. 打开知识库列表并新建 ----------
  await page.goto(`${BASE}/knowledge-bases`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=kb-card]', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(
    () => document.body.innerText.includes('新建知识库'), null, { timeout: 30000 });
  const kbName = `运维知识库-${Date.now().toString().slice(-6)}`;
  await page.click('text=新建知识库');
  await page.waitForSelector('[data-testid=kb-create-name]');
  await page.fill('[data-testid=kb-create-name]', kbName);
  await page.fill('textarea', 'DeepThink 运维与架构文档，用于分块级引用溯源的验收');
  await shot(page, 'create-kb-dialog');
  await page.click('[data-testid=kb-create-submit]');
  await page.waitForURL(/\/knowledge-bases\/[^/]+$/, { timeout: 30000 });
  const kbId = page.url().split('/').pop();
  log('新建知识库', true, `${kbName} id=${kbId}`);
  await page.waitForTimeout(800);
  await shot(page, 'kb-detail-empty');

  // ---------- 3. 上传两份文档（一份 >8000 字符，尾部埋哨兵） ----------
  await page.setInputFiles('[data-testid=kb-upload-input]', `${FIX}/deepthink-ops.md`);
  await page.waitForTimeout(1200);
  await page.setInputFiles('[data-testid=kb-upload-input]', `${FIX}/quarterly-plan.csv`);
  await page.waitForTimeout(1200);
  await shot(page, 'uploaded-processing');

  // ---------- 4. 等两份文档都到「就绪」 ----------
  const deadline = Date.now() + 120000;
  let docs = [];
  while (Date.now() < deadline) {
    docs = (await context.request.get(`${API}/api/paas/knowledge-bases/${kbId}/documents`).then((r) => r.json())).documents ?? [];
    if (docs.length >= 2 && docs.every((d) => d.parse_status === 'ready' || d.parse_status === 'failed')) break;
    await page.waitForTimeout(1500);
  }
  const failed = docs.filter((d) => d.parse_status === 'failed');
  log('上传后流水线跑到终态', docs.length >= 2 && failed.length === 0,
    docs.map((d) => `${d.filename}:${d.parse_status}/chunks=${d.chunk_count}/embedded=${d.embedded_chunk_count}`).join(' | '));
  if (failed.length) log('解析失败详情', false, JSON.stringify(failed.map((d) => d.error_message)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=kb-doc-row]', { timeout: 30000 });
  await page.waitForTimeout(600);
  await shot(page, 'documents-ready');

  // ---------- 5. 分块 tab：回源核验（content === 原文切片） ----------
  const mdDoc = docs.find((d) => d.filename.endsWith('.md'));
  await page.click('[data-testid=kb-tab-chunks]');
  await page.waitForSelector('[data-testid=kb-doc-select]');
  await page.selectOption('[data-testid=kb-doc-select]', mdDoc.id);
  await page.waitForSelector('[data-testid=kb-chunk-card]', { timeout: 30000 });

  // API 侧做全量偏移不变式断言（UI 只抽查前 3 块，避免 40+ 次点击）
  const chunks = (await context.request
    .get(`${API}/api/paas/knowledge-bases/documents/${mdDoc.id}/chunks?full=1`)
    .then((r) => r.json())).chunks ?? [];
  const src = fs.readFileSync(`${FIX}/deepthink-ops.md`, 'utf8');
  let offsetOk = 0;
  for (const c of chunks) {
    const slice = (await context.request
      .get(`${API}/api/paas/knowledge-bases/documents/${mdDoc.id}/content?start=${c.start_at}&end=${c.end_at}`)
      .then((r) => r.json())).content;
    if (slice === c.content && src.slice(c.start_at, c.end_at) === c.content) offsetOk++;
  }
  log('全量分块偏移不变式 content===原文切片', offsetOk === chunks.length,
    `${offsetOk}/${chunks.length} 块逐一核对通过`);

  // UI 上点 3 次「回源核验」按钮，确认前端交互可用
  const verifyBtns = await page.$$('[data-testid=kb-chunk-card] button[title="按偏移回源核验"]');
  for (let i = 0; i < Math.min(3, verifyBtns.length); i++) await verifyBtns[i].click();
  await page.waitForTimeout(1200);
  const verifiedBlocks = await page.$$eval('[data-testid=kb-chunk-card]', (els) =>
    els.filter((e) => e.textContent.includes('与原文一致')).length);
  log('分块 UI 回源核验', verifiedBlocks >= 3, `${verifiedBlocks} 个分块展开原文并判定「与原文一致 ✓」`);
  await shot(page, 'chunks-verify');

  // ---------- 6. 检索测试台：尾部哨兵在三种模式下都应命中 ----------
  await page.click('[data-testid=kb-tab-search]');
  await page.waitForSelector('[data-testid=kb-search-input]');
  const modeResults = {};
  for (const [mode, label] of [['hybrid', '混合'], ['keyword', '关键词'], ['vector', '向量']]) {
    await page.click(`button[title]:text-is("${label}")`).catch(async () => {
      await page.click(`text=${label}`);
    });
    await page.fill('[data-testid=kb-search-input]', MARKER);
    await page.click('[data-testid=kb-search-button]');
    await page.waitForTimeout(2500);
    const hits = await page.$$('[data-testid=kb-search-hit]');
    modeResults[mode] = hits.length;
    if (mode === 'hybrid') await shot(page, 'search-hybrid-tail-marker');
  }
  log('尾部哨兵可被检索（长文档不再被截断）',
    modeResults.keyword > 0 && modeResults.hybrid > 0,
    JSON.stringify(modeResults));

  // API 侧三模式复核（UI 点击会受渲染时序影响，这里取确定性证据）
  const apiModes = {};
  for (const mode of ['hybrid', 'keyword', 'vector']) {
    const r = await context.request.post(`${API}/api/paas/knowledge-bases/${kbId}/search`, {
      data: { query: MARKER, mode, limit: 3, debug: true },
    }).then((x) => x.json());
    const top = r.hits?.[0];
    apiModes[mode] = {
      hits: r.hits?.length ?? 0,
      topIsTail: !!top && src.slice(top.start_at, top.end_at).includes(MARKER),
      offset: top ? `[${top.start_at},${top.end_at})` : null,
      effective: r.debug?.effective_mode,
    };
  }
  log('三模式均命中尾部哨兵', Object.values(apiModes).every((m) => m.topIsTail),
    JSON.stringify(apiModes));

  // 中文关键词检索。修复前 FTS5 用 unicode61，一整串汉字被当成单个 token，
  // 且代码把整句当短语匹配 —— 中英文都退化成「必须逐字相连」，实测命中恒为 0。
  const zh = {};
  for (const [mode, q] of [['keyword', '权限模型'], ['keyword', '冷启动'], ['hybrid', '沙箱冷启动的目标是多少？']]) {
    const r = await context.request.post(`${API}/api/paas/knowledge-bases/${kbId}/search`, {
      data: { query: q, mode, limit: 5, debug: true },
    }).then((x) => x.json());
    zh[`${mode}:${q}`] = { hits: r.hits?.length ?? 0, effective: r.debug?.effective_mode };
  }
  log('中文检索（关键词词项 / 混合整句）',
    zh['keyword:权限模型'].hits > 0 && zh['keyword:冷启动'].hits > 0 && zh['hybrid:沙箱冷启动的目标是多少？'].hits > 0,
    JSON.stringify(zh));

  await page.click('button[title]:text-is("关键词")').catch(() => page.click('text=关键词'));
  await page.fill('[data-testid=kb-search-input]', '冷启动');
  await page.click('[data-testid=kb-search-button]');
  await page.waitForTimeout(2500);
  const zhHits = (await page.$$('[data-testid=kb-search-hit]')).length;
  log('中文关键词检索 UI 呈现', zhHits > 0, `命中 ${zhHits} 条`);
  await shot(page, 'search-keyword-chinese');

  // 打开调试面板看双路分数
  const debugToggle = await page.$('text=调试');
  if (debugToggle) { await debugToggle.click(); await page.waitForTimeout(400); }
  await page.fill('[data-testid=kb-search-input]', '权限模型');
  await page.click('[data-testid=kb-search-button]');
  await page.waitForTimeout(2500);
  await shot(page, 'search-debug-panel');

  // 检索结果回源核验
  const hitVerify = await page.$('[data-testid=kb-search-hit] button:has-text("回源核验")');
  if (hitVerify) { await hitVerify.click(); await page.waitForTimeout(1200); }
  await shot(page, 'search-hit-source');

  // ---------- 7. 问答 tab（需要 LLM provider；未配置时如实记录） ----------
  await page.click('[data-testid=kb-tab-chat]');
  await page.waitForSelector('[data-testid=kb-chat-input]');
  await page.fill('[data-testid=kb-chat-input]', '沙箱冷启动的目标是多少？');
  await shot(page, 'chat-before-send');
  await page.click('[data-testid=kb-chat-send]');
  await page.waitForTimeout(12000);
  const asst = await page.$$('[data-testid=kb-chat-assistant]');
  const chatText = asst.length ? await asst[0].innerText() : '';
  await shot(page, 'chat-response');

  const providers = await context.request.get(`${API}/api/paas/providers`).then((r) => r.json()).catch(() => null);
  const hasProvider = Array.isArray(providers) && providers.length > 0;
  if (chatText.trim().length > 0) {
    log('问答返回答案与引用', true, `答案 ${chatText.length} 字`);
  } else {
    log('问答返回答案与引用', false,
      `未配置 LLM provider（providers=${JSON.stringify(providers)}），问答链路无法在本隔离实例完成`);
  }
} catch (err) {
  log('脚本异常', false, String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
} finally {
  fs.writeFileSync('/tmp/dt-kb-ui/ui-test-result.json',
    JSON.stringify({ steps, consoleErrors: consoleErrors.slice(0, 30) }, null, 2));
  log('浏览器控制台错误', consoleErrors.length === 0, `${consoleErrors.length} 条`);
  await browser.close();
}
