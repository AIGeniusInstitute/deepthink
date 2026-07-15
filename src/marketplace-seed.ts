/**
 * Marketplace seed: idempotent bootstrap of default templates.
 * Runs on server startup if the marketplace has zero items.
 *
 * Each item's payload is what installTemplate() clones into a user's
 * private resources. Tags help the marketplace UI filter.
 */

import type { MarketplaceItemRow } from './db.js';
import { countMarketplaceItems, createMarketplaceItem } from './db.js';
import { logger } from './logger.js';

interface SeedItem {
  item_type: 'agent_template' | 'mcp_template' | 'skill_template' | 'kb_template';
  name: string;
  description: string;
  author_name: string;
  tags: string[];
  payload: Record<string, unknown>;
}

const SEED: SeedItem[] = [
  {
    item_type: 'agent_template',
    name: '代码审查员',
    description: '专注代码质量审查，覆盖 OWASP Top 10、可读性、可维护性。',
    author_name: 'DeepThink',
    tags: ['code', 'review', 'security'],
    payload: {
      name: '代码审查员',
      description: '专注代码质量审查',
      system_prompt: '你是一名资深代码审查员。对每段代码做 OWASP Top 10、可读性、可维护性三维评估，输出可执行的修复清单。',
      model: null,
      engine: 'claude',
      avatar_emoji: '🛡️',
      avatar_color: '#0ea5e9',
      max_turns: null,
      temperature: null,
      mounts: [],
    },
  },
  {
    item_type: 'agent_template',
    name: '网页研究员',
    description: '使用 WebSearch / WebFetch 完成多轮网页检索与综合。',
    author_name: 'DeepThink',
    tags: ['web', 'research'],
    payload: {
      name: '网页研究员',
      description: '多轮网页检索与综合',
      system_prompt: '你是网页研究员。对每个问题先列 3 个检索角度，并行 WebSearch，再用 WebFetch 验证关键事实，最后给出带引用链接的总结。',
      model: null,
      engine: 'claude',
      avatar_emoji: '🔍',
      avatar_color: '#10b981',
      max_turns: null,
      temperature: null,
      mounts: [],
    },
  },
  {
    item_type: 'agent_template',
    name: '日报作家',
    description: '把对话历史浓缩成结构化日报（进展 / 决策 / 待办）。',
    author_name: 'DeepThink',
    tags: ['doc', 'summary'],
    payload: {
      name: '日报作家',
      description: '对话历史 → 结构化日报',
      system_prompt: '你是日报作家。读取最近对话，输出：今日进展 / 关键决策 / 明日待办。每条不超过 2 行，全篇不超过 300 字。',
      model: null,
      engine: 'claude',
      avatar_emoji: '📝',
      avatar_color: '#f59e0b',
      max_turns: null,
      temperature: null,
      mounts: [],
    },
  },
  {
    item_type: 'mcp_template',
    name: 'GitHub MCP',
    description: '官方 GitHub MCP server（stdio 模式，需 GITHUB_PERSONAL_ACCESS_TOKEN）。',
    author_name: 'DeepThink',
    tags: ['github', 'dev'],
    payload: {
      id: 'github',
      name: 'GitHub',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<your-token>' },
    },
  },
  {
    item_type: 'skill_template',
    name: 'think',
    description: '官方结构化推理 Skill（Anthropic 出品）。',
    author_name: 'Anthropic',
    tags: ['reasoning'],
    payload: { packageName: 'anthropic/think' },
  },
  {
    item_type: 'kb_template',
    name: '示例知识库',
    description: '一个示例知识库，包含一份 Markdown 入门文档。',
    author_name: 'DeepThink',
    tags: ['demo'],
    payload: {
      name: '示例知识库',
      description: '从市场安装的示例',
      documents: [
        {
          filename: 'welcome.md',
          content:
            '# 欢迎\n\n这是一个从市场安装的示例知识库。你可以在此基础上继续上传 .md / .txt 文档。\n\n## 用法\n\n在 Agent Studio 中把这个知识库挂到你的 Agent，Agent 就能通过 kb_search 工具检索到这里的内容。\n',
        },
      ],
    },
  },
];

export async function seedMarketplaceIfEmpty(): Promise<void> {
  try {
    const count = countMarketplaceItems();
    if (count > 0) return;
    logger.info({ count: SEED.length }, 'Seeding marketplace with default templates');
    for (const item of SEED) {
      createMarketplaceItem({
        item_type: item.item_type,
        name: item.name,
        description: item.description,
        author_name: item.author_name,
        tags: item.tags,
        payload: item.payload,
      });
    }
    logger.info('Marketplace seed complete');
  } catch (err) {
    logger.error({ err }, 'Marketplace seed failed');
  }
}

export type { MarketplaceItemRow };
