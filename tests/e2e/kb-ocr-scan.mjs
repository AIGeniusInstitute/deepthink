/**
 * 扫描件 OCR 的真实 UI 端到端验收（需要已跑起来的实例 + 本机模型服务）。
 *
 * 为什么不能靠单测代理这条结论：单测用的是桩服务，验的是**编排**；这条链路真正会
 * 出问题的地方在别处 —— 上传分支有没有走到 OCR 通道、后台任务有没有把正文补上、
 * 分块有没有真的落库、检索能不能命中。这四件事跨越 HTTP / 后台任务 / DB / 检索四层，
 * 只有对着真实实例跑才算数。
 *
 * 验收标准直接取自 PRD 的 AC-1…AC-6：
 *   AC-1 上传返回 201 且带 ocr 标志，文档状态进入 ocr
 *   AC-2 轮询到终态：ready + parser_type=pdf_ocr + 分块 > 0
 *   AC-3 分块正文含扫描页里的真实词（夹具预置，见 build-scanned-pdf.mjs）
 *   AC-4 用扫描页里的词做检索能命中该文档
 *   AC-5 关闭 OCR 时上传扫描件 → 400 且**不产生**文档行
 *   AC-6 失败页在正文里留痕（这一条靠夹具无法构造，留给单测）
 *
 * ⚠️ 上传必须走**真实按钮点击 + filechooser**，不能用 setInputFiles 直接给 input
 *    赋值 —— 那条路绕过了「点击 → 转发 → 弹框」这一跳，而这跳曾经真的坏过（label 吞点击）。
 *
 * 用法：
 *   make start-prod PORT=9898
 *   DT_BASE=http://localhost:9898 DT_USER=admin DT_PASS='xxx' \
 *     node tests/e2e/kb-ocr-scan.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const BASE = process.env.DT_BASE || 'http://127.0.0.1:9898';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '';
const KB_NAME = process.env.DT_KB_NAME || 'OCR 扫描件验收';
const SCAN_PDF = process.env.DT_SCAN_PDF || path.join(REPO, 'tests', 'fixtures', 'pdf', 'scanned-3p.pdf');
const OUT_DIR = process.env.DT_OUT || path.join(REPO, 'logs', 'kb-ocr-scan');
const KEEP = process.env.DT_KEEP === '1';

/** 夹具里预置的关键词（见 tests/fixtures/pdf/build-scanned-pdf.mjs）。 */
const EXPECTED_KEYWORDS = ['ALPHA-7749', 'BRAVO-2251', 'CHARLIE-9930', 'Osimertinib'];

if (!PASS) {
  console.error('❌ 需要 DT_PASS=<password>');
  process.exit(1);
}
if (!fs.existsSync(SCAN_PDF)) {
  console.error(`❌ 找不到扫描件夹具：${SCAN_PDF}`);
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

async function allToasts(page) {
  return page.$$eval('[data-sonner-toast]', (els) => els.map((e) => e.textContent.trim()));
}

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

/** 该用户的全部知识库（直接读接口，不在 DOM 里猜文字）。 */
async function listKbs(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/paas/knowledge-bases');
    if (!r.ok) return [];
    const d = await r.json();
    return d.knowledge_bases || [];
  });
}

/** 找到或新建验收用的知识库。可重复跑，不堆库。 */
async function ensureKb(page) {
  const found = (await listKbs(page)).find((k) => k.name === KB_NAME);
  if (found) {
    info(`复用知识库：${found.name}（${found.id}）`);
    return found.id;
  }
  const created = await page.evaluate(async (name) => {
    const r = await fetch('/api/paas/knowledge-bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: '扫描件 OCR 端到端验收（可删）' }),
    });
    if (!r.ok) return { error: `HTTP ${r.status} ${await r.text()}` };
    const d = await r.json();
    return { id: d.knowledge_base?.id || d.id };
  }, KB_NAME);
  if (!created.id) throw new Error(`新建知识库失败：${created.error}`);
  info(`新建知识库：${KB_NAME}（${created.id}）`);
  return created.id;
}

async function docRows(page) {
  return page.$$eval('[data-testid="kb-doc-row"]', (rows) =>
    rows.map((r) => ({
      status: r.querySelector('[data-testid="kb-doc-status"]')?.textContent?.trim() ?? '',
      progress: r.querySelector('[data-testid="kb-doc-ocr-progress"]')?.textContent?.trim() ?? '',
      raw: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
    })),
  );
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`   [browser error] ${m.text()}`);
});

/** 抓上传接口的真实响应体 —— toast 是一句话，服务端回的 JSON 才是硬证据。 */
let lastUploadResp = null;
page.on('response', (res) => {
  try {
    const u = new URL(res.url());
    if (res.request().method() === 'POST' && /\/documents$/.test(u.pathname)) {
      void res
        .text()
        .then((body) => {
          lastUploadResp = { status: res.status(), body: body.slice(0, 800) };
        })
        .catch(() => {});
    }
  } catch {
    /* 忽略无法解析的 URL */
  }
});

let kbId = '';
try {
  // ── 登录 ──────────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="text"], input[name="username"]').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole('button', { name: /登录/ }).click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  check('登录成功', true, page.url());

  // 全新实例的首次登录会掉进 /setup 引导页，那里没有知识库入口。
  // 引导页全是可选项，直接「保存全局默认并进入后台」即可 —— 只在确实被重定向时才点，
  // 老实例不受影响（这个脚本要能反复跑）。
  if (page.url().includes('/setup')) {
    info('实例尚未完成初始化引导，走一遍（全部留空 = 全默认）');
    // 引导是多步的，点到离开 /setup 为止。
    for (let i = 0; i < 6 && page.url().includes('/setup'); i++) {
      // 必须等按钮渲染出来再点。这里踩过一次：登录后立刻 count() 得到 0，
      // 于是循环一次都没进就"完成"了，后面每个用例都在引导页上超时 ——
      // 现象看着像"上传按钮不见了"，实际是根本没进后台。
      const finish = page.getByRole('button', { name: /保存全局默认并进入后台/ });
      const appeared = await finish
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!appeared) break;
      // 引导页会拦住"没填 Claude 凭据"的情况（官方渠道必须有一键登录 / API Key /
      // setup-token 之一）。OCR 链路跟这个凭据毫无关系，所以在这个一次性的验收实例上
      // 填一个**明确是占位符**的值过去，别让不相关的门禁挡住本需求的验收。
      // 这里填的是假值，不会去调 Anthropic；真实实例不受影响（只有 URL 在 /setup 时才走这段）。
      //
      // 顺序不能反：默认停在 OAuth 页签，`sk-ant` 输入框**根本没渲染**。
      // 先查输入框再切页签会得到 count()===0，于是跳过填写、点保存、被校验拦下，
      // 循环一轮轮空转 —— 表现就是"点了按钮什么都不发生"。
      const apiKeyTab = page.getByRole('button', { name: 'API Key', exact: true });
      if ((await apiKeyTab.count()) > 0) {
        await apiKeyTab.first().click();
        await page.waitForTimeout(800);
        const keyInput = page.locator('input[placeholder*="sk-ant"]');
        if ((await keyInput.count()) > 0 && (await keyInput.first().inputValue()) === '') {
          await keyInput.first().fill('sk-ant-placeholder-e2e-not-a-real-key');
        }
      }
      await finish.first().click();
      await page.waitForTimeout(3000);
    }
    check('完成初始化引导', !page.url().includes('/setup'), page.url());
  }

  kbId = await ensureKb(page);

  // ── 前置：本机模型服务与视觉模型就绪 ───────────────────────────────
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/paas/local-model');
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  });
  info(`本机模型服务：${JSON.stringify(status.service ?? status.error)}`);
  info(`OCR 配置：${JSON.stringify(status.ocr ?? null)}`);
  check('本机模型服务可用', status.service?.available === true, status.service?.version ?? '');
  check('扫描件 OCR 已启用', status.ocr?.enabled === true, status.ocr?.model ?? '');
  check(
    '视觉模型已安装',
    (status.models ?? []).some((m) => String(m.name).startsWith(String(status.ocr?.model).split(':')[0])),
    (status.models ?? []).map((m) => m.name).join(', '),
  );

  // ── AC-1：真实入口上传扫描件 ──────────────────────────────────────
  await page.goto(`${BASE}/knowledge-bases/${kbId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });
  const before = await docRows(page);
  info(`上传前文档数：${before.length}`);
  await page.screenshot({ path: path.join(OUT_DIR, '20-before-upload.png') });

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
  await page.getByTestId('kb-upload-button').click();
  const chooser = await chooserPromise.catch(() => null);
  check('点「上传文档」能唤起文件选择框（真实用户路径）', chooser !== null);
  if (!chooser) throw new Error('上传按钮点不动：filechooser 未触发');

  await chooser.setFiles(SCAN_PDF);
  const toast = await waitToast(page, /OCR|已上传|失败|error/i, 120_000);
  info(`界面提示：${JSON.stringify(toast)}`);
  if (lastUploadResp) info(`上传响应：HTTP ${lastUploadResp.status} — ${lastUploadResp.body}`);
  await page.screenshot({ path: path.join(OUT_DIR, '21-upload-accepted.png') });

  check('上传被接受（201）', lastUploadResp?.status === 201, `HTTP ${lastUploadResp?.status}`);
  check(
    '响应带 ocr 标志，走的是扫描件通道',
    /"ocr"\s*:\s*true/.test(lastUploadResp?.body ?? ''),
    (lastUploadResp?.body ?? '').slice(0, 160),
  );

  // ── AC-1/AC-2：轮询到终态 ─────────────────────────────────────────
  // 夹具只 3 页，但首次调用要等模型加载进显存，给足时间。
  const deadline = Date.now() + 10 * 60_000;
  let sawOcr = false;
  let finalRows = [];
  let ocrScreenshotTaken = false;
  while (Date.now() < deadline) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });
    finalRows = await docRows(page);
    const row = finalRows[0];
    if (!row) {
      await page.waitForTimeout(2000);
      continue;
    }
    if (/OCR/.test(row.status)) {
      sawOcr = true;
      info(`状态：${row.status} ${row.progress}`);
      if (!ocrScreenshotTaken && row.progress) {
        await page.screenshot({ path: path.join(OUT_DIR, '22-ocr-in-progress.png') });
        ocrScreenshotTaken = true;
      }
    } else {
      info(`状态：${row.status}`);
    }
    if (/就绪|ready|失败|failed/.test(row.status)) break;
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: path.join(OUT_DIR, '23-final-status.png') });

  const finalRow = finalRows[0] ?? { status: '', raw: '' };
  check('文档进入「OCR 识别中」状态', sawOcr || /就绪/.test(finalRow.status), finalRow.status);
  check('文档最终变为「就绪」', /就绪|ready/.test(finalRow.status), finalRow.raw);

  // ── AC-2/AC-3：分块真的落库，且正文是扫描页里的字 ──────────────────
  const docInfo = await page.evaluate(async (id) => {
    const r = await fetch(`/api/paas/knowledge-bases/${id}/documents`);
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const d = await r.json();
    return { documents: d.documents || d.items || [] };
  }, kbId);
  const doc = (docInfo.documents ?? [])[0];
  info(`文档：${JSON.stringify(doc)}`);
  check('文档记录存在', Boolean(doc), doc ? doc.filename : '(无)');
  check('parser_type = pdf_ocr', doc?.parser_type === 'pdf_ocr', doc?.parser_type ?? '(空)');
  check('分块数 > 0', (doc?.chunk_count ?? 0) > 0, `chunk_count=${doc?.chunk_count}`);

  const chunkData = doc
    ? await page.evaluate(async ({ id, docId }) => {
        const r = await fetch(`/api/paas/knowledge-bases/documents/${docId}/chunks?full=1`);
        if (!r.ok) return { error: `HTTP ${r.status}` };
        return await r.json();
      }, { id: kbId, docId: doc.id })
    : { chunks: [] };
  const allText = (chunkData.chunks ?? []).map((ch) => ch.content ?? '').join('\n');
  info(`分块正文合计 ${allText.length} 字符`);
  fs.writeFileSync(path.join(OUT_DIR, 'chunks.txt'), allText, 'utf8');

  for (const kw of EXPECTED_KEYWORDS) {
    check(`正文含扫描页里的真实词 ${kw}`, allText.includes(kw));
  }
  check('正文不是页码噪声（不含伪造的页码标记）', !/--\s*\d+\s+of\s+\d+\s*--/.test(allText));

  // ── AC-4：检索命中 ────────────────────────────────────────────────
  const search = await page.evaluate(
    async ({ id, query }) => {
      const r = await fetch(`/api/paas/knowledge-bases/${id}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, top_k: 5, mode: 'hybrid' }),
      });
      if (!r.ok) return { error: `HTTP ${r.status} ${await r.text()}` };
      return await r.json();
    },
    { id: kbId, query: 'Osimertinib 的用法用量是多少？' },
  );
  const hits = search.hits ?? search.results ?? [];
  info(`检索返回 ${hits.length} 条`);
  if (search.error) info(`检索错误：${search.error}`);
  check('用扫描页里的词检索能命中该文档', hits.length > 0, JSON.stringify(hits[0] ?? {}).slice(0, 240));

  // ── AC-5：关闭 OCR 后上传扫描件必须 400 且不产生文档行 ─────────────
  info('对照：临时关闭 OCR，再传一次扫描件，必须被拒绝且不留文档');
  await page.evaluate(async () => {
    await fetch('/api/paas/local-model/ocr-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
  });
  await page.goto(`${BASE}/knowledge-bases/${kbId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });
  const countBefore = (await docRows(page)).length;
  lastUploadResp = null;
  const chooser2Promise = page.waitForEvent('filechooser', { timeout: 15_000 });
  await page.getByTestId('kb-upload-button').click();
  const chooser2 = await chooser2Promise.catch(() => null);
  if (chooser2) {
    await chooser2.setFiles(SCAN_PDF);
    const t2 = await waitToast(page, /OCR|失败|error|启用/i, 60_000);
    info(`界面提示：${JSON.stringify(t2)}`);
    info(`上传响应：HTTP ${lastUploadResp?.status} — ${lastUploadResp?.body}`);
    check('关闭 OCR 时上传扫描件返回 400', lastUploadResp?.status === 400, `HTTP ${lastUploadResp?.status}`);
    check(
      '错误信息指向设置页（可执行，不是"上传失败"四个字）',
      /设置|启用|本机模型/i.test(lastUploadResp?.body ?? '') || /设置|启用/i.test(t2),
      (lastUploadResp?.body ?? t2).slice(0, 200),
    );
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('kb-upload-button').waitFor({ timeout: 30_000 });
    const countAfter = (await docRows(page)).length;
    check('被拒绝的上传没有留下文档行', countAfter === countBefore, `${countBefore} → ${countAfter}`);
    await page.screenshot({ path: path.join(OUT_DIR, '24-ocr-disabled-rejected.png') });
  } else {
    check('关闭 OCR 时仍能点开上传框', false, 'filechooser 未触发');
  }
  // 恢复 OCR 开关，别把实例留在"关闭"状态上
  await page.evaluate(async () => {
    await fetch('/api/paas/local-model/ocr-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });
} catch (err) {
  check('脚本执行未抛异常', false, err instanceof Error ? err.message : String(err));
  await page.screenshot({ path: path.join(OUT_DIR, '99-failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`扫描件 OCR 端到端验收：${passed}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name} — ${r.detail}`);
console.log(`截图与分块正文：${OUT_DIR}`);
fs.writeFileSync(
  path.join(OUT_DIR, 'result.json'),
  JSON.stringify({ base: BASE, kbId, results, passed, total: results.length }, null, 2),
  'utf8',
);
if (!KEEP && kbId) console.log(`（验收知识库保留在 ${kbId}，如需清理请手动删除）`);
process.exitCode = passed === results.length ? 0 : 1;
