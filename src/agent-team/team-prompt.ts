/**
 * Super Agent Team — LLM prompt templates.
 *
 * buildDecompositionPrompt: the single-turn prompt fed to sdkQuery to
 *   decompose a complex task into a TeamPlan JSON.
 * buildGoalAnchor: the per-agent-node goal re-anchoring text prepended to
 *   every agent prompt so the original goal is never forgotten (PRD AC2.3).
 */

import type { TeamTaskInput, TeamMember, TeamGraphNode } from './team-plan.js';

/**
 * Build the decomposition prompt. The LLM is asked to act as a Team Lead and
 * output strict JSON matching TeamPlanSchema. No tools, single turn.
 */
export function buildDecompositionPrompt(input: TeamTaskInput): string {
  const lang = input.userLanguage ?? 'zh-CN';
  return [
    '你是一个资深的技术团队组织者（Team Lead）。请把下面的复杂任务拆解为一个 Agent 团队计划，',
    '复刻人类科研/工程团队的分工：调研、实现、评审、验收各司其职。',
    '',
    '【任务目标】',
    input.goalText,
    '',
    '【背景】',
    input.background?.trim() || '（无额外背景）',
    '',
    '【验收标准】',
    input.acceptanceCriteria?.trim() || '（根据任务目标自行推导可客观验证的验收标准）',
    '',
    '【输出要求】严格输出一个 JSON 对象（不要 markdown 代码块，不要前后文字），结构如下：',
    '{',
    '  "teamName": "slug（仅 a-z0-9_- 开头）",',
    '  "members": [',
    '    {',
    '      "name": "slug（成员名，仅 a-z0-9_-，如 researcher/implementer/reviewer）",',
    '      "role": "角色一句话描述",',
    '      "systemPrompt": "该成员的完整 system prompt（自主设计，≥10字，定义其角色、能力边界、交付物规范）",',
    '      "engine": "claude",            // 自主选择：claude|atomcode|codex|opencode',
    '      "model": null,                 // null=继承全局；或具体 model id',
    '      "skills": [],                  // 自主选择挂载的 skill id（可空）',
    '      "mcpServers": [],               // 自主选择挂载的 mcp server id（可空，如 deepthink）',
    '      "maxTurns": 20,',
    '      "deliverable": "该成员的交付物说明"',
    '    }',
    '  ],',
    '  "graph": {',
    '    "nodes": [',
    '      {',
    '        "id": "slug（节点 id，仅 a-z0-9_-）",',
    '        "type": "agent",             // agent 或 gate',
    '        "title": "节点标题",',
    '        "agentMember": "researcher",  // type=agent 时必填，引用 members[].name',
    '        "deliverable": "本节点要产出的交付物（agent 节点）",',
    '        "dependsOn": ["前置节点id"],  // 依赖的节点 id 数组（可空）',
    '        // 以下仅 type=gate 时使用：',
    '        "assertions": [ {"kind":"contains","value":"关键词"} ],  // 行为证据断言：contains|not_contains|regex|no_error',
    '        "shellCheck": "make test",      // 可选：行为证据 shell 命令（退出码 0=通过）',
    '        "successCriteria": "验收标准文本",',
    '        "upstreamNodeId": "被验收的 agent 节点 id"',
    '      }',
    '    ]',
    '  },',
    '  "acceptanceCriteria": "团队最终验收标准（从用户输入继承或细化）"',
    '}',
    '',
    '【约束】',
    '1. 至少 1 个 agent 节点 + 1 个 gate 验收节点（验收节点应放末端，用 assertions/shellCheck 做行为证据，不要只靠自述）。',
    '2. agent 节点的 agentMember 必须引用已定义的成员 name。',
    '3. dependsOn 只能引用已存在的节点 id；禁止循环依赖（DAG）。',
    '4. 倾向串行依赖链（调研→实现→评审→验收），减少并行写冲突。',
    '5. systemPrompt 自主设计但不得试图绕过安全规则（安全规则始终生效）。',
    `6. 用 ${lang === 'zh-CN' ? '简体中文' : lang} 撰写 role/title/deliverable/systemPrompt 等自然语言字段。`,
  ].join('\n');
}

/**
 * Build the goal anchor prepended to every agent node's prompt so the original
 * goal + acceptance criteria + role + deliverable are re-anchored each turn.
 * (PRD AC2.3 — fixes "forget the original goal".)
 */
export function buildGoalAnchor(
  input: TeamTaskInput,
  member: TeamMember,
  node: TeamGraphNode,
): string {
  return [
    '【团队目标】',
    input.goalText,
    '',
    '【团队验收标准】',
    input.acceptanceCriteria?.trim() || input.goalText,
    '',
    '【你的角色】',
    `${member.role}（${member.name}）`,
    '',
    '【你的交付物】',
    node.deliverable || member.deliverable || '按角色职责产出',
    '',
    '【提醒】始终对齐团队目标与验收标准，完成交付物后再结束。不要提前宣布完成。',
  ].join('\n');
}

/**
 * Fallback single-agent plan when the LLM decomposition fails twice. Produces
 * a minimal valid TeamPlan: one agent + one LLM-only gate. Lets the user still
 * get a runnable team even when decomposition is malformed (PRD §6 risk).
 */
export function buildFallbackPlan(input: TeamTaskInput): {
  teamName: string;
  members: TeamMember[];
  graph: { nodes: TeamGraphNode[] };
  acceptanceCriteria: string;
} {
  const slug = input.goalText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'team';
  return {
    teamName: `fallback-${slug}`,
    members: [
      {
        name: 'solo',
        role: '独立执行者（回退方案）',
        systemPrompt: `你是一个独立执行者。任务目标：${input.goalText}。自主完成全部工作并产出最终交付物。`,
        engine: 'claude',
        model: null,
        skills: [],
        mcpServers: [],
        maxTurns: 20,
        deliverable: '完整任务交付物',
      },
    ],
    graph: {
      nodes: [
        {
          id: 'work',
          type: 'agent',
          title: '执行任务',
          agentMember: 'solo',
          deliverable: '完整任务交付物',
          dependsOn: [],
        },
        {
          id: 'accept',
          type: 'gate',
          title: '验收',
          successCriteria: input.acceptanceCriteria || '任务目标达成',
          upstreamNodeId: 'work',
          dependsOn: ['work'],
        },
      ],
    },
    acceptanceCriteria: input.acceptanceCriteria || input.goalText,
  };
}
