/**
 * 知识库 P2「文档接入扩展」真机验收（Playwright + 真实点击 + 截图留档）。
 *
 * 对的是 PRD-P2 §5 的 AC-1/2/4/5/6/7/8/14 —— 凡是「用户点得到吗」这条线上的，
 * 一律走真实入口（点按钮 → waitForEvent('filechooser')），不用 setInputFiles 直接
 * 塞给隐藏 input：后者绕过了按钮点击，按钮要是坏了照样"通过"。
 *
 * 默认打隔离实例（非 9999 生产），并且**跑编译产物**：
 *   DEEPTHINK_DATA_DIR=~/.deepthink-9922 DEEPTHINK_WEB_DIST_DIR=$PWD/web/dist \
 *   WEB_PORT=9922 node dist/index.js
 * 这一点是刻意的 —— 本次修掉的 `require is not defined` 只在真实 ESM 运行时暴露，
 * tsx / vitest 里都被转换层补掉了。验收必须打在 dist 上。
 *
 * 用法：
 *   DT_BASE=http://127.0.0.1:9922 node tests/e2e/kb-p2-ingest.mjs
 * 换端口/账号：DT_BASE / DT_USER / DT_PASS / DT_OUT
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const BASE = process.env.DT_BASE || 'http://127.0.0.1:9922';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '88888888';
const OUT = process.env.DT_OUT || path.join(REPO, 'logs/e2e-kb-p2');
const FMT = path.join(REPO, 'tests/fixtures/formats');
const OFFICE = path.join(REPO, 'tests/fixtures/office');
const PDF = path.join(REPO, 'tests/fixtures/pdf');
const DIRTREE = path.join(REPO, 'tests/fixtures/dirtree');

fs.mkdirSync(OUT, { recursive: true });
const results = [];
let shotSeq = 0;
const log = (...a) => console.log(...a);

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => log('   [pageerror]', e.message));

const shot = async (name) => {
  shotSeq += 1;
  const file = path.join(OUT, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
};

/** 文档列表读成结构化数组（列表是轮询刷新的，读之前先等一拍）。 */
async function readDocRows() {
  await page.waitForTimeout(400);
  const raw = await page.locator('[data-testid="kb-doc-row"]').allInnerTexts();
  return raw.map((t) => {
    const flat = t.replace(/\s+/g, ' ').trim();
    const status =
      flat.match(/就绪|解析中|待处理|向量化中|失败|OCR/)?.[0] ?? '';
    return {
      flat,
      status,
      name: flat.split(' ')[0],
      chunks: Number(flat.match(/分块\s*(\d+)/)?.[1] ?? -1),
      embedded: Number(flat.match(/已向量化\s*(\d+)/)?.[1] ?? -1),
      parser: flat.match(/parser[:\s]*([a-z_]+)/i)?.[1] ?? '',
    };
  });
}

/**
 * 关掉「手写 Markdown」弹窗。
 *
 * 不能按 Esc —— 这个弹窗没有接键盘事件；点遮罩才是它自己实现的关闭路径
 * （`onClick={() => setShowText(false)}` 在 backdrop 上，卡片内部 stopPropagation）。
 * 卡片居中且 max-w-2xl，所以视口左上角必然落在遮罩上。
 */
async function closeTextDialog() {
  if (!(await page.locator('[data-testid="kb-text-dialog"]').isVisible().catch(() => false))) return;
  await page.mouse.click(20, 20);
  await page
    .locator('[data-testid="kb-text-dialog"]')
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => {});
}

/** 走真实的新建弹窗建一个文档库，返回 kbId 并停在「文档」页签。 */
async function createKb(name) {
  await page.goto(`${BASE}/knowledge-bases`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /新建知识库/ }).click();
  await page.locator('[data-testid="kb-create-name"]').fill(name);
  await page.locator('[data-testid="kb-create-type-document"]').click();
  await page.locator('[data-testid="kb-create-submit"]').click();
  await page.waitForURL(/\/knowledge-bases\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await page.locator('[data-testid="kb-tab-documents"]').click();
  await page.locator('[data-testid="kb-upload-button"]').waitFor({ state: 'visible' });
  return page.url().split('/').pop();
}

/** 用真实的文件选择框路径上传一个文件（点按钮 → 等 chooser → 给文件）。 */
async function uploadViaButton(buttonTestId, filePath) {
  const chooserP = page.waitForEvent('filechooser', { timeout: 10_000 });
  await page.locator(`[data-testid="${buttonTestId}"]`).click();
  const chooser = await chooserP;
  await chooser.setFiles(filePath);
  return chooser;
}

/** 等某个**文件名**出现在列表里且状态为「就绪」，超时返回 null。 */
async function waitForReady(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const rows = await readDocRows();
    const hit = rows.find((r) => r.flat.includes(name));
    if (hit) {
      last = hit;
      if (hit.status === '就绪') return hit;
      if (hit.status === '失败') return null;
    }
    await page.waitForTimeout(1500);
  }
  return last && last.status === '就绪' ? last : null;
}

try {
  // ── 登录 ────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"], input#username, input[type="text"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  check('登录成功', true, page.url());

  // 全新数据目录的实例会被 AuthGuard 拦到 /setup/providers（needsSetup = 没有任何
  // 已启用的 Claude provider）。知识库链路完全不碰 Claude，所以填一个**假 Key** 把
  // 引导过掉即可 —— 走的是引导页自己那条 POST，不伪造状态。
  // 检索的「查询理解」会因此调用失败并回落到原始问题，这正好也在验收范围内。
  if (page.url().includes('/setup/providers')) {
    const saved = await page.evaluate(async () => {
      const r = await fetch('/api/config/claude/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: 'e2e 占位（非真实 Key）',
          type: 'official',
          anthropicApiKey: 'sk-ant-api03-e2e-placeholder-not-a-real-key',
          enabled: true,
        }),
      });
      return r.status;
    });
    await page.waitForTimeout(1500);
    await page.goto(`${BASE}/knowledge-bases`, { waitUntil: 'domcontentloaded' });
    const unblocked = !page.url().includes('/setup/providers');
    check('引导态解除（写入占位 provider）', unblocked, `POST 返回 ${saved}，当前 ${page.url()}`);
  }

  // ── 建一个干净的知识库（走真实的新建弹窗） ──────────────
  const kbName = `P2 验收 ${new Date().toISOString().slice(11, 19)}`;
  const kbId = await createKb(kbName);
  check('通过真实弹窗新建文档库', !!kbId, `kb=${kbId} 「${kbName}」`);
  await shot('kb-created');

  // ── AC-14a：上传按钮真的弹文件选择框（16:18 用户报的那个缺陷） ──
  const chooser1 = page.waitForEvent('filechooser', { timeout: 8000 });
  await page.locator('[data-testid="kb-upload-button"]').click();
  let fc = null;
  try {
    fc = await chooser1;
  } catch {
    /* 没弹出来 */
  }
  check('点「上传文档」弹出文件选择框（真实点击）', !!fc);
  if (fc) await fc.setFiles([]);
  await page.keyboard.press('Escape');

  // AC-14b（「上传目录」按钮真的弹文件选择框）不在这里单独探一次：
  // 那个 input 带 webkitdirectory，Playwright 只接受**目录路径**，
  // 探完没法收尾（setFiles([]) 被拒 -> 遗留一个未消费的 chooser，下一个
  // filechooser 事件会错位）。AC-6/AC-7 那段点的是同一个按钮、走的是同一条
  // 真实点击路径，那里一并验，证据不减。

  // ── AC-4：手写 Markdown —— 空标题必须被拒且不留文档行 ────
  const rowsBefore4 = (await readDocRows()).length;
  await page.locator('[data-testid="kb-upload-text-button"]').click();
  await page.locator('[data-testid="kb-text-dialog"]').waitFor({ state: 'visible' });
  await page.locator('[data-testid="kb-text-body"]').fill('只有正文没有标题');
  await page.locator('[data-testid="kb-text-save"]').click();
  await page.waitForTimeout(1200);
  await shot('text-empty-title-rejected');
  const dialogStillOpen = await page.locator('[data-testid="kb-text-dialog"]').isVisible();
  const rowsAfter4 = (await readDocRows()).length;
  check(
    'AC-4 手写空标题被拒且不留文档行',
    dialogStillOpen && rowsAfter4 === rowsBefore4,
    `弹窗仍开=${dialogStillOpen} 行数 ${rowsBefore4}→${rowsAfter4}`,
  );

  // ── AC-1/AC-5：手写 Markdown 正常入库 + 二次提交判重 ─────
  const mdToken = 'HANDTOKEN-9182';
  const mdTitle = `手写备忘 ${mdToken}`;
  await page.locator('[data-testid="kb-text-title"]').fill(mdTitle);
  await page.locator('[data-testid="kb-text-body"]').fill(`# ${mdTitle}\n\n这是手写正文，代号 ${mdToken}。`);
  await page.locator('[data-testid="kb-text-save"]').click();
  const mdRow = await waitForReady(mdToken, 90_000);
  check('AC-1 手写 Markdown 入库并到「就绪」', !!mdRow, mdRow ? mdRow.flat : '超时未就绪');
  await shot('text-created');

  // 二次提交一字不差 → 应当被 409 判重挡下，列表不长新行。
  const rowsBefore5 = (await readDocRows()).length;
  await page.locator('[data-testid="kb-upload-text-button"]').click();
  await page.locator('[data-testid="kb-text-title"]').fill(mdTitle);
  await page.locator('[data-testid="kb-text-body"]').fill(`# ${mdTitle}\n\n这是手写正文，代号 ${mdToken}。`);
  await page.locator('[data-testid="kb-text-save"]').click();
  await page.waitForTimeout(1500);
  const rowsAfter5 = (await readDocRows()).length;
  check('AC-5 同内容二次提交被判重（列表不新增）', rowsAfter5 === rowsBefore5, `行数 ${rowsBefore5}→${rowsAfter5}`);
  await shot('text-duplicate');
  await closeTextDialog();

  // ── AC-1/AC-2：格式矩阵逐个上传 ─────────────────────────
  const matrix = [
    { file: path.join(OFFICE, 'slides.pptx'), token: 'CHARLIE-9930', label: 'pptx' },
    { file: path.join(OFFICE, 'dosing.xlsx'), token: '药物名称', label: 'xlsx' },
    { file: path.join(OFFICE, 'handbook.epub'), token: '访视安排', label: 'epub' },
    { file: path.join(OFFICE, 'design.xmind'), token: '研究设计', label: 'xmind' },
    { file: path.join(FMT, 'notes.html'), token: 'HTMLTOKEN-4471', label: 'html' },
    { file: path.join(FMT, 'labs.csv'), token: 'CSVTOKEN-8830', label: 'csv' },
    { file: path.join(FMT, 'protocol.json'), token: 'JSONTOKEN-5512', label: 'json' },
    { file: path.join(FMT, 'README.md'), token: 'MDTOKEN-6604', label: 'md' },
    { file: path.join(FMT, 'memo.txt'), token: 'TXTTOKEN-7723', label: 'txt' },
    { file: path.join(PDF, 'text-layer.pdf'), token: '', label: 'pdf' },
  ];
  const matrixRows = [];
  for (const item of matrix) {
    const name = path.basename(item.file);
    const chooserP = page.waitForEvent('filechooser', { timeout: 10_000 });
    await page.locator('[data-testid="kb-upload-button"]').click();
    const c = await chooserP;
    await c.setFiles(item.file);
    const row = await waitForReady(name, 120_000);
    matrixRows.push({ ...item, name, row });
    check(
      `AC-1 格式矩阵 ${item.label} 上传到「就绪」`,
      !!row,
      row ? `分块 ${row.chunks} / 已向量化 ${row.embedded}` : '超时或失败',
    );
  }
  await shot('format-matrix');

  // ── AC-2/AC-3：结构关键词能被检索命中（混合模式） ────────
  await page.locator('[data-testid="kb-tab-search"]').click();
  await page.locator('[data-testid="kb-search-input"]').waitFor({ state: 'visible' });
  const searchCases = [
    { q: 'CHARLIE-9930', want: 'slides.pptx', why: 'pptx 正文' },
    { q: 'HTMLTOKEN-4471', want: 'notes.html', why: 'html 正文（require 缺陷的回归点）' },
    { q: 'TXTTOKEN-7723', want: 'memo.txt', why: 'txt 正文' },
  ];
  for (const sc of searchCases) {
    await page.locator('[data-testid="kb-search-input"]').fill(sc.q);
    await page.locator('[data-testid="kb-search-button"]').click();
    await page.waitForTimeout(4000);
    const hits = await page.locator('[data-testid="kb-search-hit"]').allInnerTexts();
    const flat = hits.join(' ').replace(/\s+/g, ' ');
    check(
      `AC-3 检索「${sc.q}」命中（${sc.why}）`,
      hits.length > 0 && flat.includes(sc.want),
      `命中 ${hits.length} 条`,
    );
    await shot(`search-${sc.q.toLowerCase()}`);
  }

  // ── AC-6/AC-7：目录上传 —— 隐藏项跳过、相对路径保留 ──────
  await page.locator('[data-testid="kb-tab-documents"]').click();
  await page.locator('[data-testid="kb-upload-dir-button"]').waitFor({ state: 'visible' });
  const rowsBefore6 = (await readDocRows()).length;
  const chooser3 = page.waitForEvent('filechooser', { timeout: 10_000 });
  await page.locator('[data-testid="kb-upload-dir-button"]').click();
  let cd = null;
  try {
    cd = await chooser3;
  } catch {
    /* 没弹出来 */
  }
  check('点「上传目录」弹出文件选择框（真实点击，AC-14）', !!cd);
  // 从「检索测试台」切回来之后，这个 input 是新挂载的节点 —— 显式验一下
  // webkitdirectory 还在。它要是没了，下面这句 setFiles(目录) 会直接抛，
  // 但那时报的是 Playwright 的错，指不到根因。
  const hasWebkitDir = await page.evaluate(
    () => !!document.querySelector('[data-testid="kb-upload-dir-input"]')?.hasAttribute('webkitdirectory'),
  );
  check('切页签回来后 webkitdirectory 仍在（目录上传没有静默退化）', hasWebkitDir);
  // 真实「选目录」语义：把整个目录交给 webkitdirectory input，
  // 浏览器据此生成 webkitRelativePath —— 相对路径就是靠它保住的。
  if (!cd) throw new Error('上传目录按钮没有弹出文件选择框');
  await cd.setFiles(DIRTREE);
  await page.locator('[data-testid="kb-upload-result"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(12_000);
  const resultText = (await page.locator('[data-testid="kb-upload-result"]').innerText()).replace(/\s+/g, ' ');
  log('   目录上传回执: ' + resultText);
  await shot('dir-upload-result');

  const rows6 = await readDocRows();
  const names6 = rows6.map((r) => r.flat).join('\n');
  check('AC-6 目录上传：隐藏文件未入库', !names6.includes('SHOULD-NOT-APPEAR-DRAFT'), '');
  check('AC-6 目录上传：隐藏目录未入库', !names6.includes('SHOULD-NOT-APPEAR-CACHE'), '');
  check(
    'AC-7 目录上传：相对路径保留（含 protocol/ 或 analysis/ 目录段）',
    /protocol\/visit\.md|analysis\/stats\.csv/.test(names6),
    rows6.map((r) => r.name).filter((n) => n.includes('/')).join(' ') || '(没有带目录段的文件名)',
  );
  check('AC-6 目录上传：回执逐条给出结果', /成功|跳过|失败/.test(resultText), resultText.slice(0, 90));
  log(`   目录上传后文档行数 ${rowsBefore6} → ${rows6.length}`);
  // 等的是**文件名**（stats.csv），不是内容里的 token —— 列表上只有文件名。
  const dirRow = await waitForReady('stats.csv', 60_000);
  check('AC-1 目录上传的子目录文件也到「就绪」', !!dirRow, dirRow ? dirRow.flat : '超时未就绪');

  // ── AC-8：整包 zip 上传 —— 解出 3 份文档 ────────────────
  //
  // 换一个**空库**做，不是图省事：判重是按内容哈希的，上面矩阵已经传过
  // slides.pptx / dosing.xlsx，同一个包里再带一遍会被正确判成「与库内已有文档
  // 内容相同」而跳过 —— 那样测的是判重，不是解包。空库才能验 AC-8 的「+3」。
  const kb2 = await createKb(`P2 整包 ${new Date().toISOString().slice(11, 19)}`);
  check('建第二个（空）文档库用于整包验收', !!kb2, `kb=${kb2}`);
  await uploadViaButton('kb-upload-button', path.join(OFFICE, 'mixed-archive.zip'));
  await page.locator('[data-testid="kb-upload-result"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(20_000);
  const zipText = (await page.locator('[data-testid="kb-upload-result"]').innerText()).replace(/\s+/g, ' ');
  log('   zip 回执: ' + zipText);
  await shot('zip-archive-result');
  const rows8 = await readDocRows();
  // 回执有两层计数：顶层是「上传了几个文件」（这里是 1 个压缩包），
  // 解包结果在「解包后：入库 N · 跳过 M」。要断言的是后者。
  check(
    'AC-8 整包 zip 解出 3 份文档',
    /解包后：入库\s*3/.test(zipText) && rows8.length === 3,
    `空库行数 ${rows8.length}（期望 3）；回执「${zipText.slice(0, 90)}」`,
  );
  const zipAll = rows8.map((r) => r.flat).join(' ');
  check('AC-8 整包 zip：__MACOSX 未入库', !zipAll.includes('__MACOSX'), '');
  check('AC-8 整包 zip：隐藏项与不支持格式未入库', !zipAll.includes('.draft.md') && !zipAll.includes('logo.png'), '');
  check(
    'AC-8 整包 zip：包内相对路径保留',
    zipAll.includes('protocol/slides.pptx') && zipAll.includes('notes/plan.md'),
    rows8.map((r) => r.name).join(' '),
  );
  const zipReady = await waitForReady('plan.md', 90_000);
  check('AC-8 整包 zip：解出的文档到「就绪」', !!zipReady, zipReady ? zipReady.flat : '超时未就绪');

  // ── AC-3 补一枪：整包进来的文档也能被检索命中 ────────────
  await page.locator('[data-testid="kb-tab-search"]').click();
  await page.locator('[data-testid="kb-search-input"]').fill('ARCHIVETOKEN-2255');
  await page.locator('[data-testid="kb-search-button"]').click();
  await page.waitForTimeout(4000);
  const arHits = (await page.locator('[data-testid="kb-search-hit"]').allInnerTexts()).join(' ');
  check('AC-3 检索命中整包上传的 md', /ARCHIVETOKEN-2255/.test(arHits.replace(/\s+/g, ' ')), `${arHits.length} 字符命中文本`);
  await shot('search-archive');

  // 回到第一个库继续做全量汇总。
  await page.goto(`${BASE}/knowledge-bases/${kbId}`, { waitUntil: 'domcontentloaded' });

  // ── 汇总：全部文档行状态 ────────────────────────────────
  await page.locator('[data-testid="kb-tab-documents"]').click();
  await page.waitForTimeout(1500);
  const finals = await readDocRows();
  log('\n=== 最终文档列表 ===');
  finals.forEach((r) => log('  ' + r.flat));
  await shot('final-list');

  const notReady = finals.filter((r) => r.status !== '就绪');
  check('AC-1 全量：所有文档均为「就绪」（无卡在解析中/失败）', notReady.length === 0, notReady.map((r) => r.flat).join(' | ') || `${finals.length} 份全部就绪`);

  const zeroChunk = finals.filter((r) => r.chunks <= 0);
  check('AC-2 全量：每份文档都有分块', zeroChunk.length === 0, zeroChunk.map((r) => r.flat).join(' | ') || `${finals.length} 份均有分块`);

  fs.writeFileSync(path.join(OUT, 'final-docs.json'), JSON.stringify(finals, null, 2));
  fs.writeFileSync(path.join(OUT, 'kb-id.txt'), kbId + '\n');
} catch (err) {
  check('e2e 异常终止', false, err?.stack || String(err));
  await shot('error').catch(() => {});
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.ok).length;
log(`\n${'-'.repeat(60)}`);
log(`P2 真机验收：${pass}/${results.length} 通过  → 截图 ${OUT}`);
log(`${'-'.repeat(60)}`);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
process.exit(pass === results.length ? 0 : 1);
