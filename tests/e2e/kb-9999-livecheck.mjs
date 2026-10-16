/**
 * 9999 生产实例上线自检（真实点击 + 截图留档）。
 *
 * 目的有二：
 *  1. 复核用户 16:18 报的「进入知识库详情页，点上传文档没反应」在当前产物上是否已消失
 *     —— 走真实点击 + waitForEvent('filechooser')，并且**只读地**打开用户那个库，
 *     不往用户库里写任何东西。
 *  2. 确认 P2 新入口（上传目录 / 手写 Markdown / 整包 zip / 拖拽区）在 9999 上真的可用，
 *     验证动作全部落在本次自检新建的独立库里，避免污染用户数据。
 *
 * 用法：
 *   DT_BASE=http://127.0.0.1:9999 node tests/e2e/kb-9999-livecheck.mjs
 * 可选：DT_USER / DT_PASS / DT_KB（用户那个库的 id）/ DT_OUT
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const BASE = process.env.DT_BASE || 'http://127.0.0.1:9999';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '88888888';
const USER_KB = process.env.DT_KB || '40585997-0346-4468-bd71-8522134f7a1e';
const OUT = process.env.DT_OUT || path.join(REPO, 'logs/e2e-kb-9999-livecheck');
const DIRTREE = path.join(REPO, 'tests/fixtures/dirtree');
const ARCHIVE = path.join(REPO, 'tests/fixtures/office/mixed-archive.zip');

fs.mkdirSync(OUT, { recursive: true });
const results = [];
let seq = 0;
const log = (...a) => console.log(...a);

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => log('   [pageerror]', e.message));

const shot = async (name) => {
  seq += 1;
  const file = path.join(OUT, `${String(seq).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
};

/** 弹框可能是原生 filechooser，也可能是应用内菜单；这里统一处理。 */
async function clickAndCatchChooser(testId, ms = 8000) {
  const waiter = page.waitForEvent('filechooser', { timeout: ms }).catch(() => null);
  await page.locator(`[data-testid="${testId}"]`).click();
  const fc = await waiter;
  if (fc) return { kind: 'native', fc };
  return { kind: 'in-app', fc: null };
}

try {
  // ── 1. 登录 ─────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], input#username, input[type="text"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  check('9999 登录成功', true, page.url());

  // ── 2. 用户报的那个库：只读复核 ─────────────────────────
  await page.goto(`${BASE}/knowledge-bases/${USER_KB}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const onUserKb = page.url().includes(USER_KB);
  check('用户报的库页面可打开', onUserKb, page.url());
  await shot('user-kb-page');

  const uploadBtn = page.locator('[data-testid="kb-upload-button"]');
  const hasBtn = (await uploadBtn.count()) > 0;
  check('详情页存在「上传文档」按钮', hasBtn, `data-testid=kb-upload-button ×${await uploadBtn.count()}`);

  if (hasBtn) {
    const r = await clickAndCatchChooser('kb-upload-button');
    if (r.kind === 'native') {
      // 关键：弹的是原生文件选择框，说明「点了有反应」——而不是只弹了个菜单
      const multiple = await r.fc.element().getAttribute('multiple');
      check(
        '点「上传文档」弹出文件选择框（16:18 缺陷复核）',
        true,
        `原生 filechooser 已弹出，multiple=${multiple !== null}`,
      );
      await shot('user-kb-upload-clicked');
    } else {
      const panelVisible = await page
        .locator('[data-testid="kb-upload-panel"], [data-testid="kb-upload-menu"], [role="dialog"]')
        .first()
        .isVisible()
        .catch(() => false);
      check(
        '点「上传文档」有可见反应（非原生框，走应用内面板）',
        panelVisible,
        panelVisible ? '面板已展开' : '点了之后没看到任何可见变化',
      );
      await shot('user-kb-upload-clicked');
      // 面板里应该还能再点出原生框（"选择文件"）
      const inner = await page
        .locator('[data-testid="kb-upload-pick-file"]')
        .count()
        .catch(() => 0);
      if (inner > 0) {
        const r2 = await clickAndCatchChooser('kb-upload-pick-file');
        check('面板内「选择文件」能弹出原生框', r2.kind === 'native');
      }
    }
    // 关掉可能残留的弹框，免得影响后续
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // ── 3. 自检库：P2 全流程（不碰用户库的数据） ─────────────
  const kbName = `上线自检 ${new Date().toISOString().slice(11, 19)}`;
  const kbId = await page.evaluate(async (name) => {
    const r = await fetch('/api/paas/knowledge-bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, description: '上线自检，可删' }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.knowledge_base?.id ?? j?.id ?? null;
  }, kbName);
  check('新建自检库', !!kbId, `kb=${kbId}`);

  if (kbId) {
    await page.goto(`${BASE}/knowledge-bases/${kbId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    // 3a. 手写 Markdown 入口（P2 新增）
    const textEntry = page.locator('[data-testid="kb-upload-text-button"]');
    check('P2「手写 Markdown」入口存在', (await textEntry.count()) > 0);
    if ((await textEntry.count()) > 0) {
      await textEntry.click();
      await page.waitForTimeout(600);
      await page.fill('[data-testid="kb-text-title"]', `自检手写 ${Date.now()}`);
      await page.fill('[data-testid="kb-text-body"]', '# 结论\n\nLIVECHECK-3311 上线自检正文。');
      await page.click('[data-testid="kb-text-save"]');
      await page.waitForTimeout(4000);
      const rows = await page.locator('[data-testid="kb-doc-row"]').allInnerTexts();
      check('手写文档入库', rows.some((t) => t.includes('自检手写')), `列表 ${rows.length} 行`);
      await shot('selfcheck-text-ingested');
      // 关弹框（该弹框只响应背景点击，Escape 无效）
      await page.mouse.click(20, 20).catch(() => {});
      await page.waitForTimeout(500);
    }

    // 3b. 上传目录入口 + webkitdirectory 属性（切页签后仍在）
    const dirInput = page.locator('[data-testid="kb-upload-dir-input"]');
    check('「上传目录」input 存在', (await dirInput.count()) > 0);
    if ((await dirInput.count()) > 0) {
      const before = await dirInput.evaluate((el) => el.hasAttribute('webkitdirectory'));
      check('webkitdirectory 属性存在（首屏）', before);
    }

    // 3c. 整包 zip —— 走的是普通上传框（前端按 .zip 后缀转发到整包端点）
    const fileInput = page.locator('[data-testid="kb-upload-input"]');
    await fileInput.setInputFiles(ARCHIVE);
    await page.waitForTimeout(8000);
    const txt = await page.locator('body').innerText();
    check(
      '整包 zip 上传有回执',
      /解包后|入库\s*\d/.test(txt),
      txt.match(/解包后[^\n]*/)?.[0] ?? txt.match(/上传进度[^\n]*/)?.[0] ?? '',
    );
    await shot('selfcheck-archive');

    // 3d. 目录上传（真实选目录）
    if ((await dirInput.count()) > 0) {
      const tryDir = async () => {
        const waiter = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
        await page.locator('[data-testid="kb-upload-dir-button"]').click().catch(() => {});
        const fc = await waiter;
        if (fc) {
          await fc.setFiles(DIRTREE);
          return true;
        }
        return false;
      };
      const opened = await tryDir();
      if (opened) {
        await page.waitForTimeout(6000);
        await shot('selfcheck-dir-upload');
        const rows = await page.locator('[data-testid="kb-doc-row"]').allInnerTexts();
        const flat = rows.join('\n');
        check('目录上传入库（含相对路径）', /dirtree|visit\.md|readme\.txt/.test(flat), `${rows.length} 行`);
        check('隐藏项未入库', !/\.draft\.md|skipme\.md|\.cache/.test(flat));
      } else {
        check('「上传目录」能弹出选择框', false, '按钮未弹出 filechooser');
      }
    }

    // 3e. 切到「检索测试台」再切回来，验 webkitdirectory 仍在（P2 修的那个静默失效），
    //     顺便在检索台里查一次（同时验 9999 的向量模型仍在线）
    const searchTab = page.getByText('检索测试台', { exact: false }).first();
    if ((await searchTab.count()) > 0) {
      await searchTab.click().catch(() => {});
      await page.waitForTimeout(800);
      const box = page.locator('[data-testid="kb-search-input"]');
      if ((await box.count()) > 0) {
        await box.fill('LIVECHECK-3311 结论是什么');
        await page.click('[data-testid="kb-search-button"]');
        await page.waitForTimeout(6000);
        const hits = await page.locator('[data-testid="kb-search-hit"]').count();
        check('检索命中自检文档', hits > 0, `${hits} 条命中`);
        await shot('selfcheck-search');
      } else {
        check('检索测试台输入框存在', false);
      }
      // 切回文档页签
      await page.getByText('文档', { exact: false }).first().click().catch(() => {});
      await page.waitForTimeout(1200);
      const dirAfter = page.locator('[data-testid="kb-upload-dir-input"]');
      if ((await dirAfter.count()) > 0) {
        const attr = await dirAfter.evaluate((el) => el.hasAttribute('webkitdirectory'));
        check('切页签回来后 webkitdirectory 仍在', attr);
        await shot('selfcheck-back-to-documents');
      } else {
        check('切回文档页签后上传区仍在', false);
      }
    } else {
      check('检索测试台页签存在', false);
    }
  }

  const finalUrl = page.url();
  await shot('final');
  log(`\n最终页面：${finalUrl}`);
} catch (err) {
  log('❌ 脚本异常：', err?.stack || err);
  await shot('fatal');
  check('脚本无异常', false, String(err?.message || err));
} finally {
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ base: BASE, total: results.length, passed, results }, null, 2),
  );
  log(`\n===== ${passed}/${results.length} =====`);
  log(`截图与结果：${OUT}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
}
