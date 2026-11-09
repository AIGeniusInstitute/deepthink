/**
 * M0.1 约束测试：AgentBundle 格式（F1）+ 平台导出（F2）。
 * 对应 PRD docs/prd/agent-runtime-sdk/PRD.md 测试用例：
 *   TC-1.1 bundle 结构与 schema
 *   TC-1.2 篡改检测（contentHash）
 *   TC-1.3 密钥脱敏（包内无明文密钥）
 *   TC-2.1 导出 API happy path
 *   TC-2.2 导出越权 403
 *   TC-2.3 导出确定性（contentHash 可重现）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

// ---- 隔离 DATA_DIR 到临时目录（skills / mcp-servers 都落这里） ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bundle-test-'));
const tmpDataDir = path.join(tmpDir, 'data');
const tmpStoreDir = path.join(tmpDataDir, 'db');
const tmpGroupsDir = path.join(tmpDataDir, 'groups');
for (const d of [tmpStoreDir, tmpGroupsDir]) fs.mkdirSync(d, { recursive: true });

vi.mock('../src/config.js', async () => {
  return {
    ASSISTANT_NAME: 'Test',
    DATA_DIR: tmpDataDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
    WEB_PORT: 19898,
    MAX_FILE_SIZE_MB: 50,
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    CONTAINER_IMAGE: 'deepthink-agent:latest',
    TIMEZONE: 'UTC',
    MOUNT_ALLOWLIST_PATH: path.join(tmpDir, 'mount-allowlist.json'),
    WEB_SESSION_SECRET: 'test-secret',
    TRUST_PROXY: false,
  };
});

const { initDatabase, createAgentDefinition, addAgentMount } = await import('../src/db.js');
const { exportAgentBundle } = await import('../src/agent-bundle-export.js');
const {
  computeContentHash,
  verifyContentHash,
  validateManifest,
  resolveSecretRefs,
  BUNDLE_SCHEMA_VERSION,
} = await import('../src/agent-bundle.js');

const USER_ID = 'user-export-test';

/** 构造测试夹具：1 个 skill + 含密钥 env 的 MCP + 含密钥 header 的 http MCP。 */
function setupFixtures(): string {
  // agent 定义
  const row = createAgentDefinition(USER_ID, {
    name: '导出测试 Agent',
    description: 'bundle export fixture',
    system_prompt: '你是测试助手。',
    model: 'claude-sonnet-4-5',
    max_turns: 10,
    temperature: 0.3,
    kind: 'assistant',
    enabled: true,
  });
  const id = row.id;

  // skill 资源本体（用户级目录）
  const skillDir = path.join(tmpDataDir, 'skills', USER_ID, 'test-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: 测试技能\n---\n\n按格式输出。',
    'utf-8',
  );
  addAgentMount(id, 'skill', 'test-skill');

  // MCP servers（含密钥）
  const mcpDir = path.join(tmpDataDir, 'mcp-servers', USER_ID);
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(
    path.join(mcpDir, 'servers.json'),
    JSON.stringify({
      servers: {
        'secret-server': {
          command: 'node',
          args: ['srv.js'],
          env: { API_KEY: 'sk-real-secret-value', EMPTY_VAR: '' },
          enabled: true,
        },
        'http-server': {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer real-token-123' },
          enabled: true,
        },
      },
    }),
    'utf-8',
  );
  addAgentMount(id, 'mcp_server', 'secret-server');
  addAgentMount(id, 'mcp_server', 'http-server');
  return id;
}

async function zipToFiles(zipBuffer: Buffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if ((entry as { dir?: boolean }).dir) continue;
    out.set(name, await (entry as JSZip.JSZipObject).async('string'));
  }
  return out;
}

let agentId: string;
let exportedZip: Buffer;
let exportedFiles: Map<string, string>;
let exportedManifest: Record<string, unknown>;

beforeAll(async () => {
  initDatabase();
  agentId = setupFixtures();
  const bundle = await exportAgentBundle(agentId, USER_ID);
  exportedZip = bundle.zipBuffer;
  exportedFiles = await zipToFiles(bundle.zipBuffer);
  exportedManifest = JSON.parse(exportedFiles.get('manifest.json')!);
});

afterAll(() => {
  // Windows：better-sqlite3 连接未关会占住临时目录，清理失败属环境噪音
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('TC-1.1 bundle 结构与 manifest schema', () => {
  it('必含项齐全：manifest / agent / prompts / skills / mcp', () => {
    expect(exportedFiles.has('manifest.json')).toBe(true);
    expect(exportedFiles.has('agent.json')).toBe(true);
    expect(exportedFiles.has('prompts/system.md')).toBe(true);
    expect(exportedFiles.has('skills/test-skill/SKILL.md')).toBe(true);
    expect(exportedFiles.has('mcp/servers.json')).toBe(true);
  });

  it('manifest 通过 schema 校验且 schemaVersion 正确', () => {
    const res = validateManifest(exportedManifest);
    expect(res.ok).toBe(true);
    expect(exportedManifest.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
  });

  it('agent.json 声明 systemPrompt（所见即所得）', () => {
    const agentJson = JSON.parse(exportedFiles.get('agent.json')!);
    expect(agentJson.systemPrompt).toBe('你是测试助手。');
    expect(exportedFiles.get('prompts/system.md')).toBe('你是测试助手。');
  });
});

describe('TC-1.2 篡改检测', () => {
  it('原包 contentHash 校验通过', () => {
    const manifest = validateManifest(exportedManifest).manifest!;
    const verify = verifyContentHash(manifest, exportedFiles);
    expect(verify.ok).toBe(true);
  });

  it('改动 skill 一字节后校验失败并给出明确错误', () => {
    const manifest = validateManifest(exportedManifest).manifest!;
    const tampered = new Map(exportedFiles);
    tampered.set('skills/test-skill/SKILL.md', tampered.get('skills/test-skill/SKILL.md')! + 'x');
    const verify = verifyContentHash(manifest, tampered);
    expect(verify.ok).toBe(false);
    expect(verify.error).toContain('contentHash mismatch');
    expect(verify.error).toContain('tampered');
  });

  it('contentHash 与 zip 打包顺序无关（确定性算法）', () => {
    const manifest = validateManifest(exportedManifest).manifest!;
    const reversed = new Map([...exportedFiles.entries()].reverse());
    expect(computeContentHash(reversed)).toBe(manifest.contentHash);
  });
});

describe('TC-1.3 密钥脱敏', () => {
  it('包内任何文件均不含明文密钥', () => {
    const all = [...exportedFiles.values()].join('\n');
    expect(all).not.toContain('sk-real-secret-value');
    expect(all).not.toContain('real-token-123');
  });

  it('mcp/servers.json 中 env/header 值为 ${ENV:...} 引用', () => {
    const mcp = JSON.parse(exportedFiles.get('mcp/servers.json')!);
    expect(mcp.servers['secret-server'].env.API_KEY).toBe('${ENV:API_KEY}');
    expect(mcp.servers['http-server'].headers.Authorization).toBe('${ENV:AUTHORIZATION}');
  });

  it('manifest.secrets 声明全部引用', () => {
    const secrets = exportedManifest.secrets as Array<{ ref: string; usedBy: string }>;
    const refs = secrets.map((s) => s.ref);
    expect(refs).toContain('${ENV:API_KEY}');
    expect(refs).toContain('${ENV:AUTHORIZATION}');
    // usedBy 指向消费方
    expect(secrets.find((s) => s.ref === '${ENV:API_KEY}')!.usedBy).toBe('mcp/secret-server');
  });

  it('resolveSecretRefs 能在加载端解析并报告缺失（optional 由调用方按 manifest 过滤）', () => {
    const mcp = JSON.parse(exportedFiles.get('mcp/servers.json')!);
    const full = resolveSecretRefs(mcp, (name) =>
      name === 'API_KEY' ? 'sk-loaded' : undefined,
    );
    expect(full.value.servers['secret-server'].env.API_KEY).toBe('sk-loaded');
    // 契约：resolveSecretRefs 报告全部未解析引用；调用方按 manifest.secrets
    // 的 optional 标记过滤后才决定是否报错（A6.3 只对必需引用硬失败）。
    const secrets = exportedManifest.secrets as Array<{ ref: string; optional: boolean }>;
    const required = new Set(
      secrets.filter((s) => !s.optional).map((s) => s.ref.replace(/^\$\{ENV:(.*)\}$/, '$1')),
    );
    const missingRequired = full.missing.filter((name) => required.has(name));
    expect(missingRequired).toEqual(['AUTHORIZATION']); // EMPTY_VAR 原值为空 → optional
  });
});

describe('TC-2.1/2.3 导出完整性与确定性', () => {
  it('zip 可解压且内容与文件 map 一致', async () => {
    const roundTrip = await zipToFiles(exportedZip);
    expect(roundTrip.get('manifest.json')).toBe(exportedFiles.get('manifest.json'));
  });

  it('重复导出 contentHash 一致（确定性）', async () => {
    const second = await exportAgentBundle(agentId, USER_ID);
    expect(second.sha256).toBe(exportedManifest.contentHash);
  });
});

describe('TC-2.2 导出越权（导出器属主校验）', () => {
  it('非属主 userId 导出被拒绝', async () => {
    await expect(exportAgentBundle(agentId, 'other-user')).rejects.toThrow(
      /does not belong/,
    );
  });
});
