/**
 * 定向探查：「学习沉淀」页签为什么看不到案例库 / 检索无命中。
 *
 * 背景：验收脚本 TC-17（案例检索）报「无命中」、TC-28（案例库修正归因）报「案例库为空」，
 * 但同一时刻后端 `/api/flm/admin/cases` 稳定返回 200 行（480KB）、
 * `/api/flm/admin/cases/search?q=使用手册 提交 push` 稳定返回 5 条命中。
 * 也就是说证据都指向"页面上那块区域没渲染出来"，需要区分三种可能：
 *   (a) 接口没被调用 / 调用失败      → 看网络记录
 *   (b) 调用了但页面崩了             → 看 PAGE ERROR 与 flm-page 根节点是否还在
 *   (c) 调用了、也没崩，只是渲染慢   → 看等待时间轴
 *
 * 只读探查：不改数据库、不改配置，只发 GET/查询类请求。
 *
 * 用法：node scripts/e2e/probe-learning-tab.cjs
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:9999';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve(__dirname, '../../output/probe-learning-tab');
fs.mkdirSync(OUT, { recursive: true });

const USER = 'admin';
const PASS = '88888888';

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const ck = raw.filter(Boolean).map((s) => s.split(';')[0]).join('; ');
  if (!cookie0(ck)) throw new Error('登录未拿到 cookie');
  return ck;
}
const cookie0 = (s) => /deepthink_session=/.test(s);

(async () => {
  const cookie = await login();
  const [name, value] = cookie.split('=');

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name, value, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();

  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const net = [];
  const errors = [];

  page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes('/api/flm/')) return;
    let n = '';
    try {
      const b = await r.body();
      n = `${b.length}B`;
    } catch { n = 'body?'; }
    net.push(`${stamp()} ${r.status()} ${r.request().method()} ${u.replace(BASE, '')} ${n}`);
  });
  page.on('requestfailed', (r) => {
    net.push(`${stamp()} FAILED ${r.method()} ${r.url().replace(BASE, '')} — ${r.failure()?.errorText}`);
  });
  page.on('pageerror', (e) => errors.push(`${stamp()} PAGE ERROR: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${stamp()} console.error: ${m.text().slice(0, 200)}`);
  });

  console.log('=== 打开 /feedback-learning ===');
  await page.goto(`${BASE}/feedback-learning`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="flm-page"]', { timeout: 30000 });
  console.log(`${stamp()} flm-page 出现`);

  console.log('=== 点「学习沉淀」页签 ===');
  await page.click('[data-testid="flm-tab-learning"]');

  // 时间轴：每 1s 采一次「案例库」区域的状态，看它是"一直空"还是"慢慢长出来"。
  const timeline = [];
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(1000);
    const snap = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      const txt = (s) => document.querySelector(s)?.innerText?.slice(0, 60) ?? null;
      return {
        flmPage: q('[data-testid="flm-page"]'),
        casesBox: q('[data-testid="flm-cases"]'),
        caseRows: q('[data-testid="flm-cases"] > div'),
        queryInput: q('[data-testid="flm-case-query"]'),
        learnRunBtn: q('[data-testid="flm-run-learn"]'),
        knowledgeBox: q('[data-testid="flm-knowledge"]'),
        bodyLen: document.body.innerText.length,
        casesHint: txt('[data-testid="flm-cases"]'),
      };
    });
    timeline.push(`${stamp()} ${JSON.stringify(snap)}`);
    if (snap.caseRows > 0 && snap.queryInput > 0) break;
  }

  console.log('=== 时间轴 ===');
  timeline.forEach((l) => console.log('  ' + l));

  console.log('=== 执行一次检索（与 TC-17 同参）===');
  let searchState = 'queryInput 不存在，无法检索';
  if ((await page.locator('[data-testid="flm-case-query"]').count()) > 0) {
    await page.fill('[data-testid="flm-case-query"]', '使用手册 提交 push');
    await page.click('[data-testid="flm-case-search"]');
    const marks = [];
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(1000);
      const n = await page.locator('[data-testid="flm-case-hits"]').count();
      marks.push(`${i + 1}s:${n}`);
      if (n > 0) break;
    }
    searchState = `flm-case-hits 出现情况 ${marks.join(' ')}`;
  }
  console.log('  ' + searchState);

  await page.screenshot({ path: path.join(OUT, 'learning-tab.png'), fullPage: true });

  console.log('=== 页面错误 ===');
  if (!errors.length) console.log('  （无）');
  errors.forEach((e) => console.log('  ' + e));

  console.log('=== /api/flm/ 网络记录 ===');
  net.forEach((l) => console.log('  ' + l));

  await browser.close();

  fs.writeFileSync(
    path.join(OUT, 'probe.json'),
    JSON.stringify({ timeline, searchState, errors, net, at: new Date().toISOString() }, null, 2),
  );
  console.log(`\n产物：${OUT}`);
})().catch((e) => {
  console.error('探查失败：', e);
  process.exit(1);
});
