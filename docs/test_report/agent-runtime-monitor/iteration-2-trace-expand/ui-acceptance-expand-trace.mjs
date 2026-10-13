/**
 * 运行详情 · 运行轨迹「展开完整轨迹」UI 验收（真实浏览器，Playwright）。
 *
 * 同一个脚本按 BASE 参数跑两个实例，构成 A/B 判别：
 *   - 旧代码（生产 :9999）：应在「展开按钮存在」这一步红 —— 证明脚本有区分度；
 *   - 新代码（隔离 :9997）：全绿。
 *
 * 用法：node expand-trace.mjs http://127.0.0.1:9997 /tmp/rm-e2e/out-9997
 */
// 脚本住在 /tmp（不污染仓库），node_modules 在仓库里，所以按绝对路径解析。
import { chromium } from '/Users/edy/deepthink/.claude/worktrees/feat-agent-runtime-monitor/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:9997';
const OUT = process.argv[3] ?? '/tmp/rm-e2e/out';
const CHROME =
  '/Users/edy/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

fs.mkdirSync(OUT, { recursive: true });

const steps = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    steps.push({ step: name, ok: true, detail: detail ?? '' });
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
    return detail;
  } catch (e) {
    steps.push({ step: name, ok: false, detail: e.message });
    console.log(`❌ ${name} — ${e.message}`);
    throw e;
  }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
// 关掉 Service Worker：该站是 PWA，SW 会 precache 旧 JS 包，造成「rebuild 后还是老代码」的假阴性。
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();

/**
 * 入参/出参元素的**结构选择器**（而不是 data-testid）。
 *
 * 必须这样选：data-testid 是本次改动新加的，旧代码上没有 —— 用它选就没法在旧代码上
 * 量出「截断省略」这个现象，A/B 也就退化成「选择器找不到元素」这种没有信息量的红。
 * 结构特征是稳定的：轨迹列表内、只有一个子元素（"入参 "/"出参 " 标签 span）、
 * 文本以这两个词开头。
 */
function summaryElsInPage() {
  return [...document.querySelectorAll('[data-testid="trace-list"] div')].filter((el) => {
    const t = el.textContent ?? '';
    return (t.startsWith('入参 ') || t.startsWith('出参 ')) && el.children.length === 1;
  });
}

/** 量一遍轨迹里所有入参/出参元素的「是否被视觉裁切」。 */
async function measure() {
  return page.evaluate(`(${summaryElsInPage.toString()})().map((el) => ({
    clamp: getComputedStyle(el).webkitLineClamp,
    clientH: el.clientHeight,
    scrollH: el.scrollHeight,
    len: (el.textContent ?? '').length,
  }))`);
}

/** 取这些元素的 textContent（用于与后端 payload 逐字对账）。 */
async function summaryTexts() {
  return page.evaluate(`(${summaryElsInPage.toString()})().map((el) => el.textContent ?? '')`);
}
const clampedCount = (m) => m.filter((x) => x.clamp === '3').length;
const hiddenPx = (m) => m.filter((x) => x.scrollH > x.clientH).reduce((s, x) => s + (x.scrollH - x.clientH), 0);
/**
 * 「真的被裁掉了」—— 必须视觉溢出，光有 line-clamp:3 不算：
 * 文本本来就不到 3 行时 clamp 属性照样是 3，但一个字都没被隐藏。
 * 拿这种行做验收等于什么都没验（第一版脚本就踩了这个坑）。
 */
const reallyClipped = (m) => m.filter((x) => x.scrollH > x.clientH + 2);

const TOGGLE = '[data-testid="trace-expand-toggle"]';
const PANEL = '[data-testid="run-detail-panel"]';

/** 点第 i 行、拿到该次运行的详情 payload 与 runId。 */
async function openRow(i) {
  const rows = page.locator('[data-testid="run-row"]');
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/runtime-monitor\/runs\/[^/]+$/.test(r.url()) && r.request().method() === 'GET',
      { timeout: 15000 },
    ),
    rows.nth(i).click(),
  ]);
  const body = await resp.json();
  await page.waitForSelector(PANEL);
  // 轨迹要么有列表要么有说明，二者出现其一即视为加载完成
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="trace-list"]') !== null ||
      /没有可展示|没有节点级记录|没有记录到步骤|尚未产生检查决策|原子运行记录/.test(
        document.body.innerText,
      ),
    { timeout: 15000 },
  );
  return body;
}
async function closePanel() {
  await page.keyboard.press('Escape');
  await page.waitForSelector(PANEL, { state: 'detached', timeout: 10000 });
}

try {
  await step('管理员登录', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('请输入用户名').fill('admin');
    await page.getByPlaceholder('请输入密码').fill('88888888');
    await page.getByRole('button', { name: /登录/ }).first().click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 25000 });
    return `落地 ${new URL(page.url()).pathname}`;
  });

  await step('打开运行监控页', async () => {
    await page.goto(`${BASE}/runtime-monitor`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="runs-table"]', { timeout: 25000 });
    const n = await page.locator('[data-testid="run-row"]').count();
    assert(n > 0, '运行列表为空，无法验收');
    return `运行列表 ${n} 行`;
  });

  /** 遍历当前视图的每一行，收集「确有文本被视觉裁掉」的候选。 */
  async function scanClipped(limit) {
    const rows = page.locator('[data-testid="run-row"]');
    const total = Math.min(await rows.count(), limit);
    const found = [];
    for (let i = 0; i < total; i += 1) {
      const body = await openRow(i);
      const m = await measure();
      if (reallyClipped(m).length > 0) {
        found.push({
          index: i,
          runId: body.run.runId,
          body,
          measure: m,
          maxLen: Math.max(...m.map((x) => x.len)),
          hidden: hiddenPx(m),
        });
      }
      await closePanel();
    }
    return found;
  }

  // ── 取「被裁掉的最长字段」那条运行作为样本，而不是第一条碰上的 ─────────────
  let target = null;
  await step('遍历运行列表，定位被视觉裁切的轨迹（复现「截断省略」）', async () => {
    const found = await scanClipped(20);
    assert(found.length > 0, '遍历运行列表后未找到「文本被视觉裁掉」的轨迹，无法验收');
    target = found.reduce((a, b) => (b.maxLen > a.maxLen ? b : a));
    const worst = found.reduce((a, b) => (b.hidden > a.hidden ? b : a));
    return `${found.length}/20 条运行存在视觉裁切；取最长字段（${target.maxLen} 字符）那条；最大隐藏量 ${worst.hidden}px`;
  });

  assert(target, '未定位到目标运行');

  await step('重新打开目标运行并确认未串行（runId 稳定）', async () => {
    const body = await openRow(target.index);
    assert(body.run.runId === target.runId, `列表在扫描期间发生位移：${body.run.runId} ≠ ${target.runId}`);
    target.body = body;
    target.measure = await measure();
    assert(reallyClipped(target.measure).length > 0, '重开后该运行不再存在视觉裁切');
    return `${target.runId}：轨迹 ${body.trace.length} 步，被裁 ${reallyClipped(target.measure).length} 个元素，共隐藏 ${hiddenPx(target.measure)}px`;
  });

  await step('折叠态截图（现象留存）', async () => {
    await page.screenshot({ path: path.join(OUT, 'a-collapsed.png') });
    await page.locator('[data-testid="trace-list"]').screenshot({ path: path.join(OUT, 'b-collapsed-trace.png') });
    return `隐藏 ${hiddenPx(target.measure)}px`;
  });

  await step('展开按钮存在（新能力 —— 旧代码此处必红）', async () => {
    // 先按**用户可见的文案**找，再校验自动化钩子：只断言 data-testid 存在的话，
    // 旧代码的红是「选择器找不到」这种没有信息量的红，证明不了用户看不到入口。
    const visible = page.locator('button').filter({ hasText: /展开完整轨迹/ });
    const vCount = await visible.count();
    assert(vCount >= 1, '轨迹区没有「展开完整轨迹」按钮（旧代码即此状态，用户无路可走）');
    const toggle = page.locator(TOGGLE);
    assert((await toggle.count()) === 1, '按钮可见但缺少 data-testid=trace-expand-toggle，自动化钩子缺失');
    const label = (await toggle.innerText()).trim();
    assert(label.includes('展开'), `按钮文案异常：${label}`);
    return `可见按钮 ${vCount} 个，文案「${label}」`;
  });

  await step('点击展开：全部入参/出参不再被裁切', async () => {
    await page.locator(TOGGLE).click();
    await page.waitForFunction(
      `(() => { const els = (${summaryElsInPage.toString()})();
        return els.length > 0 && els.every((el) => getComputedStyle(el).webkitLineClamp === 'none'); })()`,
      { timeout: 20000 },
    );
    const m = await measure();
    assert(m.length > 0, '展开后一个入参/出参元素都没有');
    assert(clampedCount(m) === 0, `仍有 ${clampedCount(m)} 个元素处于 line-clamp`);
    const overflow = m.filter((x) => x.scrollH > x.clientH + 2);
    assert(overflow.length === 0, `仍有 ${overflow.length} 个元素视觉溢出（scrollH>clientH+2）`);
    // 直接证据：折叠时被裁的那些元素，展开后可视高度必须真的长大
    assert(m.length === target.measure.length, '展开前后元素数量不一致，索引对不上');
    const grew = m.filter((x, i) => x.clientH > target.measure[i].clientH + 2).length;
    const wasClipped = reallyClipped(target.measure).length;
    assert(grew >= wasClipped, `折叠时被裁 ${wasClipped} 个元素，展开后只有 ${grew} 个可视高度变大`);
    return `${m.length} 个元素全部 line-clamp:none，溢出 0 个；${grew} 个可视高度变大（原被裁 ${wasClipped} 个，共隐藏 ${hiddenPx(target.measure)}px）`;
  });

  await step('展开态内容与后端 payload 逐字对账', async () => {
    const dom = await summaryTexts();
    const missing = [];
    let checked = 0;
    for (const t of target.body.trace) {
      for (const [field, value] of [
        ['inputSummary', t.inputSummary],
        ['outputSummary', t.outputSummary],
      ]) {
        if (!value) continue;
        checked += 1;
        if (!dom.some((d) => d.endsWith(value))) missing.push(`${t.spanId}.${field}`);
      }
    }
    assert(missing.length === 0, `DOM 中找不到完整原文的字段：${missing.join(', ')}`);
    const longest = target.body.trace.reduce(
      (a, t) => Math.max(a, (t.inputSummary ?? '').length, (t.outputSummary ?? '').length),
      0,
    );
    return `${checked} 个非空字段全部在 DOM 中逐字出现（最长 ${longest} 字符）`;
  });

  await step('展开态截图', async () => {
    await page.screenshot({ path: path.join(OUT, 'c-expanded.png') });
    await page.locator('[data-testid="trace-list"]').screenshot({ path: path.join(OUT, 'd-expanded-trace.png') });
    return '已截图';
  });

  await step('再点一次收起：回到 line-clamp:3', async () => {
    await page.locator(TOGGLE).click();
    await page.waitForFunction(
      `(() => { const els = (${summaryElsInPage.toString()})();
        return els.length > 0 && els.every((el) => getComputedStyle(el).webkitLineClamp === '3'); })()`,
      { timeout: 20000 },
    );
    const m = await measure();
    return `${m.length} 个元素全部回到 line-clamp:3（可逆）`;
  });

  await step('切换到另一条运行：自动回到折叠态', async () => {
    await closePanel();
    const rows = page.locator('[data-testid="run-row"]');
    await openRow(rows.count() > 1 ? 1 : 0);
    const toggle = page.locator(TOGGLE);
    if ((await toggle.count()) === 1) {
      assert((await toggle.innerText()).includes('展开'), '新开一条运行仍处于展开态（展开态未随运行切换重置）');
    }
    const m = await measure();
    const bad = m.filter((x) => x.clamp !== '3');
    assert(bad.length === 0, `切回后仍有 ${bad.length} 个元素未处于折叠态`);
    await page.screenshot({ path: path.join(OUT, 'e-switch-run-collapsed.png') });
    return '已重置为折叠态';
  });

  await step('原子来源（无入参/出参）不渲染死按钮', async () => {
    await closePanel();
    // 定时任务 / 沙箱 / Harness 评测是一次运行一条原子记录，成功时入参出参都为空。
    const chips = ['定时任务', '沙箱', 'Harness 评测'];
    let examined = 0;
    let emptyViews = [];
    for (const label of chips) {
      const chip = page.getByRole('button', { name: new RegExp(`^${label}`) });
      if ((await chip.count()) === 0) {
        emptyViews.push(`${label}(无此 chip)`);
        continue;
      }
      await chip.first().click();
      await page.waitForTimeout(1200);
      const rows = page.locator('[data-testid="run-row"]');
      const n = Math.min(await rows.count(), 8);
      if (n === 0) emptyViews.push(`${label}(窗口内 0 条)`);
      for (let i = 0; i < n; i += 1) {
        const body = await openRow(i);
        examined += 1;
        const hasSummary = body.trace.some((t) => t.inputSummary || t.outputSummary);
        const toggleCount = await page.locator(TOGGLE).count();
        await page.screenshot({ path: path.join(OUT, `f-atomic-${label}-${i}.png`) });
        await closePanel();
        if (!hasSummary) {
          assert(toggleCount === 0, `${label} 无入参/出参却渲染了展开按钮`);
          await chip.first().click(); // 取消筛选
          return `${label}：无摘要运行未渲染按钮（共检查 ${examined} 条）`;
        }
      }
      await chip.first().click(); // 取消筛选，试下一个来源
      await page.waitForTimeout(500);
    }
    return `SKIP：${chips.join('/')} 共检查 ${examined} 条运行，全部带摘要，无「成功且无入参出参」样本可验。${emptyViews.length ? `（空来源：${emptyViews.join('、')}）` : ''}`;
  });

  console.log('\n全部通过');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ base: BASE, steps }, null, 2));
  await browser.close();
  process.exit(0);
} catch (e) {
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ base: BASE, steps, failed: e.message }, null, 2),
  );
  try {
    await page.screenshot({ path: path.join(OUT, 'z-failed.png') });
  } catch {}
  console.log(`\n失败：${e.message}`);
  await browser.close();
  process.exit(1);
}
