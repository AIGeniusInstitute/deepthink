// 生产实例 9999 落地复核（一次性的探针，不是可重复的回归用例）。
// 验两件事，都在真实 UI 上、都留截图：
//   A. 「上传文档」按钮点了能弹文件选择框（用户 16:18 报的那个）
//   B. 「重建索引」之后列表上的「已向量化」跟着变（本次修的缺陷）
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DT_BASE || 'http://localhost:9999';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '88888888';
const KB_ID = process.env.DT_KB || '40585997-0346-4468-bd71-8522134f7a1e';
const OUT = process.env.DT_OUT || 'logs/probe-9999';

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => log('   [pageerror]', e.message));

try {
  // ── 登录 ───────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], input#username, input[type="text"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  check('登录成功', true, page.url());

  // ── 打开用户报的那个知识库 ──────────────────────────────
  await page.goto(`${BASE}/knowledge-bases/${KB_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="kb-doc-row"]', { timeout: 30_000 });
  // 默认页签不一定是「文档」，点一下。
  const docTab = page.locator('[data-testid="kb-tab-documents"]');
  if (await docTab.count()) await docTab.click();
  await page.locator('[data-testid="kb-upload-button"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(800);

  const rowsBefore = await page.locator('[data-testid="kb-doc-row"]').allInnerTexts();
  log('\n=== 重建前 · 文档行 ===');
  rowsBefore.forEach((t) => log('  ' + t.replace(/\s+/g, ' ')));
  await page.screenshot({ path: path.join(OUT, '1-before-rebuild.png'), fullPage: true });

  // ── A. 上传按钮真的能弹文件选择框 ───────────────────────
  const uploadBtn = page.locator('[data-testid="kb-upload-button"]');
  await uploadBtn.waitFor({ state: 'visible', timeout: 10_000 });
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
  await uploadBtn.click();
  let chooserFired = false;
  try {
    const chooser = await chooserPromise;
    chooserFired = true;
    // 只验证"框弹出来了"，不真的往生产库传文件。
    await chooser.setFiles([]);
  } catch {
    chooserFired = false;
  }
  check('点「上传文档」弹出文件选择框（真实点击路径）', chooserFired);
  await page.screenshot({ path: path.join(OUT, '2-upload-button.png'), fullPage: true });
  await page.keyboard.press('Escape');

  // ── B. 点「重建索引」，看列表数字是否跟着变 ─────────────
  const rebuildBtn = page.getByRole('button', { name: /重建索引/ });
  await rebuildBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await rebuildBtn.click();
  log('\n等待重建索引完成…');

  // 成功的标志是 toast + 列表重新加载。
  await page
    .locator('text=/索引重建完成/')
    .first()
    .waitFor({ state: 'visible', timeout: 300_000 })
    .catch(() => log('   （没抓到 toast，继续读列表）'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, '3-rebuild-toast.png'), fullPage: true });

  const rowsAfter = await page.locator('[data-testid="kb-doc-row"]').allInnerTexts();
  log('\n=== 重建后 · 文档行 ===');
  rowsAfter.forEach((t) => log('  ' + t.replace(/\s+/g, ' ')));
  await page.screenshot({ path: path.join(OUT, '4-after-rebuild.png'), fullPage: true });

  // 「分块 N · 已向量化 M」两数对齐才算数。
  const parsed = rowsAfter.map((t) => {
    const flat = t.replace(/\s+/g, ' ');
    const chunk = Number(flat.match(/分块\s*(\d+)/)?.[1] ?? -1);
    const emb = Number(flat.match(/已向量化\s*(\d+)/)?.[1] ?? -1);
    return { flat, chunk, emb };
  });
  const allMatch = parsed.length > 0 && parsed.every((p) => p.chunk === p.emb && p.chunk > 0);
  check(
    '列表「已向量化」= 「分块」（缺陷点）',
    allMatch,
    parsed.map((p) => `${p.chunk}/${p.emb}`).join('  '),
  );

  const beforeHadZero = rowsBefore.some((t) => /已向量化\s*0\b/.test(t.replace(/\s+/g, ' ')));
  check('重建前确实显示 0（复现前提）', beforeHadZero);
} catch (err) {
  check('探针异常终止', false, err.message);
  await page.screenshot({ path: path.join(OUT, 'error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.ok).length;
log(`\n${'-'.repeat(50)}\n9999 落地复核：${pass}/${results.length} 通过`);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
process.exit(pass === results.length ? 0 : 1);
