#!/usr/bin/env node
// E2E test for #421: Interrupt should not cause loss of IPC-injected message
//
// Scenario (Claude Code-style queuing):
//   1. Send message A (triggers long-running operation)
//   2. While agent is processing, send message B
//   3. Click interrupt (Esc)
//   4. Verify message B still gets replied to
//
// Usage:
//   node tests/e2e/interrupt-ipc-message-loss.mjs <username> <password>

import WebSocket from 'ws';

const BASE = process.env.DEEPTHINK_URL || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const USERNAME = process.argv[2];
const PASSWORD = process.argv[3];
const JID = process.env.JID || 'web:main';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000', 10);

if (!USERNAME || !PASSWORD) {
  console.error('Usage: node interrupt-ipc-message-loss.mjs <username> <password>');
  process.exit(1);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No Set-Cookie header');
  return setCookie.split(';')[0];
}

async function api(cookie, method, path, body) {
  const opts = { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return (await fetch(`${BASE}${path}`, opts)).json();
}

function connectWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendMessage(ws, content) {
  ws.send(JSON.stringify({ type: 'send_message', chatJid: JID, content }));
}

function waitForStreamStart(ws, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error('Timeout stream start')); }, timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'stream_event' && msg.chatJid === JID) {
          clearTimeout(timer); ws.off('message', handler); resolve();
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

function waitForReplyContaining(ws, keyword, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout waiting for "${keyword}"`)); }, timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // DEBUG: log all incoming events
        if (msg.type === 'new_message' || msg.type === 'agent_reply') {
          console.log(`      [ws] type=${msg.type} chatJid=${msg.chatJid} is_from_me=${msg.is_from_me} sender=${msg.message?.sender} content="${(msg.message?.content || msg.text || '').substring(0, 60)}"`);
        }
        if (msg.type === 'new_message' && msg.chatJid === JID && msg.is_from_me) {
          if (msg.message?.sender === '__system__') return;
          const text = msg.message?.content || '';
          if (text.includes(keyword)) { clearTimeout(timer); ws.off('message', handler); resolve(text); }
        }
        if (msg.type === 'agent_reply' && msg.chatJid === JID) {
          const text = msg.text || '';
          if (text.includes(keyword)) { clearTimeout(timer); ws.off('message', handler); resolve(text); }
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function main() {
  console.log('=== E2E Test: Interrupt + IPC Injection (Issue #421) ===\n');
  console.log('[1/7] Login...');
  const cookie = await login();
  console.log('      OK');

  console.log('[2/7] Connect WS...');
  const ws = await connectWs(cookie);
  console.log('      OK\n');

  const kA = `MARKER_${Date.now()}_A`;
  const kB = `MARKER_${Date.now()}_B`;

  const msgA = `请执行 sleep 8 然后回复 ${kA}`;
  console.log(`[3/7] Send A: "${msgA}"`);
  sendMessage(ws, msgA);

  console.log('[4/7] Waiting for agent start...');
  await waitForStreamStart(ws);
  console.log('      Started');

  await new Promise(r => setTimeout(r, 3000));
  const msgB = `忽略上一条，直接回复 ${kB}`;
  console.log(`[5/7] Send B: "${msgB}"`);
  sendMessage(ws, msgB);

  await new Promise(r => setTimeout(r, 3000));
  console.log('[6/7] Interrupt...');
  const result = await api(cookie, 'POST', `/api/groups/${encodeURIComponent(JID)}/interrupt`);
  console.log(`      ${JSON.stringify(result)}\n`);

  console.log(`[7/7] Waiting for reply with "${kB}" (up to ${TIMEOUT_MS / 1000}s)...`);
  try {
    const text = await waitForReplyContaining(ws, kB, TIMEOUT_MS);
    console.log(`      Reply: "${text.substring(0, 120)}"`);
    console.log('\n✅ PASS');
    ws.close();
    process.exit(0);
  } catch (err) {
    console.log(`\n❌ FAIL: ${err.message}`);
    ws.close();
    process.exit(1);
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(2); });
