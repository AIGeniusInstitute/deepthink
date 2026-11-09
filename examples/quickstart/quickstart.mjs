/**
 * quickstart —— @deepthink/agent-sdk 端到端走查脚本（TC-9.1）。
 *
 * 用法：
 *   1. 从 Agent Studio 导出 bundle：Agent 详情页 → 「导出 SDK Bundle」→ my-agent.bundle.zip
 *      （走查用的 bundle 也可由 dev 侧 make-demo-bundle 生成，见 TEST_REPORT §6）
 *   2. export ANTHROPIC_API_KEY=sk-... [ANTHROPIC_BASE_URL=...]
 *   3. node quickstart.mjs ./my-agent.bundle.zip
 *
 * 覆盖：流式单轮 / 多轮会话 / skill 触发 / MCP 工具调用 / 跨实例 resume /
 * 篡改检测 / 缆钥缺失报错。
 */
import { Agent, loadBundle, createToolsServer } from '@deepthink/agent-sdk';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundlePath = process.argv[2] ?? './my-agent.bundle.zip';
const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.join(here, 'data', 'workspace');

// bundle 的 MCP echo 工具引用了 ${ENV:DEMO_TOKEN}；显式提供（缺失时最后有负向演示）
const SECRETS = { DEMO_TOKEN: process.env.DEMO_TOKEN || 'demo-token-123' };

const agent = await Agent.fromBundle(bundlePath, {
  credentials: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: process.env.ANTHROPIC_MODEL, // 非标准模型名的 provider 用它透传
  },
  workspace,
  secrets: SECRETS,
  onEvent: (e) => {
    if (e.eventType === 'text_delta') process.stdout.write(e.text ?? '');
    else if (e.eventType === 'tool_use_start')
      console.log(`\n[tool] ${e.toolName} ${e.toolInputSummary ?? ''}`);
    else if (e.eventType === 'status') console.log(`\n[status] ${e.summary ?? ''}`);
  },
  toolsServer: createToolsServer({ workspace }),
});

// —— ① 流式单轮 ——
console.log('=== ① 流式单轮 ===');
const r1 = await agent.run('用一句话介绍你自己。');
console.log('\nusage:', r1.usage);

// —— ② 多轮会话（session API：send / wait）——
console.log('\n=== ② 多轮会话 ===');
const session = await agent.start({ prompt: '记住：项目代号是「灯塔」。确认收到即可。' });
await session.wait();
const r2 = await session.send('项目代号是什么？只回答代号。');
console.log('\n(应包含「灯塔」)');

// —— ③ skill 触发 ——
console.log('\n=== ③ skill 触发 ===');
await agent.run('用 numbered-list 技能列出 3 个 AI Agent 应用场景，只用编号列表。');
console.log('\n(应观察到 [tool] Skill 事件，输出为编号列表)');

// —— ④ MCP 工具调用（验证密钥注入）——
console.log('\n=== ④ MCP 工具调用 ===');
await agent.run('调用 echo 工具，text 参数为「灯塔」，把工具返回内容原样贴出来。');
console.log('\n(返回应包含 "echo: 灯塔 (token=...)")');

// —— ⑤ 跨实例 resume（模拟进程重启）——
console.log('\n=== ⑤ 跨实例 resume ===');
const agent2 = await Agent.fromBundle(bundlePath, {
  credentials: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: process.env.ANTHROPIC_MODEL,
  },
  workspace, // 同一 workspace → 自动 resume
  secrets: SECRETS,
  onEvent: (e) => {
    if (e.eventType === 'text_delta') process.stdout.write(e.text ?? '');
    else if (e.eventType === 'status') console.log(`\n[status] ${e.summary ?? ''}`);
  },
  toolsServer: createToolsServer({ workspace }),
});
const r5 = await agent2.run('我们之前约定的项目代号是什么？只回答代号。');
console.log(`\nresume 回答: ${r5.text}  (应包含「灯塔」)`);

// —— ⑥ 负向：篡改检测 ——
console.log('\n=== ⑥ 负向用例 ===');
const zip = await JSZip.loadAsync(fs.readFileSync(bundlePath));
const original = await zip.file('agent.json').async('string');
zip.file('agent.json', original.replace('"name"', '"hacked"'));
const tampered = await zip.generateAsync({ type: 'nodebuffer' });
const tamperedPath = path.join(here, 'data', 'tampered.bundle.zip');
fs.mkdirSync(path.dirname(tamperedPath), { recursive: true });
fs.writeFileSync(tamperedPath, tampered);
try {
  await loadBundle(tamperedPath);
  console.log('篡改检测：❌ 未拦截（不应出现）');
} catch (e) {
  console.log('篡改检测：✅ 拒绝加载 —', String(e.message).slice(0, 90));
}

// —— ⑦ 负向：必需密钥缺失 ——
const saved = process.env.DEMO_TOKEN;
delete process.env.DEMO_TOKEN;
try {
  await loadBundle(bundlePath, { secrets: {} });
  console.log('密钥缺失：❌ 未拦截（不应出现）');
} catch (e) {
  console.log('密钥缺失：✅ 显式报错 —', String(e.message).slice(0, 90));
}
if (saved !== undefined) process.env.DEMO_TOKEN = saved;

console.log('\n完成。');
