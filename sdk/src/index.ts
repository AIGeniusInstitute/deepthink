/**
 * @deepthink/agent-sdk —— 把 Agent Studio 导出的 AgentBundle 嵌入任意 Node.js 应用。
 *
 * 快速上手：
 *   import { Agent } from '@deepthink/agent-sdk';
 *   const agent = await Agent.fromBundle('./my-agent.bundle.zip', {
 *     credentials: { apiKey: process.env.ANTHROPIC_API_KEY },
 *     workspace: './data/my-agent',
 *     onEvent: (e) => console.log(e.eventType, e.text ?? ''),
 *   });
 *   const r = await agent.run('帮我分析这份报告');
 */
export { Agent, Session } from './runtime.js';
export type {
  AgentOptions,
  AgentCredentials,
  RunResult,
  StartOptions,
} from './runtime.js';
export { loadBundle } from './bundle.js';
export type { LoadedBundle, BundleAgentDef, LoadBundleOptions } from './bundle.js';
export {
  computeContentHash,
  verifyContentHash,
  validateManifest,
  resolveSecretRefs,
  BUNDLE_SCHEMA_VERSION,
} from './agent-bundle.js';
export type { AgentBundleManifest, BundleSecretRef } from './agent-bundle.js';
export type { StreamEvent, StreamEventType } from './stream-event.types.js';
