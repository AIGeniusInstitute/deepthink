/**
 * Agent Studio 前端回归验证（手工驱动，需要已跑起来的实例）。
 *
 * 覆盖 2026-10-09 修复的问题：
 *   1. 详情表单切换 Agent 不刷新 —— 名称/描述/System Prompt 用非受控 defaultValue，
 *      切到另一个 Agent 时 DOM 被复用、defaultValue 不重新应用，页面残留上一个 Agent
 *      的内容。现在 /agents 是卡片矩阵，点卡片进 /agents/:id 独立详情页，详情视图绑了
 *      key={agent.id} 强制重挂载。第 3 步就是这条的回归断言。
 *   2. /chat/agent/:agentId 语义化 URL（历史工作区 folder 仍是 agent-test-{id}，
 *      靠 jid 反查真实 folder）。
 *   3. 工作区标题不再带 "测试: " 前缀。
 *   4. 历史工作区必须被 **复用** 而不是被跳过：test-chat 若只认新 jid，会给同一 Agent
 *      另起一间空工作区，用户原有会话历史看不到（第 5 步断言）。
 *
 * ⚠️ 为什么这个脚本自己造 Agent：库里现成的两个 Agent 的 System Prompt **完全相同**
 *    （长度与内容都一致），拿它们做"切换后 prompt 是否刷新"的断言是没有区分度的——
 *    即使表单没刷新也会"通过"。所以脚本建两个 prompt 明确不同的临时 Agent 来做切换，
 *    并断言两者 prompt 必须不同（前提条件不成立就直接失败），用完删掉。
 *
 * 用法：
 *   make start-prod PORT=9911          # 起一个隔离实例（数据目录 ~/.deepthink-9911）
 *   DT_BASE=http://localhost:9911 DT_USER=admin DT_PASS='xxx' \
 *   DT_DATA_DIR=$HOME/.deepthink-9911 \
 *     node tests/e2e/agent-studio-ui.mjs
 *
 * 浏览器：用本机已安装的 Google Chrome（channel: 'chrome'），不下载 Playwright 自带内核。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.DT_BASE || 'http://localhost:9911';
const USER = process.env.DT_USER || 'admin';
const PASS = process.env.DT_PASS || '';
const OUT_DIR = process.env.DT_OUT || path.join(process.cwd(), 'logs', 'agent-studio-ui');
// 被测实例的数据目录（如 ~/.deepthink-9911）。设了才会做文件系统侧断言——E2E 是跨进程调用，
// 猜不出来，只能显式给。不给就只验 API/DB 侧。
const DATA_DIR = process.env.DT_DATA_DIR || '';

if (!PASS) {
  console.error('❌ 需要 DT_PASS=<password>');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 只读地记录一条事实，不计入通过/失败 */
function info(msg) {
  console.log(`ℹ️  ${msg}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const createdAgentIds = [];

  try {
    // ── 登录（走 API，cookie 落在同一个 context 里） ──────────────
    const loginRes = await context.request.post(`${BASE}/api/auth/login`, {
      data: { username: USER, password: PASS },
    });
    if (!loginRes.ok()) {
      console.error(`❌ 登录失败 HTTP ${loginRes.status()}: ${await loginRes.text()}`);
      process.exit(1);
    }

    // ── 找一个"只有历史工作区"的 Agent，用于验证复用 ──────────────
    // /api/groups 的 key 是 jid，历史工作区的 jid 形如 web:agent-test-{agentId}。
    const groupsRes = await context.request.get(`${BASE}/api/groups`);
    const { groups } = await groupsRes.json();
    const legacy = Object.entries(groups ?? {})
      .filter(([jid]) => jid.startsWith('web:agent-test-'))
      .map(([jid, g]) => ({ jid, folder: g.folder, agentId: jid.slice('web:agent-test-'.length) }))
      .find((x) => !groups[`web:agent-${x.agentId}`]); // 只挑没有新工作区的那条，结果才确定
    if (!legacy) {
      console.error('❌ 该实例没有"仅有历史工作区"的 Agent，无法验证工作区复用。请用生产库克隆起实例。');
      process.exit(1);
    }
    info(`历史工作区样例：${legacy.jid} (folder=${legacy.folder})`);

    // ── 造两个临时 Agent 做切换验证 ──────────────────────────────
    const stamp = Date.now().toString(36);
    const spec = [
      {
        name: `E2E 切换验证 A ${stamp}`,
        description: 'E2E 临时 Agent，验证详情表单切换是否刷新',
        system_prompt: `你是验证用 Agent A（${stamp}）。回答时必须先说 "ALPHA"。`,
        kind: 'assistant',
      },
      {
        name: `E2E 切换验证 B ${stamp}`,
        description: 'E2E 临时 Agent，验证详情表单切换是否刷新',
        system_prompt: `你是验证用 Agent B（${stamp}）。回答时必须先说 "BRAVO"，并且这段提示词的字符数与 A 不同，便于断言切换后确实换了内容。`,
        kind: 'assistant',
      },
    ];
    for (const s of spec) {
      const res = await context.request.post(`${BASE}/api/paas/agents`, { data: s });
      if (!res.ok()) {
        console.error(`❌ 创建临时 Agent 失败 HTTP ${res.status()}: ${await res.text()}`);
        process.exit(1);
      }
      const { agent } = await res.json();
      createdAgentIds.push(agent.id);
    }

    const listRes = await context.request.get(`${BASE}/api/paas/agents`);
    const { agents } = await listRes.json();
    const [a, b] = createdAgentIds.map((id) => agents.find((x) => x.id === id));
    info(`用 ${a.name} 和 ${b.name} 做切换验证`);

    // 前提条件：两者 prompt 必须不同，否则"切换后 prompt 刷新"这条断言没有区分度
    check(
      '前提：两个待切换 Agent 的 System Prompt 确实不同',
      a.systemPrompt !== b.systemPrompt && a.systemPrompt.length !== b.systemPrompt.length,
      `A=${a.systemPrompt.length} / B=${b.systemPrompt.length} 字符`,
    );

    // ── 1. /agents 是卡片矩阵，且名字已无 "测试: " 前缀 ────────────
    await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
    await page.getByText(a.name, { exact: true }).first().waitFor({ timeout: 15000 });
    const gridCards = page.getByTestId('agent-card');
    const cardCount = await gridCards.count();
    check('卡片矩阵渲染出全部 Agent', cardCount === agents.length, `${cardCount}/${agents.length} 张卡片`);
    const bodyText = await page.locator('body').innerText();
    check('列表里没有 "测试: " 前缀', !bodyText.includes('测试:'));
    await page.screenshot({ path: path.join(OUT_DIR, '1-agents-grid.png'), fullPage: true });

    // ── 2. 点卡片 → 跳 /agents/:id，表单是 A 的内容 ───────────────
    await gridCards.filter({ hasText: a.name }).first().click();
    await page.waitForURL(new RegExp(`/agents/${a.id}$`), { timeout: 10000 });
    check('/agents 点卡片跳到 /agents/:id', page.url().endsWith(`/agents/${a.id}`), page.url());

    const nameInput = page.locator('input[placeholder="Agent 名称"]');
    const promptBox = page.locator('textarea[placeholder="（留空则使用平台默认行为指令）"]');
    await nameInput.waitFor({ timeout: 10000 });
    const aName = await nameInput.inputValue();
    const aPrompt = await promptBox.inputValue();
    check('详情页显示 Agent A 的名称', aName === a.name, `输入框="${aName}" 期望="${a.name}"`);
    check('详情页显示 Agent A 的 System Prompt', aPrompt === a.systemPrompt, `长度 ${aPrompt.length}`);
    await page.screenshot({ path: path.join(OUT_DIR, '2-detail-a.png'), fullPage: true });

    // ── 3. 回列表 → 点 B 卡片 → 关键回归断言 ──────────────────────
    await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
    await page.getByTestId('agent-card').filter({ hasText: b.name }).first().click();
    await page.waitForURL(new RegExp(`/agents/${b.id}$`), { timeout: 10000 });
    await page.locator('input[placeholder="Agent 名称"]').waitFor({ timeout: 10000 });

    const bName = await page.locator('input[placeholder="Agent 名称"]').inputValue();
    const bPrompt = await page.locator('textarea[placeholder="（留空则使用平台默认行为指令）"]').inputValue();
    check('切换 Agent 后名称刷新为 B（原始 bug）', bName === b.name, `输入框="${bName}" 期望="${b.name}"`);
    check(
      '切换 Agent 后 System Prompt 刷新为 B（原始 bug）',
      bPrompt === b.systemPrompt,
      bPrompt === aPrompt
        ? `❌ 仍是 A 的 System Prompt（与 A 完全相同，${aPrompt.length} 字符）—— 表单没有刷新`
        : `已换为 B 的 System Prompt（${bPrompt.length} 字符，A 是 ${aPrompt.length} 字符）`,
    );
    check('名称不是残留的 A', bName !== a.name, `="${bName}"`);
    await page.screenshot({ path: path.join(OUT_DIR, '3-detail-b.png'), fullPage: true });

    // ── 4. 新 Agent：test-chat 用新命名，URL 是 /chat/agent/:id ────
    const tc = await context.request.post(`${BASE}/api/paas/agents/${a.id}/test-chat`);
    const tcBody = await tc.json();
    check('新工作区 folder 用 agent-{id}', tcBody.folder === `agent-${a.id}`, `folder=${tcBody.folder}`);
    check('新工作区标题没有 "测试: " 前缀', tcBody.name === a.name, `name="${tcBody.name}"`);

    await page.goto(`${BASE}/chat/agent/${a.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    check('/chat/agent/:id 没有被弹回 /chat', !page.url().endsWith('/chat'), page.url());
    const chatText = await page.locator('body').innerText();
    check('/chat/agent/:id 打开的是该 Agent 的工作区', chatText.includes(a.name));
    await page.screenshot({ path: path.join(OUT_DIR, '4-chat-agent-route.png'), fullPage: true });

    // ── 5. 历史工作区被复用，不另起新工作区 ───────────────────────
    const tcl = await context.request.post(`${BASE}/api/paas/agents/${legacy.agentId}/test-chat`);
    const tclBody = await tcl.json();
    check(
      '历史工作区被复用（不新建 agent-{id}）',
      tclBody.jid === legacy.jid && tclBody.folder === legacy.folder,
      `jid=${tclBody.jid} folder=${tclBody.folder}`,
    );
    const groupsAfter = (await (await context.request.get(`${BASE}/api/groups`)).json()).groups ?? {};
    check(
      '复用后没有凭空多出新工作区',
      !groupsAfter[`web:agent-${legacy.agentId}`],
      Object.keys(groupsAfter).filter((j) => j.includes(legacy.agentId)).join(', '),
    );

    // 历史 URL（folder 仍是 agent-test-{id}）必须还能打开
    await page.goto(`${BASE}/chat/agent-test-${legacy.agentId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    check('历史 URL /chat/agent-test-:id 仍可访问', !page.url().endsWith('/chat'), page.url());

    // ── 6. 删除 Agent 同时清理它的工作区 ─────────────────────────
    // 只删脚本自己建的 Agent——绝不动库里现成的 Agent。
    //
    // 文件系统侧先说清一件事：光调 test-chat 只会产生 groups/ 一个目录（没真正跑过容器）。
    // 所以这里把其余 5 个目录补建出来，让「6 个目录全部清掉」这条断言真的覆盖删除路径。
    // 不补建的话断言其实只验证了 groups/——若有人把路由改成只删 groups/ 而不调
    // removeFlowArtifacts，照样会通过，而 sessions/ipc/env/memory/extra 会在生产里泄漏。
    const AGENT_DIRS = ['groups', 'sessions', 'ipc', 'env', 'memory', 'extra'];
    const agentDirPath = (d) => path.join(DATA_DIR, d, `agent-${a.id}`);
    if (DATA_DIR) {
      for (const d of AGENT_DIRS) {
        fs.mkdirSync(agentDirPath(d), { recursive: true });
        fs.writeFileSync(path.join(agentDirPath(d), 'marker.txt'), 'e2e');
      }
      const missing = AGENT_DIRS.filter((d) => !fs.existsSync(agentDirPath(d)));
      check('前提：删除前 6 个目录都在（否则断言无区分度）', missing.length === 0, missing.join(', '));
    }

    const del = await context.request.delete(`${BASE}/api/paas/agents/${a.id}`);
    check('删除 Agent 返回成功', del.ok(), `HTTP ${del.status()}`);
    createdAgentIds.splice(createdAgentIds.indexOf(a.id), 1); // 别在 finally 里再删一次

    const groupsAfterDel = (await (await context.request.get(`${BASE}/api/groups`)).json()).groups ?? {};
    check(
      '删 Agent 后它的工作区从列表消失',
      !groupsAfterDel[`web:agent-${a.id}`],
      Object.keys(groupsAfterDel).filter((j) => j.includes(a.id)).join(', ') || '(无残留)',
    );

    // 文件系统侧：6 个 per-folder 目录必须都没了（DT_DATA_DIR 指向被删实例的数据目录时才查）
    if (DATA_DIR) {
      const leftovers = AGENT_DIRS.map(agentDirPath).filter((p) => fs.existsSync(p));
      check('删 Agent 后 6 个数据目录全部清掉', leftovers.length === 0, leftovers.join(', ') || '无残留');
    } else {
      info('未设 DT_DATA_DIR，跳过文件系统侧断言（只验了 API/DB 侧）');
    }
  } finally {
    // ── 清理临时 Agent ───────────────────────────────────────────
    for (const id of createdAgentIds) {
      const res = await context.request.delete(`${BASE}/api/paas/agents/${id}`);
      if (!res.ok()) console.log(`⚠️  临时 Agent ${id} 删除失败 HTTP ${res.status()}`);
    }
    if (createdAgentIds.length) info(`已清理 ${createdAgentIds.length} 个临时 Agent`);

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}（共 ${results.length} 项）`);
    console.log(`截图目录: ${OUT_DIR}`);
    process.exit(failed.length === 0 ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('❌ 运行异常:', err);
  process.exit(1);
});
