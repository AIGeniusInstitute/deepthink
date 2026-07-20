/**
 * Graph Engineering slash command — /graph <definitionId>.
 *
 * Mirrors loop-commands.ts handleGoalCommand. Resolves the chat context
 * (owner/folder/chatJid) + loopDeps (structurally identical to GraphDeps —
 * same registeredGroups/getSessions/onProcess/broadcastStreamEvent/
 * storeResultAndNotify shape), starts a graph run, and kicks off executeGraph
 * in the background.
 */

import { logger } from '../logger.js';
import {
  buildRunContext,
  executeGraph,
  startGraphRun,
} from './graph-orchestrator.js';
import { toMermaid } from './graph-registry.js';
import type { LoopCommandDeps } from '../loop-commands.js';

/**
 * /graph <definitionId> — start a registered graph definition as a run.
 * The run executes in the background; the command returns immediately with
 * the run id.
 */
export async function handleGraphStartCommand(
  args: string,
  deps: LoopCommandDeps,
): Promise<string> {
  const definitionId = args.trim();
  if (!definitionId) {
    return '用法：/graph <definitionId>\n示例：/graph dev-workflow\n\n先用 Web → Graph 执行 注册图定义，再用其 id 启动。';
  }

  const started = startGraphRun({
    definitionId,
    ownerUserId: deps.ownerUserId,
    groupFolder: deps.groupFolder,
    chatJid: deps.chatJid,
  });
  if ('error' in started) {
    return `❌ 启动失败：${started.error}\n（定义 ${definitionId} 未注册，请先在 Web 注册）`;
  }

  const { runId, definition } = started;

  // loopDeps is structurally identical to GraphDeps — reuse it directly.
  const graphDeps = deps.loopDeps as unknown as Parameters<typeof executeGraph>[1];

  buildRunContext(runId, graphDeps).then((ctxRes) => {
    if (!ctxRes) {
      logger.error({ runId }, 'Graph start: context build failed');
      return;
    }
    executeGraph(ctxRes.ctx, graphDeps).catch((err) => {
      logger.error({ err, runId }, 'Graph run failed in background');
    });
  });

  const mermaid = toMermaid(definition).split('\n').slice(0, 6).join('\n');
  return [
    `📊 已启动图运行`,
    ``,
    `运行 ID：${runId}`,
    `定义：${definition.id}@v${definition.version}（${definition.nodes.length} 节点 / ${definition.edges.length} 边）`,
    ``,
    `执行图预览：`,
    '```mermaid',
    mermaid,
    '```',
    ``,
    `在 Web → Graph 执行 页查看实时可视化、中断/续跑/重跑。`,
  ].join('\n');
}
