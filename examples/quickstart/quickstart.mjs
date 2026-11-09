/**
 * quickstart —— @deepthink/agent-sdk 最小可运行示例。
 *
 * 用法：
 *   1. 从 Agent Studio 导出 bundle：Agent 详情页 → 「导出 SDK Bundle」→ my-agent.zip
 *   2. export ANTHROPIC_API_KEY=sk-...
 *   3. node quickstart.mjs ./my-agent.zip
 *
 * 演示：一次性调用 + 多轮会话 + 流式事件 + resume（再跑一次同 workspace 自动续接）。
 */
import { Agent, createToolsServer } from '@deepthink/agent-sdk';

const bundlePath = process.argv[2] ?? './my-agent.bundle.zip';
const workspace = new URL('./data/quickstart-workspace/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const agent = await Agent.fromBundle(bundlePath, {
  credentials: { apiKey: process.env.ANTHROPIC_API_KEY },
  workspace,
  onEvent: (e) => {
    if (e.eventType === 'text_delta') process.stdout.write(e.text ?? '');
    else if (e.eventType === 'tool_use_start') console.log(`\n[tool] ${e.toolName} ${e.toolInputSummary ?? ''}`);
    else if (e.eventType === 'status') console.log(`\n[status] ${e.summary ?? ''}`);
  },
  toolsServer: createToolsServer({ workspace }),
});

// —— 一次性调用 ——
console.log('=== 一次性调用 ===');
const r1 = await agent.run('用一句话介绍你自己。');
console.log('\nusage:', r1.usage);

// —— 多轮会话（自动 resume；把本脚本再跑一次，第二场对话仍记得「灯塔」）——
console.log('\n=== 多轮会话 ===');
const session = await agent.start({ prompt: '记住：项目代号是「灯塔」。请确认收到。' });
await session.wait();
const r2 = await session.send('项目代号是什么？只回答代号。');
console.log('\n(应包含「灯塔」)');
await session.close();

// —— 错误处理示范 ——
console.log('\n=== 错误处理 ===');
try {
  await Agent.fromBundle(bundlePath + '.tampered.zip', {
    workspace,
    credentials: { apiKey: 'x' },
  });
} catch (e) {
  console.log('篡改检测（预期报错）:', e.message.slice(0, 100));
}
try {
  await Agent.fromBundle(bundlePath, {
    workspace,
    credentials: { apiKey: 'x' },
    secrets: {}, // 若 bundle 声明了必需密钥且未设环境变量 → 预期报错
  });
} catch (e) {
  console.log('密钥缺失（预期报错）:', e.message.slice(0, 100));
}

console.log('\n完成。');
