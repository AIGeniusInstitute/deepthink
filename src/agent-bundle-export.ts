/**
 * AgentBundle 导出器 —— 把 Agent Studio 的 agent 定义 + 资源本体打成自包含 bundle。
 *
 * 与既有三套「指针复制」机制（版本快照 / marketplace / share install）不同，
 * 导出器把 agent_mounts 指向的资源**本体内联**进包（skills 目录、MCP 配置），
 * 并把 MCP env/header 值全部脱敏为 `${ENV:...}` 引用（密钥不进包）。
 *
 * 输出：manifest.json + agent.json + prompts/system.md + skills/** + mcp/servers.json
 * 打包格式 zip（jszip，既有依赖）；contentHash 确定性（见 shared/agent-bundle.ts）。
 */
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';

import {
  computeContentHash,
  dedupeSecrets,
  redactEnvMap,
  redactHeadersMap,
  BUNDLE_SCHEMA_VERSION,
  type AgentBundleManifest,
  type BundleSecretRef,
} from './agent-bundle.js';
import { getAgentDefinitionById, listAgentMounts, listSkillsForUser } from './db.js';
import { loadUserMcpServers } from './mcp-utils.js';
import { getUserSkillsDir, getSkillContentPath } from './skill-content-utils.js';
import { logger } from './logger.js';

export interface ExportedBundle {
  zipBuffer: Buffer;
  manifest: AgentBundleManifest;
  sha256: string;
  warnings: string[];
}

type FileMap = Record<string, string>;

/** 读取 skill 目录下全部文本文件（SKILL.md 优先，含子目录）。 */
function readSkillDir(dir: string): FileMap {
  const out: FileMap = {};
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (entry.isFile()) {
        // 跳过备份/临时文件
        if (/\.bak\.|\.tmp/.test(entry.name)) continue;
        out[relPath] = fs.readFileSync(path.join(abs, entry.name), 'utf-8');
      }
    }
  };
  walk('');
  return out;
}

/**
 * 解析挂载的 skill 本体。来源优先级与 discoverSkills 一致：
 * 用户级目录 → 项目级容器 skills → DB builtin。
 */
function inlineSkill(
  skillId: string,
  userId: string,
  warnings: string[],
): FileMap | null {
  // 1) 用户级 / 项目级（SKILL.md 或 SKILL.md.disabled 所在目录）
  const contentPath = getSkillContentPath(userId, skillId);
  if (contentPath) {
    return readSkillDir(path.dirname(contentPath));
  }
  // 2) 项目级 container/skills/{skillId}
  const projectDir = path.resolve(process.cwd(), 'container', 'skills', skillId);
  if (fs.existsSync(projectDir)) {
    return readSkillDir(projectDir);
  }
  // 3) DB builtin
  try {
    const builtin = listSkillsForUser(userId).find(
      (r) => r.id === skillId && r.scope === 'builtin',
    );
    if (builtin?.content) {
      return { 'SKILL.md': builtin.content };
    }
  } catch {
    // DB 不可用时按缺失处理
  }
  warnings.push(`skill not found, skipped: ${skillId}`);
  return null;
}

/**
 * 导出 agent 为 AgentBundle（zip）。
 * @param agentDefId agent_definitions.id
 * @param ownerUserId 资源属主（skills / mcp-servers 的用户目录定位）
 */
export async function exportAgentBundle(
  agentDefId: string,
  ownerUserId: string,
): Promise<ExportedBundle> {
  const def = getAgentDefinitionById(agentDefId);
  if (!def) throw new Error(`agent definition not found: ${agentDefId}`);
  if (def.user_id !== ownerUserId) {
    throw new Error('agent definition does not belong to ownerUserId');
  }

  const warnings: string[] = [];
  const files: FileMap = {};
  const secrets: BundleSecretRef[] = [];

  // ---- agent.json（定义全字段 + validation 5 字段） ----
  files['agent.json'] = JSON.stringify(
    {
      id: def.id,
      name: def.name,
      description: def.description,
      kind: def.kind === 'orchestrator' ? 'orchestrator' : 'assistant',
      systemPrompt: def.system_prompt ?? '',
      model: def.model ?? null,
      engine: def.engine === 'atomcode' ? 'atomcode' : 'claude',
      maxTurns: def.max_turns ?? null,
      temperature: def.temperature ?? null,
      avatarEmoji: def.avatar_emoji ?? null,
      avatarColor: def.avatar_color ?? null,
      validation: {
        validationSchema: def.validation_schema ?? null,
        validationHookUrl: def.validation_hook_url ?? null,
        hookSecret: def.hook_secret ? '${ENV:BUNDLE_HOOK_SECRET}' : null,
        hookFailureAction: def.hook_failure_action ?? 'passthrough',
        onSchemaFail: def.on_schema_fail ?? 'passthrough',
      },
    },
    null,
    2,
  );
  if (def.hook_secret) {
    secrets.push({
      ref: '${ENV:BUNDLE_HOOK_SECRET}',
      usedBy: 'validation/hook',
      optional: false,
    });
  }

  // ---- prompts/system.md（最终 system prompt，所见即所得） ----
  files['prompts/system.md'] = def.system_prompt ?? '';

  // ---- mounts 展开：skills 本体 + MCP 配置脱敏 ----
  const mounts = listAgentMounts(agentDefId);
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const userMcp = loadUserMcpServers(ownerUserId);
  let skillCount = 0;
  let mcpCount = 0;

  for (const m of mounts) {
    if (m.resource_type === 'skill') {
      const skillFiles = inlineSkill(m.resource_id, ownerUserId, warnings);
      if (skillFiles) {
        for (const [rel, content] of Object.entries(skillFiles)) {
          files[`skills/${m.resource_id}/${rel}`] = content;
        }
        skillCount++;
      }
    } else if (m.resource_type === 'mcp_server') {
      const config = userMcp[m.resource_id];
      if (!config) {
        warnings.push(`mcp server not found, skipped: ${m.resource_id}`);
        continue;
      }
      const usedBy = `mcp/${m.resource_id}`;
      const entry: Record<string, unknown> = {};
      const isHttpType = config.type === 'http' || config.type === 'sse';
      if (isHttpType) {
        entry.type = config.type;
        entry.url = config.url;
        const hr = redactHeadersMap(
          (config.headers as Record<string, string>) ?? undefined,
          usedBy,
        );
        if (Object.keys(hr.redacted).length > 0) entry.headers = hr.redacted;
        secrets.push(...hr.secrets);
      } else {
        entry.command = config.command;
        if (config.args) entry.args = config.args;
        const er = redactEnvMap(
          (config.env as Record<string, string>) ?? undefined,
          usedBy,
        );
        if (Object.keys(er.redacted).length > 0) entry.env = er.redacted;
        secrets.push(...er.secrets);
      }
      if (typeof config.description === 'string') entry.description = config.description;
      mcpServers[m.resource_id] = entry;
      mcpCount++;
    }
    // knowledge_base：M0 非目标，跳过（预留 directory 位见技术方案 §4.1）
  }

  files['mcp/servers.json'] = JSON.stringify({ servers: mcpServers }, null, 2);

  // ---- manifest.json ----
  const tier: 'T0' | 'T1' = skillCount > 0 || mcpCount > 0 ? 'T1' : 'T0';
  const manifest: AgentBundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    agent: {
      id: def.id,
      name: def.name,
      kind: def.kind === 'orchestrator' ? 'orchestrator' : 'assistant',
    },
    requires: { tier, hostTools: [] },
    secrets: dedupeSecrets(secrets),
    runtime: {
      engines: ['claude'],
      sdkRange: '^1.0.0',
      nodeRange: '>=22',
      platform: 'any',
      mcpDeps: {},
    },
    contentHash: '', // 占位，下一步填
  };
  manifest.contentHash = computeContentHash(
    Object.entries(files).map(([p, c]) => [p, c] as [string, string]),
  );
  files['manifest.json'] = JSON.stringify(manifest, null, 2);

  // ---- 打 zip（确定性：按文件名排序添加；时间戳固定） ----
  const zip = new JSZip();
  const fixedDate = new Date('2026-01-01T00:00:00Z');
  for (const name of Object.keys(files).sort()) {
    zip.file(name, files[name], { date: fixedDate });
  }
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  logger.info(
    { agentDefId, skillCount, mcpCount, warnings: warnings.length },
    'agent bundle exported',
  );
  return { zipBuffer, manifest, sha256: manifest.contentHash, warnings };
}
