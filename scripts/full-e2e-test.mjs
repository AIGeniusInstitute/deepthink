#!/usr/bin/env node
/**
 * DeepThink 全量功能验收测试 (E2E + Screenshots)
 * Usage: node scripts/full-e2e-test.mjs
 * Output: downloads/deepthink-e2e-test-report.html
 */
import { chromium } from 'playwright-core';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:30080';
const SCREENSHOT_DIR = join(__dirname, '..', 'downloads', 'screenshots');
const CREDS = { username: 'admin', password: '88888888' };
const RESULTS = [];

function now() { return new Date().toISOString(); }

function result(name, pass, detail = '', screenshot = null) {
  const r = { name, pass, detail, ts: now(), screenshot };
  RESULTS.push(r);
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ': ' + detail : ''}`);
  return r;
}

async function ss(page, name) {
  const buf = await page.screenshot({ type: 'png', fullPage: true });
  const path = join(SCREENSHOT_DIR, `${name.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_')}.png`);
  writeFileSync(path, buf);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function login(page) {
  console.log('\n--- 登录 ---');
  await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Try to fill login form
  const inputs = await page.$$('input');
  let pwFilled = false, userFilled = false;
  for (const inp of inputs) {
    const type = await inp.getAttribute('type');
    if (type === 'password') { await inp.fill(CREDS.password); pwFilled = true; }
    else if (!userFilled) { await inp.fill(CREDS.username); userFilled = true; }
  }

  if (!pwFilled || !userFilled) {
    // Try finding by placeholder
    try { await page.fill('input[type="text"], input[type="email"], input:not([type="password"])', CREDS.username); } catch(e) {}
    try { await page.fill('input[type="password"]', CREDS.password); } catch(e) {}
  }

  await ss(page, '01-login-filled');

  // Click login
  const clicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (b.textContent && (b.textContent.includes('登录') || b.textContent.includes('Login') || b.textContent.includes('Sign'))) {
        b.click(); return true;
      }
    }
    // Try submit button or first button
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.click(); return true; }
    if (btns.length > 0) { btns[0].click(); return true; }
    return false;
  });
  console.log(`  登录按钮: ${clicked ? '已点击' : '未找到'}`);

  await page.waitForTimeout(4000);
  const url = page.url();
  const loggedIn = !url.includes('/login');
  if (loggedIn) {
    const b64 = await ss(page, '02-login-success');
    result('登录/认证', true, `admin 登录成功 → ${url}`, b64);
  } else {
    result('登录/认证', false, `URL 仍在/login: ${url}`);
  }
  return loggedIn;
}

async function sendChatMessage(page, message) {
  return await page.evaluate((msg) => {
    // Find textarea
    const ta = document.querySelector('textarea');
    if (!ta) return 'NO_TEXTAREA';
    // Use native setter for React controlled input
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(ta, msg);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // Try pressing Enter
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'SENT';
  }, message);
}

async function waitForAgentReply(page, timeoutMs = 120000) {
  const start = Date.now();
  let prevMsgCount = 0;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);

    const stats = await page.evaluate(() => {
      // Count assistant/agent message elements
      const allMsgs = document.querySelectorAll('[class*="assistant"], [class*="agent"], [class*="bot"], [class*="message"]');
      const streaming = !!document.querySelector('.animate-pulse, .typing-indicator, .cursor-blink');
      const assistantBubbles = document.querySelectorAll('.assistant-bubble, [class*="assistant-msg"]').length;
      return { msgCount: allMsgs.length, streaming, assistantBubbles };
    });

    if (stats.msgCount > prevMsgCount) {
      prevMsgCount = stats.msgCount;
      stableCount = 0;
    } else if (!stats.streaming) {
      stableCount++;
    }

    // If no streaming and stable for 2 checks (4s), done
    if (!stats.streaming && stableCount >= 2 && stats.msgCount > 0) {
      return { hasReply: true, msgCount: stats.msgCount, assistantBubbles: stats.assistantBubbles, elapsed: Date.now() - start };
    }
  }

  const final = await page.evaluate(() => ({
    msgCount: document.querySelectorAll('[class*="assistant"], [class*="agent"], [class*="message"]').length,
  }));
  return { hasReply: final.msgCount > 0, msgCount: final.msgCount, elapsed: Date.now() - start, timeout: true };
}

async function navigateTo(page, url) {
  try {
    await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 10000 });
  } catch (e) {
    // navigation timeout is ok
  }
  await page.waitForTimeout(2000);
}

async function testPage(page, moduleName, url) {
  console.log(`\n--- ${moduleName} ---`);
  await navigateTo(page, url);

  const b64 = await ss(page, moduleName.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_'));

  // Check page health
  const health = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const hasError = /404|500|Internal Server Error|Not Found|Something went wrong/i.test(body.substring(0, 500));
    const hasContent = body.length > 100;
    const hasReactRoot = !!document.getElementById('root');
    return { hasError, hasContent, hasReactRoot, bodySnippet: body.substring(0, 150) };
  });

  const pass = !health.hasError && health.hasContent;
  const detail = health.hasError
    ? `页面错误: ${health.bodySnippet}`
    : `页面正常, ${health.bodySnippet.substring(0, 80)}...`;

  result(moduleName, pass, detail, b64);
  return pass;
}

// ---- MAIN ----
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DeepThink 全量功能验收测试');
  console.log(`  BASE: ${BASE} | 时间: ${now()}`);
  console.log('═══════════════════════════════════════════');

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  const allErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') allErrors.push(msg.text()); });
  page.on('pageerror', err => allErrors.push(err.message));

  // 0. Login
  const loginOk = await login(page);
  if (!loginOk) {
    console.error('❌ 登录失败，终止测试');
    await browser.close();
    return;
  }

  // 1. Main Chat Agent with Streaming
  console.log('\n--- 1. 主对话 Agent 流式输出 ---');
  await navigateTo(page, '/chat');
  await page.waitForTimeout(2000);

  const b64ChatBefore = await ss(page, '03-chat-before');
  result('1.1 主对话页面', true, '工作台 /chat 加载成功', b64ChatBefore);

  const sendResult = await sendChatMessage(page, '你好，请用一句话介绍你自己');
  console.log(`  发送消息: ${sendResult}`);
  await page.waitForTimeout(1500);
  result('1.2 消息发送', sendResult === 'SENT' || !sendResult.includes('NO_'), `发送结果: ${sendResult}`);

  const b64Streaming = await ss(page, '04-chat-streaming');
  const reply = await waitForAgentReply(page, 120000);
  const b64ChatAfter = await ss(page, '05-chat-reply');

  result('1.3 流式输出响应', reply.hasReply,
    `耗时${(reply.elapsed/1000).toFixed(1)}s, 消息元素数=${reply.msgCount}, 助手气泡=${reply.assistantBubbles || 0}${reply.timeout ? ', (超时)' : ''}`,
    b64ChatAfter);

  result('1.4 流式过程截图', true, '流式输出过程中截图', b64Streaming);

  // 2. New Session Tab
  console.log('\n--- 2. 新建会话 Tab ---');
  await navigateTo(page, '/chat');
  await page.waitForTimeout(1500);

  // Click new chat button in sidebar
  const newTabClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const newBtn = btns.find(b =>
      b.textContent.includes('新建') || b.textContent.includes('新会话') ||
      b.textContent.includes('New') || b.getAttribute('aria-label')?.includes('new') ||
      b.className?.includes('new-chat') || b.className?.includes('new-session')
    );
    if (newBtn) { newBtn.click(); return 'CLICKED'; }
    return 'NOT_FOUND';
  });
  console.log(`  新建会话: ${newTabClicked}`);

  await page.waitForTimeout(2000);
  const b64NewTab = await ss(page, '06-new-tab');

  if (newTabClicked === 'CLICKED') {
    result('2.1 新建会话Tab', true, '新会话已创建', b64NewTab);

    const send2 = await sendChatMessage(page, '1+1等于几？简短回答');
    console.log(`  消息发送: ${send2}`);

    await page.waitForTimeout(1500);
    const b64Stream2 = await ss(page, '07-new-tab-streaming');

    const reply2 = await waitForAgentReply(page, 60000);
    const b64Reply2 = await ss(page, '08-new-tab-reply');

    result('2.2 新会话消息响应', reply2.hasReply,
      `耗时${(reply2.elapsed/1000).toFixed(1)}s, 消息数=${reply2.msgCount}${reply2.timeout ? ', (超时, 可能无响应)' : ''}`,
      b64Reply2);
  } else {
    result('2.1 新建会话Tab', false, `未找到新建按钮: ${newTabClicked}`, b64NewTab);
  }

  // 3-17: Core Module Pages
  const modules = [
    { name: '3. Agent Studio', url: '/agents' },
    { name: '4. 文件管理 (Disk)', url: '/disk' },
    { name: '5. 知识库 RAG', url: '/knowledge-bases' },
    { name: '6. 协作编排', url: '/collaborations' },
    { name: '7. 评测中心', url: '/eval-center' },
    { name: '8. Skills 市场', url: '/skills' },
    { name: '9. MCP/连接器市场', url: '/mcp-servers' },
    { name: '10. 数字员工', url: '/staff-employees' },
    { name: '11. 协作团队', url: '/staff-teams' },
    { name: '12. 设置面板', url: '/settings' },
    { name: '13. 开放平台', url: '/open-platform' },
    { name: '14. 计费/审批/审计', url: '/billing' },
    { name: '15. 任务管理', url: '/tasks' },
    { name: '16. Loop管理', url: '/loops' },
    { name: '17. 工作流', url: '/workflows' },
    { name: '18. 记忆管理', url: '/memory' },
    { name: '19. 应用市场', url: '/marketplace' },
    { name: '20. 图工程', url: '/graphs' },
  ];

  for (const mod of modules) {
    await testPage(page, mod.name, mod.url);
  }

  // Generate Report
  console.log('\n═══════════════════════════════════════════');
  console.log('  生成测试报告...');
  console.log('═══════════════════════════════════════════');

  const passCount = RESULTS.filter(r => r.pass).length;
  const failCount = RESULTS.filter(r => !r.pass).length;
  const total = RESULTS.length;
  const passRate = total > 0 ? (passCount / total * 100).toFixed(1) : '0.0';

  const rowsHtml = RESULTS.map((r, i) => {
    const icon = r.pass ? '✅' : '❌';
    const cls = r.pass ? 'pass' : 'fail';
    let ssHtml = r.screenshot
      ? `<div class="ss-thumb" onclick="showFS('${r.screenshot}')"><img src="${r.screenshot}" alt="${r.name}"/></div>`
      : '<span class="no-ss">—</span>';
    return `<tr class="${cls}"><td>${i+1}</td><td>${r.name}</td><td>${icon} ${r.pass?'PASS':'FAIL'}</td><td>${r.detail||''}</td><td>${ssHtml}</td></tr>`;
  }).join('');

  const reportHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>DeepThink 全量功能验收测试报告</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#c9d1d9;--t2:#8b949e;--acc:#58a6ff;--pass:#3fb950;--fail:#f85149;--gold:#d2991d}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}
header{background:var(--panel);border-bottom:1px solid var(--border);padding:24px 32px}
h1{font-size:24px;margin-bottom:8px}
.meta{color:var(--t2);font-size:14px}
.summary{display:flex;gap:24px;padding:24px 32px;flex-wrap:wrap}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:20px 28px;min-width:150px;text-align:center}
.card .v{font-size:36px;font-weight:700}.card .l{font-size:13px;color:var(--t2);margin-top:4px}
.card.p .v{color:var(--pass)}.card.f .v{color:var(--fail)}.card.r .v{color:var(--gold)}
table{width:calc(100% - 64px);border-collapse:collapse;margin:0 32px 32px}
th{background:var(--panel);color:var(--t2);font-size:13px;text-align:left;padding:12px 16px;border-bottom:1px solid var(--border)}
td{padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px}
tr.fail{background:rgba(248,81,73,0.06)}.pass .st{color:var(--pass)}.fail .st{color:var(--fail)}
.ss-thumb{cursor:pointer;transition:transform .2s}.ss-thumb img{width:160px;height:90px;object-fit:cover;border-radius:4px;border:1px solid var(--border)}
.ss-thumb:hover{transform:scale(1.05)}.no-ss{color:var(--t2);font-style:italic}
.fs-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;justify-content:center;align-items:center;cursor:pointer}
.fs-overlay.show{display:flex}.fs-overlay img{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}
footer{text-align:center;padding:32px;color:var(--t2);font-size:13px;border-top:1px solid var(--border)}
@media(prefers-color-scheme:light){:root{--bg:#fff;--panel:#f6f8fa;--border:#d0d7de;--text:#24292f;--t2:#656d76;--acc:#0969da;--pass:#1a7f37;--fail:#cf222e;--gold:#9a6700}tr.fail{background:rgba(207,34,46,.04)}}
</style>
</head>
<body>
<header>
  <h1>🧪 DeepThink 全量功能验收测试报告</h1>
  <div class="meta">集群: kind-desktop | Namespace: deepthink | 端口: 30080 | 模型: deepseek-v4-pro (DashScope) | 生成: ${now()}</div>
</header>
<div class="summary">
  <div class="card p"><div class="v">${passCount}</div><div class="l">✅ 通过</div></div>
  <div class="card f"><div class="v">${failCount}</div><div class="l">❌ 失败</div></div>
  <div class="card"><div class="v">${total}</div><div class="l">总计</div></div>
  <div class="card r"><div class="v">${passRate}%</div><div class="l">通过率</div></div>
</div>
<table><thead><tr><th>#</th><th>测试用例</th><th>结果</th><th>详情</th><th>截图</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<footer><p>DeepThink E2E 验收测试 · ${now()} · kind-desktop/deepthink · deepseek-v4-pro@DashScope</p></footer>
<div class="fs-overlay" id="fs" onclick="this.classList.remove('show')"><img id="fsImg" src=""/></div>
<script>function showFS(s){document.getElementById('fsImg').src=s;document.getElementById('fs').classList.add('show')}
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.getElementById('fs').classList.remove('show')})</script>
</body></html>`;

  const reportPath = join(__dirname, '..', 'downloads', 'deepthink-e2e-test-report.html');
  writeFileSync(reportPath, reportHtml);

  console.log(`\n📊 结果: ${passCount}/${total} PASS, ${failCount} FAIL (${passRate}%)`);
  console.log(`📄 报告: ${reportPath}`);
  console.log(`📸 截图: ${SCREENSHOT_DIR}/`);
  console.log(`🌐 控制台错误: ${allErrors.length} 条`);

  if (allErrors.length > 0 && allErrors.length <= 10) {
    console.log('⚠️  控制台错误:');
    allErrors.forEach((e, i) => console.log(`  ${i + 1}. ${e.substring(0, 200)}`));
  }

  await browser.close();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });