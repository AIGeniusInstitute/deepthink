/**
 * PDF 上传的真实 UI 验收（手工驱动，需要已跑起来的实例）。
 *
 * 这个脚本是为线上回归而写的：用户上传 PDF 报 `pdfParse is not a function`，
 * 修完之后必须**用他那个真实文件、走真实入口**再验一遍 —— 而不是拿单测的结论
 * 去代理。三件事必须一起成立，缺一条都算没修好：
 *
 *   1. 点「上传文档」真的能唤起文件选择框（曾经被 <label> 吞掉过，别再退回去）
 *   2. 真实 PDF 不再抛 `pdfParse is not a function`（崩溃已修）
 *   3. 无文字层的扫描件必须**明确报错**，且**不得**在文档列表里留下一份
 *      "看起来已就绪"的噪声文档 —— 这正是 pageJoiner 缺陷的后果：
 *      pdf-parse 默认会给每页伪造一条 `-- n of N --`，扫描件本该抽出空串，
 *      被这么一加就成了非空文本，空值守卫失效，纯噪声被静默入库。
 *      所以断言不能只写"报错了"，还要写"列表没多出东西"。
 *
 * 同时做一组**正向对照**：在临时知识库里传一份有文字层的真 PDF，必须解析成功、
 * 切出分块。否则"扫描件报错"这条断言在解析器彻底坏掉时也会通过 —— 那就成了
 * 测了个寂寞。
 *
 * 用法：
 *   make start-prod PORT=9999
 *   DT_BASE=http://localhost:9999 DT_USER=admin DT_PASS='xxx' \
 *   DT_PDF="/path/to/real.pdf" DT_KB=<知识库 id> \
 *     node tests/e2e/kb-pdf-upload.mjs
 *
 * 浏览器：用本机已安装的 Google Chrome（channel: 'chrome'），不下载 Playwright 自带内核。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const BASE = process.env.DT_BASE || 'http://127.0.0.1:9999';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '';
const KB_ID = process.env.DT_KB || '';
const REAL_PDF = process.env.DT_PDF || '';
const CTRL_PDF = process.env.DT_CTRL_PDF || path.join(REPO, 'tests', 'fixtures', 'pdf', 'text-layer.pdf');
const OUT_DIR = process.env.DT_OUT || path.join(REPO, 'logs', 'kb-pdf-upload');

if (!PASS) {
  console.error('❌ 需要 DT_PASS=<password>');
  process.exit(1);
}
if (!KB_ID) {
  console.error('❌ 需要 DT_KB=<知识库 id>');
  process.exit(1);
}
if (!REAL_PDF || !fs.existsSync(REAL_PDF)) {
  console.error(`❌ 需要 DT_PDF=<真实 PDF 路径>，当前: ${REAL_PDF || '(空)'}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(msg) {
  console.log(`ℹ️  ${msg}`);
}

/**
 * 读界面上**所有**还在显示的 toast（sonner 是堆叠的），返回数组。
 *
 * ⚠️ 不能只取 `querySelector('[data-sonner-toast]')` 的第一个：它可能是一条几分钟前
 *    遗留的提示（"已恢复连接" 之类），于是断言读到的是旧消息、新消息被漏掉 ——
 *    这个脚本第一版就是这么误报的。要断言某句话出现过，就在全部 toast 里找。
 */
async function allToasts(page) {
  return page.$$eval('[data-sonner-toast]', (els) => els.map((e) => e.textContent.trim()));
}

/** 等出现一条匹配 `re` 的 toast，返回当时全部 toast 的文本（用 ' | ' 连接）。 */
async function waitToast(page, re, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    last = await allToasts(page);
    if (last.some((t) => re.test(t))) break;
    await page.waitForTimeout(300);
  }
  return last.join(' | ');
}

/** 文档列表里每一行的文件名 + 状态，用来断言"没有多出东西"。 */
async function docRows(page) {
  return page.$$eval('[data-testid="kb-doc-row"]', (rows) =>
    rows.map((r) => ({
      filename: r.querySelector('div > div')?.textContent?.trim() ?? '',
      status: r.querySelector('[data-testid="kb-doc-status"]')?.textContent?.trim() ?? '',
      raw: r.textContent.trim(),
    })),
  );
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`   [browser error] ${m.text()}`);
});

// 抓上传接口的真实响应体：界面上是一句 toast，但"服务端到底回了什么"才是硬证据，
// 报告里可以直接贴。留最后一次即可（对照场景那条）。
let lastUploadResp = null;
page.on('response', (res) => {
  try {
    const u = new URL(res.url());
    if (res.request().method() === 'POST' && /\/documents$/.test(u.pathname)) {
      void res
        .text()
        .then((body) => {
          lastUploadResp = { status: res.status(), url: res.url(), body: body.slice(0, 500) };
        })
        .catch(() => {});
    }
  } catch {
    /* 忽略无法解析的 URL */
  }
});

try {
  // ── 登录 ──────────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="text"], input[name="username"]').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole('button', { name: /登录/ }).click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  check('登录成功', true, page.url());

  // ── 场景一：真实 PDF 走真实入口 ────────────────────────────────────
  await page.goto(`${BASE}/knowledge-bases/${KB_ID}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });
  const before = await docRows(page);
  info(`上传前该库文档数：${before.length}`);
  const sizeMiB = (fs.statSync(REAL_PDF).size / 1024 / 1024).toFixed(1);
  info(`真实文件：${path.basename(REAL_PDF)}（${sizeMiB} MiB）`);
  await page.screenshot({ path: path.join(OUT_DIR, '10-real-pdf-before.png') });

  // 必须点按钮，不能用 setInputFiles 直接给 input 赋值 —— 那条路绕过了
  //「点击 → 转发 → 弹框」这一跳，而这跳曾经真的坏过（label 吞点击）。
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
  await page.getByTestId('kb-upload-button').click();
  const chooser = await chooserPromise.catch(() => null);
  check('点「上传文档」能唤起文件选择框', chooser !== null);
  if (!chooser) throw new Error('上传按钮点不动：filechooser 未触发');

  await chooser.setFiles(REAL_PDF);
  // 等"这次上传的结论"出现：成功、无文字层、或其它任何错误都算有结论。
  const t1 = await waitToast(page, /已上传|no extractable text|失败|too large|Unsupported/i, 120_000);
  info(`界面提示：${JSON.stringify(t1)}`);
  if (lastUploadResp) {
    info(`接口响应：HTTP ${lastUploadResp.status} — ${lastUploadResp.body}`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, '11-real-pdf-result.png') });

  check(
    '真实 PDF 不再抛 pdfParse is not a function',
    !/pdfParse is not a function/i.test(t1),
    t1 ? '' : '(没等到任何提示)',
  );
  check(
    '扫描件给出可执行的失败原因（无文字层）',
    /no extractable text/i.test(t1),
    t1,
  );

  // 静默入库检查：等一拍让后台流水线跑完，再看列表有没有多出东西。
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });
  const after = await docRows(page);
  check(
    '没有把噪声文档静默入库（列表条数未增加）',
    after.length === before.length,
    `${before.length} → ${after.length}`,
  );
  await page.screenshot({ path: path.join(OUT_DIR, '12-real-pdf-nothing-ingested.png') });

  // ── 场景二：正向对照，有文字层的真 PDF 必须解析成功 ─────────────────
  info('正向对照：往一个对照知识库里传一份有文字层的真 PDF');
  await page.goto(`${BASE}/knowledge-bases`, { waitUntil: 'domcontentloaded' });
  // 复用已有的对照库：这是个可重复跑的脚本，每次新建只会把库列表堆满。
  await page.getByRole('button', { name: /新建知识库/ }).first().waitFor({ timeout: 20_000 });
  // 用列表接口定位对照库，不要用 getByText 猜 DOM：卡片上的文字被拆在多个 span 里，
  // 文本匹配会静默落空，于是每次重跑都新建一个库、把列表堆满（这个脚本已经犯过一次）。
  const existing = await page.evaluate(async (prefix) => {
    const r = await fetch('/api/paas/knowledge-bases');
    if (!r.ok) return null;
    const d = await r.json();
    const hit = (d.knowledge_bases || []).find((k) => String(k.name || '').startsWith(prefix));
    return hit ? { id: hit.id, name: hit.name } : null;
  }, 'PDF 解析验证');
  if (existing) {
    info(`复用对照库：${existing.name}（${existing.id}）`);
    await page.goto(`${BASE}/knowledge-bases/${existing.id}`, { waitUntil: 'domcontentloaded' });
  } else {
    const ctrlName = `PDF 解析验证 ${Date.now().toString().slice(-6)}`;
    await page.getByRole('button', { name: /新建知识库/ }).first().click();
    await page.getByPlaceholder('名称').fill(ctrlName);
    await page.getByTestId('kb-create-submit').click();
    await page.waitForTimeout(2500);
    const ctrlLink = page.getByText(ctrlName, { exact: true }).first();
    await ctrlLink.waitFor({ timeout: 20_000 });
    await ctrlLink.click();
  }
  await page.getByTestId('kb-upload-button').waitFor({ timeout: 20_000 });
  const ctrlUrl = page.url();
  info(`对照库：${ctrlUrl}`);

  const chooser2Promise = page.waitForEvent('filechooser', { timeout: 15_000 });
  await page.getByTestId('kb-upload-button').click();
  const chooser2 = await chooser2Promise.catch(() => null);
  if (!chooser2) throw new Error('对照库的上传按钮点不动');
  await chooser2.setFiles(CTRL_PDF);
  // 脚本可重复跑：第二次传同一个文件会被内容哈希判重，这也是"被接受"的一种，
  // 不能因为判重就判失败（那会让重跑变成假红）。
  const t2 = await waitToast(page, /已上传|Duplicate|失败|Unsupported|too large/i, 60_000);
  info(`对照提示：${JSON.stringify(t2)}`);
  check('有文字层的 PDF 被接受（或判为重复）', /已上传|Duplicate/.test(t2), t2);

  // 等后台流水线：解析 → 切块（向量化可能需要外部模型，这里只要求切出分块）
  let ctrlRow = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const rows = await docRows(page);
    ctrlRow = rows[0] ?? null;
    if (ctrlRow && !/解析中|排队中|分块中/.test(ctrlRow.raw) && /分块 \d+/.test(ctrlRow.raw)) {
      const n = Number((ctrlRow.raw.match(/分块 (\d+)/) || [])[1] ?? 0);
      if (n > 0 && !/向量化中/.test(ctrlRow.raw)) break;
    }
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('kb-upload-button').waitFor({ timeout: 20_000 });
  }
  const ctrlRows = await docRows(page);
  ctrlRow = ctrlRows[0] ?? null;
  const chunkCount = Number((ctrlRow?.raw.match(/分块 (\d+)/) || [])[1] ?? 0);
  check(
    '有文字层的 PDF 解析并切出分块',
    chunkCount > 0,
    ctrlRow ? ctrlRow.raw.replace(/\s+/g, ' ').slice(0, 160) : '(没有文档行)',
  );
  check(
    '对照文档没有失败',
    !/失败/.test(ctrlRow?.status ?? ''),
    ctrlRow?.status ?? '',
  );
  // 分块正文必须是真内容，不是页码标记。
  // ⚠️ 一定要**在分块页里选中文档**再看：不选的话页面上只有"请选择一份文档"，
  //    于是"正文里没有页码标记"这条断言在空页面上恒真 —— 等于没测。
  if (chunkCount > 0) {
    await page.getByTestId('kb-tab-chunks').click();
    const sel = page.getByTestId('kb-doc-select');
    await sel.waitFor({ timeout: 15_000 });
    const opt = await sel.locator('option').nth(1).getAttribute('value');
    await sel.selectOption(opt);
    await page.waitForTimeout(2500);
    const chunkText = await page.evaluate(() => document.body.innerText);
    check(
      '分块正文里没有伪造的页码标记 -- n of N --',
      !/--\s*\d+\s+of\s+\d+\s*--/.test(chunkText),
      /--\s*\d+\s+of\s+\d+\s*--/.test(chunkText) ? '(出现了伪造标记)' : '',
    );
    // 非空转断言：分块正文明明抽出来了，就必须能读到 PDF 里的真实句子。
    check(
      '分块正文就是 PDF 里的真实文字',
      /DeepThink PDF 解析回归夹具/.test(chunkText) &&
        /ASCII mixed content 12345/.test(chunkText),
      chunkText.replace(/\s+/g, ' ').slice(0, 120),
    );
    await page.screenshot({ path: path.join(OUT_DIR, '13-textlayer-pdf-chunks.png') });
  }
} catch (err) {
  check('脚本执行未中断', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: path.join(OUT_DIR, '99-failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`—— 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ——`);
if (failed.length) {
  for (const f of failed) console.log(`❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
console.log(`截图目录：${OUT_DIR}`);
process.exit(failed.length ? 1 : 0);
