/**
 * Agent Group Chat 验收测试脚本
 *
 * 测试流程：
 * 1. 登录 DeepThink 系统
 * 2. 导航到 Agent Group Chat 页面
 * 3. 发送消息触发群组辩论
 * 4. 监测 WS 流式事件
 * 5. 检测 DOM 中的思考过程、流式文本、工具调用卡片
 * 6. 截图记录关键节点
 * 7. 生成测试结果 JSON
 */

const { chromium } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ─── Configuration ────────────────────────────────────────────
const BASE = 'http://127.0.0.1:9999';
const SWARM_JID = 'web:swarm:32e33766-7ebd-4584-b75a-70e5ad5c1bd4';
const OUT_DIR = '/home/me/deepthink/downloads/agent-group-chat-acceptance-test';
const USERNAME = 'admin';
const PASSWORD = '88888888';
const TIMEOUT = 180000; // 3 min timeout per test

// ─── Helpers ──────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function screenshot(page, name) {
  const fname = `${name}-${timestamp()}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, fname), fullPage: true });
  console.log(`  [screenshot] ${fname}`);
  return fname;
}

async function apiLogin() {
  // Get session cookie via API
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: USERNAME, password: PASSWORD });
    const req = http.request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
        resolve({ cookies, body: JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Test Results Collector ───────────────────────────────────
const testResults = [];

function addResult(tc, name, passed, details, screenshot) {
  testResults.push({
    testCase: tc,
    name,
    passed,
    details,
    screenshot: screenshot || null,
    timestamp: new Date().toISOString(),
  });
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${name}: ${typeof details === 'string' ? details : JSON.stringify(details).slice(0, 100)}`);
}

// ─── Main Test Runner ─────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('═══════════════════════════════════════════════');
  console.log('  Agent Group Chat 验收测试');
  console.log(`  BASE: ${BASE}`);
  console.log(`  SWARM: ${SWARM_JID}`);
  console.log(`  Start: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════\n');

  // Get session cookie via API first
  console.log('[setup] Logging in via API...');
  const { cookies } = await apiLogin();
  console.log(`[setup] Got ${cookies.length} cookies`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  // Set cookies from API login
  for (const c of cookies) {
    const [name, value] = c.split('=');
    await context.addCookies([{
      name, value,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: name.includes('session') || name.includes('token'),
      secure: false,
      sameSite: 'Lax',
    }]);
  }

  const page = await context.newPage();

  // ─── WS Event Collector ────────────────────────────────────
  const wsEvents = [];
  page.on('websocket', (ws) => {
    console.log('[ws] Connected to WebSocket');
    ws.on('framereceived', (frame) => {
      try {
        const data = JSON.parse(frame.payload?.toString?.() ?? '');
        if (data.type === 'stream_event' || data.type === 'group_stream_event') {
          const event = data.event || {};
          wsEvents.push({
            type: data.type,
            eventType: event.eventType || event.type,
            seatId: event.seatId,
            groupMessage: event.groupMessage ? {
              senderSeatId: event.groupMessage.senderSeatId,
              content: (event.groupMessage.content || '').slice(0, 80),
            } : null,
            time: Date.now(),
          });
        }
      } catch {}
    });
  });

  // ─── TC1: 页面加载 ────────────────────────────────────────
  console.log('\n── TC1: 页面加载 ──');
  const encJid = encodeURIComponent(SWARM_JID);
  const groupUrl = `${BASE}/agent-groups/${encJid}`;

  try {
    await page.goto(groupUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);
    await screenshot(page, 'tc1-page-load');

    // Check page elements
    const pageTitle = await page.title();
    const hasTextarea = await page.$('textarea') !== null;
    const hasGroupName = await page.textContent('body');
    const hasName = hasGroupName && hasGroupName.includes('验收测试群组');

    const tc1Passed = hasTextarea && hasName;
    addResult('TC1', '页面加载', tc1Passed,
      `title=${pageTitle}, textarea=${hasTextarea}, groupName=${hasName}`,
      'tc1-page-load');
  } catch (e) {
    addResult('TC1', '页面加载', false, `Error: ${e.message}`);
  }

  // ─── TC2 & TC3: 消息发送 + 流式输出 ─────────────────────
  console.log('\n── TC2-3: 消息发送 & 流式输出 ──');

  try {
    // Inject DOM mutation observer
    await page.evaluate(() => {
      window.__domEvents = [];
      window.__thinkingSeen = false;
      window.__streamSeen = false;
      window.__toolSeen = false;

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const text = (node.textContent || '').slice(0, 200);
            if (!text.trim()) continue;

            window.__domEvents.push({ time: Date.now(), tag: node.tagName, text });

            if (text.includes('思考过程') || text.includes('思考中')) {
              window.__thinkingSeen = true;
            }
            if (text.match(/^Agent #\d+/) || text.match(/观点分析专家/) || text.match(/批判性思维/)) {
              window.__streamSeen = true;
            }
            if (text.includes('入参') || text.includes('工具调用') || text.includes('tool_call')) {
              window.__toolSeen = true;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    // Send message
    const textarea = await page.$('textarea');
    if (!textarea) {
      addResult('TC2', '消息发送', false, 'No textarea found');
    } else {
      await textarea.click();
      await page.waitForTimeout(300);

      const msg = '请简短讨论：AI Agent 的安全边界应该如何设计？每个Agent用1-2句话发表观点。';
      await page.keyboard.type(msg, { delay: 5 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      console.log('[action] Message sent, waiting for responses...');
      await screenshot(page, 'tc2-message-sent');

      // Wait for streaming
      let streamingDetected = false;
      let messageCompleted = false;

      for (let tick = 0; tick < 60; tick++) {
        await page.waitForTimeout(3000);

        const domState = await page.evaluate(() => ({
          thinkingSeen: window.__thinkingSeen,
          streamSeen: window.__streamSeen,
          toolSeen: window.__toolSeen,
          eventCount: (window.__domEvents || []).length,
          lastEvents: (window.__domEvents || []).slice(-5),
        }));

        if (domState.thinkingSeen || domState.streamSeen) {
          streamingDetected = true;
          console.log(`  [${(tick+1)*3}s] Streaming: thinking=${domState.thinkingSeen} stream=${domState.streamSeen} tool=${domState.toolSeen} events=${domState.eventCount}`);
        }

        // Check for completed messages in WS events
        const completedCount = wsEvents.filter(e => e.eventType === 'group_message_created').length;
        if (completedCount >= 2 && tick > 5) {
          messageCompleted = true;
          console.log(`  [${(tick+1)*3}s] All agents completed (${completedCount} messages)`);
          break;
        }

        // Safety timeout
        if (tick > 40 && wsEvents.length > 5) {
          console.log(`  [${(tick+1)*3}s] Timeout - exiting wait loop`);
          break;
        }
      }

      await page.waitForTimeout(2000);
      await screenshot(page, 'tc3-streaming-result');

      // Report TC2 results
      addResult('TC2', '消息发送', wsEvents.length > 0,
        `WS events: ${wsEvents.length}, message sent through textarea`);

      // Report TC3 results
      const finalDom = await page.evaluate(() => ({
        thinkingSeen: window.__thinkingSeen,
        streamSeen: window.__streamSeen,
        toolSeen: window.__toolSeen,
        eventCount: (window.__domEvents || []).length,
      }));

      addResult('TC3', '流式输出', finalDom.streamSeen || finalDom.thinkingSeen,
        `thinking=${finalDom.thinkingSeen} stream=${finalDom.streamSeen} tool=${finalDom.toolSeen} events=${finalDom.eventCount}`);
    }
  } catch (e) {
    addResult('TC2-3', '消息发送&流式', false, `Error: ${e.message}`);
  }

  // ─── TC4: WS事件类型覆盖 ──────────────────────────────────
  console.log('\n── TC4: WS事件类型覆盖 ──');

  const eventTypes = {};
  for (const e of wsEvents) {
    eventTypes[e.eventType] = (eventTypes[e.eventType] || 0) + 1;
  }

  const requiredEvents = ['group_thinking_delta', 'group_message_delta', 'group_message_created', 'group_seat_status'];
  const coveredEvents = requiredEvents.filter(t => eventTypes[t]);
  const tc4Passed = coveredEvents.length >= 2;

  addResult('TC4', 'WS事件覆盖', tc4Passed,
    `covered=${coveredEvents.join(',')}, all types: ${JSON.stringify(eventTypes)}`);

  // ─── TC5: Token消耗显示 ──────────────────────────────────
  console.log('\n── TC5: Token消耗显示 ──');

  const tokenEvents = wsEvents.filter(e => e.eventType === 'group_token_usage');
  const hasTokenDisplay = await page.evaluate(() => {
    const body = document.body.textContent || '';
    return body.includes('token') || body.includes('Token') || body.includes('tokens');
  });

  addResult('TC5', 'Token消耗显示', tokenEvents.length > 0 || hasTokenDisplay,
    `tokenEvents=${tokenEvents.length}, tokenTextInDOM=${hasTokenDisplay}`);

  // ─── TC6: 多Agent完成 ────────────────────────────────────
  console.log('\n── TC6: 多Agent完成 ──');

  const completedMessages = wsEvents.filter(e => e.eventType === 'group_message_created');
  const seatIds = [...new Set(completedMessages.map(e => e.seatId))];

  addResult('TC6', '多Agent完成', completedMessages.length >= 2,
    `completed=${completedMessages.length}, uniqueSeats=${seatIds.join(',')}`);

  // ─── WS Events Summary ────────────────────────────────────
  console.log('\n── WS Events Summary ──');
  for (const [type, count] of Object.entries(eventTypes).sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  Total: ${wsEvents.length} events`);

  // ═══ Final Summary ════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════');
  console.log('  TEST RESULTS');
  console.log('═══════════════════════════════════════════════');
  for (const r of testResults) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} ${r.testCase} ${r.name}: ${r.details}`);
  }
  const passed = testResults.filter(r => r.passed).length;
  const total = testResults.length;
  console.log(`\n  ${passed}/${total} PASSED`);
  console.log('═══════════════════════════════════════════════');

  // Save results JSON for report generation
  const resultsJson = {
    passed, total,
    results: testResults,
    wsEventCount: wsEvents.length,
    wsEventTypes: eventTypes,
    swarmJid: SWARM_JID,
    baseUrl: BASE,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'test-results.json'), JSON.stringify(resultsJson, null, 2));
  console.log(`\n[output] Results saved to ${OUT_DIR}/test-results.json`);

  await browser.close();
  return resultsJson;
}

main().then(results => {
  process.exit(results.passed === results.total ? 0 : 1);
}).catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});