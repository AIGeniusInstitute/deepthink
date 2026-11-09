/**
 * make-demo-bundle —— 走查用 demo bundle 生成器（TC-9.1 开发侧等价物）。
 *
 * 与 Agent Studio「导出 SDK Bundle」走同一条导出链路（src/agent-bundle-export.ts），
 * 只是夹具用脚本构造（skill + 带密钥 env 的 stdio MCP）。产出 my-agent.bundle.zip。
 *
 * 用法（仓库根）：
 *   node node_modules/tsx/dist/cli.mjs examples/quickstart/make-demo-bundle.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data', 'demo-data');

// 必须在 import config/db 之前设置（config.ts 在模块加载时读取）
process.env.DEEPTHINK_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const { initDatabase, createAgentDefinition, addAgentMount } = await import('../../src/db.js');
const { exportAgentBundle } = await import('../../src/agent-bundle-export.js');

const USER_ID = 'demo-user';
initDatabase();

const def = createAgentDefinition(USER_ID, {
  name: '灯塔助手',
  description: '走查 demo agent',
  system_prompt:
    '你是「灯塔助手」，一个简洁的演示助手。回答尽量短。当被要求使用技能时，严格按技能指令输出。',
  model: 'xiaomi/mimo-v2.6-pro',
  engine: 'claude',
  max_turns: 30,
  temperature: 0.3,
  kind: 'assistant',
  enabled: true,
});

// —— skill 资源本体 ——
const skillDir = path.join(dataDir, 'skills', USER_ID, 'numbered-list');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  [
    '---',
    'name: numbered-list',
    'description: 把回答格式化为编号列表（1. 2. 3.），每项一句话',
    '---',
    '',
    '# numbered-list',
    '',
    '当用户要求使用本技能时：把你的回答组织为编号列表，每项一句话，不要额外解释。',
  ].join('\n'),
  'utf-8',
);
addAgentMount(def.id, 'skill', 'numbered-list');

// —— MCP 资源本体（echo server，env 带密钥，验证脱敏+注入） ——
const mcpDir = path.join(dataDir, 'mcp-servers', USER_ID);
fs.mkdirSync(mcpDir, { recursive: true });
fs.writeFileSync(
  path.join(mcpDir, 'servers.json'),
  JSON.stringify({
    servers: {
      echo: {
        command: 'node',
        args: [path.join(here, 'mcp-echo.mjs')],
        env: { DEMO_TOKEN: 'demo-secret-abc123' },
        enabled: true,
      },
    },
  }),
  'utf-8',
);
addAgentMount(def.id, 'mcp_server', 'echo');

const bundle = await exportAgentBundle(def.id, USER_ID);
const outPath = path.join(here, 'my-agent.bundle.zip');
fs.writeFileSync(outPath, bundle.zipBuffer);
console.log('bundle written:', outPath);
console.log('contentHash:', bundle.sha256);
console.log('warnings:', bundle.warnings);
