/**
 * P1 知识库内核的 UI 验收（手工驱动，需要已跑起来的实例）。
 *
 * 覆盖 P1 五个子项里**在界面上有入口**的部分：
 *   1. 新建知识库（文档型 / FAQ 型）
 *   2. 上传文档时勾选「父子分块」→ 分块视图里能看到父块 / 子块标记
 *   3. Doc2Query 开关落库 → 生成问题 → 问题显示在分块上
 *   4. 用**界面上读到的**预生成问题去检索，能召回对应分块（正文里没有这句问法）
 *   5. FAQ 库：建条目 → 用只在「相似问题」里出现过的问法试检索，命中该条目
 *
 * ⚠️ 为什么自带一个假 OpenAI 服务：真跑一遍向量化与问题生成需要嵌入模型和问答模型。
 *    对着真实 API 跑既不可复现（模型输出每次都不同）又要外部凭据。所以脚本自己起一个
 *    OpenAI 兼容的桩服务（确定性向量 + 固定问题），把 embedding.json / rag.json 指过去，
 *    让整条链路在**真实 UI** 上跑通。桩只实现两个端点，不碰任何外部网络。
 *
 * ⚠️ 关键设计：检索用例的查询串不是脚本里写死的，而是**从分块 UI 上读回来的**那条
 *    预生成问题。写死的话，桩换一个出题模板用例就会静默失效；读回来则永远问的是
 *    "系统刚刚真的生成出来的那句话"，并且用例会先断言这句话不在正文里，
 *    这样"搜到了"才只能归因于问题索引，而不是分块正文自己挣来的。
 *
 * 用法：
 *   make start-prod PORT=9911
 *   DT_BASE=http://localhost:9911 DT_USER=admin DT_PASS='xxx' \
 *   DT_DATA_DIR=$HOME/.deepthink-9911 \
 *     node tests/e2e/kb-p1-ui.mjs
 *
 * 浏览器：用本机已安装的 Google Chrome（channel: 'chrome'），不下载 Playwright 自带内核。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';

const BASE = process.env.DT_BASE || 'http://localhost:9911';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '';
const OUT_DIR = process.env.DT_OUT || path.join(process.cwd(), 'logs', 'kb-p1-ui');
const DATA_DIR = process.env.DT_DATA_DIR || '';

if (!PASS) {
  console.error('❌ 需要 DT_PASS=<password>');
  process.exit(1);
}
if (!DATA_DIR) {
  console.error('❌ 需要 DT_DATA_DIR=<实例数据目录>，脚本要写入 config/embedding.json 与 rag.json');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(msg) {
  console.log(`ℹ️  ${msg}`);
}

const DIM = 64;

/** 确定性单位向量：同样的文本永远得到同样的向量。 */
function fakeVector(text, dim = DIM) {
  const out = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % dim] += text.codePointAt(i) % 97;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

/**
 * 桩模型给出的问题。
 *
 * 刻意带上「退相干」这个**正文里绝不会出现**的词：这样"用问题检索到了分块"
 * 就只可能是问题索引的功劳。首行用标题生成，保证父块/子块各自的问题不一样。
 */
function questionsFor(prompt) {
  const main = /<main_content>([\s\S]*?)<\/main_content>/.exec(prompt)?.[1] ?? '';
  const topic = /^#{1,6}\s*(.+)$/m.exec(main)?.[1]?.trim() || '这段内容';
  return [
    `1. ${topic}的退相干时间应该怎么测量`,
    `2. ${topic}的温漂补偿步骤是什么`,
    `3. 仪器预热需要多久`,
  ].join('\n');
}

/** 起一个假 OpenAI 服务，返回 { url, close }。 */
function startStubLlm() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url?.endsWith('/embeddings')) {
        const { input } = JSON.parse(body || '{}');
        const list = Array.isArray(input) ? input : [input];
        return json({ data: list.map((t, index) => ({ index, embedding: fakeVector(t) })) });
      }
      if (req.url?.endsWith('/chat/completions')) {
        const { messages } = JSON.parse(body || '{}');
        return json({
          choices: [{ message: { content: questionsFor(messages?.[0]?.content ?? '') } }],
        });
      }
      res.writeHead(404).end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

/**
 * 把实例指向桩服务。直接写配置文件，等价于在「配置」页里填同一组值。
 *
 * 路径是 `DATA_DIR/config/`（`src/config.ts` 的 DATA_DIR = `DEEPTHINK_DATA_DIR`）——
 * 不是 `DATA_DIR/data/config`：源码注释里那个 `data/config/embedding.json` 指的是
 * **默认** DATA_DIR（`~/.deepthink/data`）下的相对位置，隔离实例下会被整体替换掉。
 */
function writeConfigs(stubUrl) {
  const cfgDir = path.join(DATA_DIR, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'embedding.json'),
    JSON.stringify({ baseUrl: stubUrl, apiKey: 'stub-key', model: 'stub-embed', dimensions: DIM }, null, 2),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(cfgDir, 'rag.json'),
    JSON.stringify({ model: 'stub-chat', temperature: 0.3, maxTokens: 1024 }, null, 2),
    { mode: 0o600 },
  );
}

/**
 * 一段填充正文。`n` 决定小节长度。
 *
 * 文档必须**长到真能切出父子两层**：父块 4096 字 / 子块 384 字（`src/kb/chunker.ts`
 * 的 DEFAULT_PARENT_CONFIG / DEFAULT_CHILD_CONFIG）。短文里父块与子块内容完全相同，
 * 上游语义 2 明确「只在真分裂时才建父块行」（`strategy.go`），所以短文看不到「父块」
 * 不是缺陷、是设计——短文档就不该有父块。拿短文测父子分块，测的是空气。
 */
function filler(subject, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(
      `${subject}第 ${i + 1} 项：记录环境温度、静置时间与读数偏差，偏差超过标称值千分之三的按查表法修正后重新记录。`,
    );
  }
  return out.join('');
}

const SECTIONS = [
  ['温漂补偿', '补偿表随仪器出厂附带，也可以在配置页重新导出。'],
  ['预热要求', '预热期间不要开始正式测量，可以先做零位检查。'],
  ['零位检查', '零位漂移是慢变量，单次超差先复测，连续三次超差才判故障。'],
  ['记录与归档', '每次测量留档原始读数与修正量，便于回溯同期环境条件。'],
  ['复检周期', '复检合格后重新起算周期，不合格的降级使用或送修。'],
  ['常见误差来源', '接线电阻、接地环路与附近大功率设备都是常见干扰源。'],
];

// 正文里**没有**「退相干」这个词 —— 桩生成的问题里有，这是本脚本的探针基础。
const DOC_MD = [
  '# 测量手册',
  '',
  '本章说明仪器的校准流程、常见误差来源与记录要求，适用于实验台在用的全部型号。',
  '',
  ...SECTIONS.flatMap(([heading, lead]) => [`## ${heading}`, '', lead + filler(heading, 12), '']),
].join('\n');

/**
 * 保证实例已有一个「看起来配置好了」的 Claude 供应商，否则前端会把每个页面
 * 重定向到 /setup/providers。只在缺的时候创建，幂等。
 */
async function ensureProviderConfigured(context) {
  const list = await context.request.get(`${BASE}/api/config/claude/providers`);
  if (list.ok()) {
    const body = await list.json().catch(() => null);
    const arr = Array.isArray(body) ? body : (body?.providers ?? []);
    if (arr.some((p) => p?.enabled && (p.anthropicApiKey || p.claudeCodeOauthToken || p.anthropicAuthToken))) {
      info('已有可用供应商，跳过占位配置');
      return;
    }
  }
  const res = await context.request.post(`${BASE}/api/config/claude/providers`, {
    data: { name: `e2e-placeholder-${Date.now().toString(36)}`, type: 'official', anthropicApiKey: 'sk-ant-e2e-placeholder', enabled: true },
  });
  info(`占位供应商创建：HTTP ${res.status()}`);
}

let step = 0;
async function shot(page, name) {
  step += 1;
  const file = path.join(OUT_DIR, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  info(`截图 ${path.relative(process.cwd(), file)}`);
}

/** 读取分块视图上所有预生成问题的文本。 */
async function readGeneratedQuestions(page) {
  const nodes = page.getByTestId('kb-chunk-questions');
  const n = await nodes.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = await nodes.nth(i).innerText();
    // 该区块首行是「预生成问题（N）· 只进向量索引…」的标题，后面才是条目。
    for (const line of text.split('\n').slice(1)) {
      const q = line.replace(/^[•\-*]\s*/, '').trim();
      if (q) out.push(q);
    }
  }
  return [...new Set(out)];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stub = await startStubLlm();
  info(`桩模型服务：${stub.url}`);
  writeConfigs(stub.url);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const stamp = Date.now().toString(36);
  const kbName = `P1 验收库 ${stamp}`;

  try {
    // ── 登录 ───────────────────────────────────────────────────
    const loginRes = await context.request.post(`${BASE}/api/auth/login`, {
      data: { username: USER, password: PASS },
    });
    if (!loginRes.ok()) {
      console.error(`❌ 登录失败 HTTP ${loginRes.status()}: ${await loginRes.text()}`);
      process.exit(1);
    }

    // 首装实例没有配置任何 Claude 供应商时，前端会把所有页面重定向到
    // /setup/providers 向导，知识库页面根本进不去。补一个占位供应商把向导绕开 ——
    // 知识库链路（嵌入 / 问答）走的是 embedding.json 与 rag.json，与这个供应商无关，
    // 它在这里只承担"让 needsSetup 变 false"这一个作用。
    await ensureProviderConfigured(context);

    // ── 1. 建库（走界面） ──────────────────────────────────────
    await page.goto(`${BASE}/knowledge-bases`, { waitUntil: 'networkidle' });
    check('知识库列表页可达（未被首导向导劫持）', page.url().includes('/knowledge-bases'), page.url());

    await page.getByRole('button', { name: /新建知识库/ }).click();
    await page.getByTestId('kb-create-name').fill(kbName);
    await page.getByTestId('kb-create-submit').click();
    // 创建成功后前端直接跳详情页，不停留在列表上。
    await page.waitForURL(/\/knowledge-bases\/[^/]+$/, { timeout: 30_000 });
    check('界面新建知识库', true, `${kbName} → ${page.url().split('/').pop()}`);
    await shot(page, 'kb-detail');

    // ── 2. 勾选父子分块并上传 ──────────────────────────────────
    const pcToggle = page.getByTestId('kb-parent-child');
    await pcToggle.waitFor();
    check('上传区有「父子分块」开关', await pcToggle.isVisible());
    await pcToggle.check();
    check('父子分块开关可勾选', await pcToggle.isChecked());

    const tmpFile = path.join(os.tmpdir(), `kb-p1-e2e-${stamp}.md`);
    fs.writeFileSync(tmpFile, DOC_MD);
    // ⚠️ 必须**点按钮**走真实入口，不能用 setInputFiles 直接给 input 赋值 ——
    // 那条路绕过了「点击按钮 → 转发给 input → 弹文件框」这一跳，而这一跳曾经真的坏过
    // （<label> 包 <Button> 时规范禁止转发，点击被吞，文件框不弹）。
    // 用 filechooser 事件则必须点得动按钮才能拿到句柄，坏掉时会在这里超时失败。
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 15_000 });
    await page.getByTestId('kb-upload-button').click();
    const chooser = await chooserPromise.catch(() => null);
    check('点「上传文档」能唤起文件选择框', chooser !== null);
    if (!chooser) throw new Error('上传按钮点不动：filechooser 未触发');
    await chooser.setFiles(tmpFile);

    // 等入库跑完（状态徽标跑到终态「就绪」）
    await page.getByTestId('kb-doc-row').first().waitFor({ timeout: 30_000 });
    await page
      .getByTestId('kb-doc-status')
      .first()
      .filter({ hasText: '就绪' })
      .waitFor({ timeout: 90_000 });
    check('文档上传并入库完成', true);
    await shot(page, 'kb-doc-ready');

    // ── 3. 分块视图能看到父块 / 子块标记 ───────────────────────
    await page.getByTestId('kb-tab-chunks').click();
    await page.getByTestId('kb-doc-select').selectOption({ index: 1 });
    await page.getByTestId('kb-chunk-card').first().waitFor({ timeout: 30_000 });
    const chunkCount = await page.getByTestId('kb-chunk-card').count();
    const parentBadges = await page.getByTestId('kb-chunk-type').filter({ hasText: '父块' }).count();
    const childBadges = await page.getByTestId('kb-chunk-type').filter({ hasText: '子块' }).count();
    check(
      '分块视图区分父块与子块',
      parentBadges > 0 && childBadges > 0,
      `共 ${chunkCount} 块 · 父块 ${parentBadges} · 子块 ${childBadges}`,
    );
    await shot(page, 'kb-chunks-parent-child');

    // ── 4. Doc2Query：启用 → 落库 → 生成 ───────────────────────
    await page.getByTestId('kb-tab-documents').click();
    const d2q = page.getByTestId('kb-doc2query-panel');
    await d2q.waitFor();
    check('文档页签有 Doc2Query 面板', await d2q.isVisible());

    await page.getByTestId('kb-doc2query-enabled').check();
    await page.getByTestId('kb-doc2query-count').fill('3');
    await page.getByTestId('kb-doc2query-count').blur();
    await page.waitForTimeout(800); // onBlur 才触发 PATCH

    // 刷新一次，确认配置落库而不是只活在组件 state 里。
    // 刷新后面板要等 store 重新 load() 才有 kb 对象，所以先等控件出现再断言。
    await page.reload({ waitUntil: 'networkidle' });
    const enabledBox = page.getByTestId('kb-doc2query-enabled');
    await enabledBox.waitFor({ timeout: 20_000 });
    check('Doc2Query 开关落库（刷新后仍为启用）', await enabledBox.isChecked());

    await page.getByTestId('kb-doc2query-run').click();
    const toastLoc = page.getByText(/生成完成|生成失败|未开启/).first();
    await toastLoc.waitFor({ timeout: 120_000 });
    const toastText = (await toastLoc.innerText()).replace(/\s+/g, ' ');
    check('点击生成问题有明确反馈且成功', /生成完成/.test(toastText), toastText);
    await shot(page, 'kb-doc2query-generated');

    // ── 5. 分块上真的挂上了问题 ────────────────────────────────
    await page.getByTestId('kb-tab-chunks').click();
    await page.getByTestId('kb-doc-select').selectOption({ index: 1 });
    await page.getByTestId('kb-chunk-questions').first().waitFor({ timeout: 30_000 });
    const questions = await readGeneratedQuestions(page);
    check('分块上显示预生成问题', questions.length > 0, `${questions.length} 条：${questions[0] ?? ''}`);
    await shot(page, 'kb-chunk-questions');

    // ── 6. 用问题本身检索 ──────────────────────────────────────
    // 前置条件：这句问法不在正文里。否则"搜到了"可能来自正文，用例就白测了。
    const probe = questions.find((q) => q.includes('退相干')) ?? questions[0] ?? '';
    const inBody = DOC_MD.includes(probe) || DOC_MD.includes('退相干');
    check('前置：探针问法不在文档正文里', probe.length > 0 && !inBody, probe);

    if (probe) {
      await page.getByTestId('kb-tab-search').click();
      await page.getByTestId('kb-search-input').fill(probe);
      await page.getByTestId('kb-search-button').click();
      await page.getByTestId('kb-search-hit').first().waitFor({ timeout: 30_000 });
      const hitText = await page.getByTestId('kb-search-hit').first().innerText();
      check(
        '预生成问题扩大了召回：命中分块正文而非问题本身',
        !hitText.includes('退相干'),
        hitText.split('\n').slice(0, 2).join(' / ').slice(0, 120),
      );
      await shot(page, 'kb-search-by-generated-question');
    }

    // ── 7. FAQ 库：建条目 → 用相似问题试检索 ───────────────────
    const faqName = `P1 FAQ 库 ${stamp}`;
    const STD_Q = '校准周期是多久';
    const SIM_Q = '这台仪器多久要重新标定一次';
    const ANSWER = '每十二个月校准一次，超期后读数的置信区间不再有效。';

    await page.goto(`${BASE}/knowledge-bases`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /新建知识库/ }).click();
    await page.getByTestId('kb-create-name').fill(faqName);
    await page.getByTestId('kb-create-type-faq').click();
    await page.getByTestId('kb-create-submit').click();
    await page.waitForURL(/\/knowledge-bases\/[^/]+$/, { timeout: 30_000 });
    check('界面新建 FAQ 型知识库', true, faqName);

    await page.getByTestId('kb-tab-faq').waitFor({ timeout: 20_000 });
    const tabIds = await page.locator('[data-testid^="kb-tab-"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')),
    );
    check(
      'FAQ 库隐藏「文档」「分块」页签',
      !tabIds.includes('kb-tab-documents') && !tabIds.includes('kb-tab-chunks'),
      tabIds.join(', '),
    );
    await shot(page, 'kb-faq-panel');

    // 索引方式先切成「仅问题 + 每个问题各一条向量」。理由：桩模型不是语义模型，
    // 只有「索引文本与查询文本逐字相同」才是可断言的判据。`question_only` 让索引
    // 文本就是裸问题（不带答案），`separate` 让相似问题各占一条向量——于是用相似
    // 问法试检索，命中的只可能是相似问题自己那条向量，判定不依赖任何模型质量。
    const patchFaq = () =>
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          /\/api\/paas\/knowledge-bases\//.test(r.url()) &&
          r.status() === 200,
        { timeout: 30_000 },
      );
    let patched = patchFaq();
    await page.getByTestId('kb-faq-index-mode').selectOption('question_only');
    await patched;
    patched = patchFaq();
    await page.getByTestId('kb-faq-question-index-mode').selectOption('separate');
    await patched;

    await page.getByTestId('kb-faq-create').click();
    await page.getByTestId('kb-faq-standard-question').fill(STD_Q);
    await page.getByTestId('kb-faq-similar-questions').fill(SIM_Q);
    await page.getByTestId('kb-faq-answers').fill(ANSWER);
    await page.getByTestId('kb-faq-save').click();
    await page.getByTestId('kb-faq-entry').filter({ hasText: STD_Q }).first().waitFor({ timeout: 30_000 });
    check('界面新建 FAQ 条目', true, STD_Q);

    // 下拉必须显示**已保存**的值。新建条目会刷新条目列表 → 面板重渲染，受控组件
    // 重新从 store 取 `kb.faqConfig`；store 若没回写 PATCH 的返回值，这里就会退回旧值，
    // 而服务端其实已经改了 —— 界面与库不一致，光看界面根本判断不出来。
    const modeNow = await page.getByTestId('kb-faq-index-mode').inputValue();
    const qModeNow = await page.getByTestId('kb-faq-question-index-mode').inputValue();
    check(
      '索引方式下拉与已保存值一致',
      modeNow === 'question_only' && qModeNow === 'separate',
      `${modeNow} / ${qModeNow}`,
    );
    await shot(page, 'kb-faq-entry-created');

    // 用只在「相似问题」里出现过的问法试检索：命中即证明相似问题进了索引
    await page.getByTestId('kb-faq-probe-input').fill(SIM_Q);
    await page.getByTestId('kb-faq-probe-run').click();
    const probeText = await page
      .getByTestId('kb-faq-probe-hit')
      .first()
      .innerText({ timeout: 30_000 })
      .catch(() => '');
    check(
      'FAQ 相似问题参与检索（试检索命中该条目）',
      probeText.includes(ANSWER.slice(0, 8)) || probeText.includes(STD_Q),
      probeText.replace(/\s+/g, ' ').slice(0, 120),
    );
    await shot(page, 'kb-faq-probe-hit');

    console.log('');
    const failed = results.filter((r) => !r.ok);
    console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exitCode = 1;
    }
    console.log(`截图目录：${OUT_DIR}`);
  } finally {
    await browser.close();
    stub.close();
  }
}

main().catch((err) => {
  console.error('❌ 脚本异常：', err);
  process.exit(1);
});
