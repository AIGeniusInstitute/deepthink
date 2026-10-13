/**
 * 开放平台 AaaS 来源的「展开完整轨迹」取证 + 写入侧截断边界量化。
 *
 * 主脚本（expand-trace.mjs）用的是一条 4518 步的对话运行，截图太大不便入报告；
 * 这里单独取开放平台（用户点名要监控的 agent service）的小轨迹，出一对可读的
 * 折叠/展开对照图，并顺带量清楚：哪些步骤的文本在**写入时**就被截到 500 字符了。
 *
 * 用法：node expand-trace-aaas.mjs http://127.0.0.1:9997 /tmp/rm-e2e/out-aaas
 */
import { chromium } from '/Users/edy/deepthink/.claude/worktrees/feat-agent-runtime-monitor/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:9997';
const OUT = process.argv[3] ?? '/tmp/rm-e2e/out-aaas';
const CHROME =
  '/Users/edy/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const say = (s) => {
  log.push(s);
  console.log(s);
};
function assert(c, m) {
  if (!c) throw new Error(m);
}

function summaryElsInPage() {
  return [...document.querySelectorAll('[data-testid="trace-list"] div')].filter((el) => {
    const t = el.textContent ?? '';
    return (t.startsWith('入参 ') || t.startsWith('出参 ')) && el.children.length === 1;
  });
}
const MEASURE = `(${summaryElsInPage.toString()})().map((el) => ({
  clamp: getComputedStyle(el).webkitLineClamp,
  clientH: el.clientHeight,
  scrollH: el.scrollHeight,
  len: (el.textContent ?? '').length,
}))`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('请输入用户名').fill('admin');
  await page.getByPlaceholder('请输入密码').fill('88888888');
  await page.getByRole('button', { name: /登录/ }).first().click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 25000 });
  await page.goto(`${BASE}/runtime-monitor`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="runs-table"]', { timeout: 25000 });

  // 只看开放平台 AaaS
  await page.getByRole('button', { name: /^开放平台 AaaS/ }).first().click();
  await page.waitForTimeout(1500);

  const rows = page.locator('[data-testid="run-row"]');
  const total = await rows.count();
  assert(total > 0, '开放平台窗口内没有运行');
  say(`开放平台 AaaS 运行 ${total} 条`);

  // 找一条「有文本被裁掉」的
  let pick = null;
  for (let i = 0; i < total; i += 1) {
    const [resp] = await Promise.all([
      page.waitForResponse((r) => /\/api\/runtime-monitor\/runs\/[^/]+$/.test(r.url())),
      rows.nth(i).click(),
    ]);
    const body = await resp.json();
    await page.waitForSelector('[data-testid="trace-list"]', { timeout: 15000 }).catch(() => {});
    const m = await page.evaluate(MEASURE);
    const clipped = m.filter((x) => x.scrollH > x.clientH + 2).length;
    if (clipped > 0) {
      pick = { i, body, m, clipped };
      break;
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="run-detail-panel"]', { state: 'detached' });
  }
  assert(pick, '开放平台没有「文本被裁掉」的运行可取证');

  const maxLen = Math.max(...pick.m.map((x) => x.len));
  say(`样本 ${pick.body.run.runId}：轨迹 ${pick.body.trace.length} 步，被裁 ${pick.clipped} 个元素，最长字段 ${maxLen} 字符`);
  await page.screenshot({ path: path.join(OUT, 'aaas-collapsed.png') });

  await page.locator('[data-testid="trace-expand-toggle"]').click();
  await page.waitForFunction(
    `(() => { const els = (${summaryElsInPage.toString()})();
      return els.length > 0 && els.every((el) => getComputedStyle(el).webkitLineClamp === 'none'); })()`,
    { timeout: 15000 },
  );
  const m2 = await page.evaluate(MEASURE);
  const stillOverflow = m2.filter((x) => x.scrollH > x.clientH + 2).length;
  assert(stillOverflow === 0, `展开后仍有 ${stillOverflow} 个元素视觉溢出`);
  say(`展开后 ${m2.length} 个元素全部 line-clamp:none，溢出 0 个`);
  await page.screenshot({ path: path.join(OUT, 'aaas-expanded.png') });

  // 写入侧上限量化：记录器在 500 字符处截断并补一个省略号（U+2026）
  const capped = [];
  for (const t of pick.body.trace) {
    for (const [f, v] of [
      ['入参', t.inputSummary],
      ['出参', t.outputSummary],
    ]) {
      if (typeof v === 'string' && v.length >= 500) capped.push(`${t.spanId}.${f}=${v.length}`);
    }
  }
  say(
    capped.length
      ? `注意：本样本有 ${capped.length} 个字段在**写入时**已被截到 ${capped.length ? capped[0].split('=')[1] : '?'} 字符（${capped.join(', ')}）——展开只能看到库里存的那 500 字符`
      : '本样本没有触及写入侧 500 字符上限，展开看到的就是完整原文',
  );
  fs.writeFileSync(path.join(OUT, 'result.txt'), `${log.join('\n')}\n`);
  await browser.close();
  process.exit(0);
} catch (e) {
  say(`失败：${e.message}`);
  fs.writeFileSync(path.join(OUT, 'result.txt'), `${log.join('\n')}\n`);
  try {
    await page.screenshot({ path: path.join(OUT, 'z-failed.png') });
  } catch {}
  await browser.close();
  process.exit(1);
}
