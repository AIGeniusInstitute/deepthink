/**
 * AgentBundle 加载器 —— 解包 / 完整性校验 / 密钥解析。
 *
 * 输入：bundle 目录或 .zip；输出：装配好的运行时数据（定义 / prompt /
 * skills 文件树 / MCP 配置）。任何校验失败都显式抛错（A1.2 / A6.3），
 * 不静默降级。
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

import {
  resolveSecretRefs,
  validateManifest,
  verifyContentHash,
  type AgentBundleManifest,
  type BundleSecretRef,
} from './agent-bundle.js';

export interface BundleAgentDef {
  id: string;
  name: string;
  description: string;
  kind: 'assistant' | 'orchestrator';
  systemPrompt: string;
  model: string | null;
  engine: string;
  maxTurns: number | null;
  temperature: number | null;
  validation?: Record<string, unknown>;
}

export interface LoadedBundle {
  manifest: AgentBundleManifest;
  agent: BundleAgentDef;
  /** prompts/system.md 全文（导出时固化的最终 system prompt） */
  systemPrompt: string;
  /** skillId → { relPath → content } */
  skills: Map<string, Map<string, string>>;
  /** MCP server 配置（secret 已解析为实际值） */
  mcpServers: Record<string, Record<string, unknown>>;
  /** 解析后仍缺失的必需密钥（A6.3：加载时显式报错，不留到这里） */
  warnings: string[];
}

export interface LoadBundleOptions {
  /** 显式密钥表（envName → value），优先于 process.env */
  secrets?: Record<string, string>;
  /** 允许跳过 contentHash 校验（仅调试用） */
  skipHashCheck?: boolean;
}

function lookupFrom(options: LoadBundleOptions): (name: string) => string | undefined {
  return (name) => {
    const explicit = options.secrets?.[name];
    if (explicit !== undefined && explicit !== '') return explicit;
    const fromEnv = process.env[name];
    return fromEnv === '' ? undefined : fromEnv;
  };
}

/** 读目录为 { relPath → content }（正斜杠分隔）。 */
function readDirFiles(root: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of readDirFiles(root, rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(rel, fs.readFileSync(path.join(root, rel), 'utf-8'));
    }
  }
  return out;
}

/** 读 zip 为 { relPath → content }。 */
async function readZipFiles(zipPath: string): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if ((entry as { dir?: boolean }).dir) continue;
    out.set(name.replace(/\\/g, '/'), await (entry as JSZip.JSZipObject).async('string'));
  }
  return out;
}

/**
 * 加载 bundle。抛错情形：
 * - manifest 缺失 / schema 不合法
 * - contentHash 不匹配（篡改）
 * - 必需密钥缺失（manifest.secrets 中 optional=false 的引用无法解析）
 */
export async function loadBundle(
  bundlePath: string,
  options: LoadBundleOptions = {},
): Promise<LoadedBundle> {
  const stat = fs.statSync(bundlePath);
  const files = stat.isDirectory() ? readDirFiles(bundlePath) : await readZipFiles(bundlePath);

  const rawManifest = files.get('manifest.json');
  if (!rawManifest) throw new Error('invalid bundle: manifest.json missing');
  const mv = validateManifest(JSON.parse(rawManifest));
  if (!mv.ok || !mv.manifest) throw new Error(`invalid bundle: ${mv.error}`);
  const manifest = mv.manifest;

  if (!options.skipHashCheck) {
    const hv = verifyContentHash(manifest, files);
    if (!hv.ok) throw new Error(`bundle integrity check failed: ${hv.error}`);
  }

  const rawAgent = files.get('agent.json');
  if (!rawAgent) throw new Error('invalid bundle: agent.json missing');
  const agent = JSON.parse(rawAgent) as BundleAgentDef;

  const systemPrompt = files.get('prompts/system.md') ?? agent.systemPrompt ?? '';

  // skills 文件树
  const skills = new Map<string, Map<string, string>>();
  for (const [rel, content] of files) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(rel);
    if (!m) continue;
    let skillFiles = skills.get(m[1]);
    if (!skillFiles) {
      skillFiles = new Map();
      skills.set(m[1], skillFiles);
    }
    skillFiles.set(m[2], content);
  }

  // MCP 配置 + 密钥解析（A6.3：必需引用缺失 → 抛错并列清单）
  const rawMcp = files.get('mcp/servers.json');
  const mcpParsed = rawMcp ? (JSON.parse(rawMcp) as { servers: Record<string, Record<string, unknown>> }) : { servers: {} };
  const lookup = lookupFrom(options);
  const resolved = resolveSecretRefs(mcpParsed.servers, lookup);

  const optionalRefs = new Set(
    manifest.secrets.filter((s: BundleSecretRef) => s.optional).map((s) => s.ref),
  );
  const requiredMissing = resolved.missing.filter(
    (name) => !optionalRefs.has(`\${ENV:${name}}`),
  );
  if (requiredMissing.length > 0) {
    throw new Error(
      `missing required secrets: ${requiredMissing.map((n) => `\${ENV:${n}}`).join(', ')} — ` +
        `provide them via options.secrets or environment variables`,
    );
  }

  return {
    manifest,
    agent,
    systemPrompt,
    skills,
    mcpServers: resolved.value,
    warnings: [],
  };
}
