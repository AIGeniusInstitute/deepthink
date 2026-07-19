/**
 * Browser Use Agent — 自然语言驱动的浏览器自动化循环。
 *
 * 流程（见 docs/tech_solution F4）：
 *   截图 → 连同任务目标与可用动作集发给视觉 LLM(sdkQueryMessages)
 *   → 解析返回的 JSON 动作 → 调用 BrowserController 执行
 *   → 通过 broadcastSandboxAgentEvent 实时广播每一步 → 循环
 *   直到 LLM 返回 done/failed 或达到最大步数。
 *
 * 动作集：navigate / click / type / press / scroll / evaluate / done / failed
 *
 * 注意：成功率依赖视觉 LLM 能力；本模块保证循环框架与实时展示可用，
 * 失败时会给出原因并停止（符合 supervisor 原则：要么完成，要么明确失败）。
 */

import type { BrowserController } from './browser.js';
import { sdkQueryMessages, type AssistantContentBlock } from '../sdk-query.js';
import { broadcastSandboxAgentEvent } from '../web.js';
import { logger } from '../logger.js';

const MAX_STEPS = 12;
const STEP_TIMEOUT_MS = 90_000;

export interface AgentAction {
  type:
    | 'navigate'
    | 'click'
    | 'type'
    | 'press'
    | 'scroll'
    | 'evaluate'
    | 'done'
    | 'failed';
  url?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  script?: string;
  reason?: string;
}

interface AgentStep {
  runId: string;
  step: number;
  thought: string;
  action: AgentAction;
  result: string;
  screenshot?: string;
}

const SYSTEM_PROMPT = `你是一个浏览器自动化 Agent。你将看到当前浏览器页面的截图与用户任务目标。
你的任务是决定"下一步动作"以推进任务，直到完成。

可用动作（严格按 JSON 输出，不要输出 JSON 以外的内容）：
{
  "thought": "一句话说明你观察到了什么、为什么这样做",
  "action": {
    "type": "navigate" | "click" | "type" | "press" | "scroll" | "evaluate" | "done" | "failed",
    // navigate: "url": "https://..."
    // click: "x": <number>, "y": <number>  (页面像素坐标)
    // type: "text": "要输入的内容"  (输入到当前焦点元素)
    // press: "key": "Enter" | "Tab" | "Backspace" | "Escape"
    // scroll: "deltaX": <number>, "deltaY": <number>  (像素，正值向下/右)
    // evaluate: "script": "JS 表达式"  (只读信息采集，如 location.href / document.title)
    // done: 任务已完成
    // failed: 无法完成，附 "reason"
  }
}

规则：
1. 只输出一个 JSON 对象，不要 Markdown 代码块、不要解释。
2. 若任务已完成，action.type = "done"。
3. 若截图无法推进或缺少必要信息，action.type = "failed" 并给 reason。
4. 坐标基于截图尺寸，点击你判断的目标元素位置。
5. 每次只做一步。`;

/** 从模型文本中抠出 JSON 对象并解析。 */
function parseAction(raw: string | null): AgentAction | null {
  if (!raw) return null;
  let text = raw.trim();
  // 去掉 Markdown 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // 抠第一个 {...}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && obj.action && obj.action.type) {
      return obj.action as AgentAction;
    }
    // 有时模型把 thought/action 平铺
    if (obj && typeof obj === 'object' && obj.type) {
      return obj as AgentAction;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function executeAction(
  browser: BrowserController,
  action: AgentAction,
): Promise<string> {
  switch (action.type) {
    case 'navigate':
      if (!action.url) return 'navigate: 缺少 url';
      await browser.navigate(action.url);
      return `已导航到 ${action.url}`;
    case 'click':
      if (action.x == null || action.y == null) return 'click: 缺少坐标';
      await browser.clickAt(action.x, action.y);
      return `已点击 (${action.x}, ${action.y})`;
    case 'type':
      if (!action.text) return 'type: 缺少 text';
      await browser.typeText(action.text);
      return `已输入 ${action.text.slice(0, 50)}`;
    case 'press':
      if (!action.key) return 'press: 缺少 key';
      await browser.pressKey(action.key);
      return `已按键 ${action.key}`;
    case 'scroll':
      await browser.scroll(action.deltaX ?? 0, action.deltaY ?? 0);
      return `已滚动 (${action.deltaX ?? 0}, ${action.deltaY ?? 0})`;
    case 'evaluate':
      if (!action.script) return 'evaluate: 缺少 script';
      const value = await browser.evaluate(action.script);
      return `执行结果: ${JSON.stringify(value).slice(0, 300)}`;
    case 'done':
      return '任务完成';
    case 'failed':
      return `失败: ${action.reason ?? '未知原因'}`;
    default:
      return `未知动作类型: ${action.type}`;
  }
}

export interface RunOptions {
  maxSteps?: number;
  initialUrl?: string;
}

/**
 * 运行 Browser Use Agent。异步执行，通过 WS 广播步骤；返回一个 runId。
 * 调用方传入的 isStopped 函数用于外部中止。
 */
export function runBrowserAgent(opts: {
  sessionId: string;
  userId: string;
  goal: string;
  browser: BrowserController;
  runId: string;
  maxSteps?: number;
  initialUrl?: string;
  isStopped: () => boolean;
}): void {
  const {
    sessionId,
    userId,
    goal,
    browser,
    runId,
    maxSteps = MAX_STEPS,
    initialUrl,
    isStopped,
  } = opts;

  (async () => {
    try {
      if (initialUrl) {
        await browser.navigate(initialUrl).catch(() => {});
      }
      let lastResult = '';
      let done = false;
      for (let step = 1; step <= maxSteps; step++) {
        if (isStopped()) {
          broadcastSandboxAgentEvent(userId, {
            type: 'sandbox_browser_agent_done',
            sessionId,
            runId,
            status: 'stopped',
            summary: '用户已停止',
          });
          return;
        }
        // 截图（PNG，给视觉 LLM）
        const pngDataUrl = await browser.screenshot().catch(() => null);
        if (!pngDataUrl) {
          broadcastSandboxAgentEvent(userId, {
            type: 'sandbox_browser_agent_done',
            sessionId,
            runId,
            status: 'failed',
            summary: '截图失败，浏览器可能未启动或已崩溃',
          });
          return;
        }
        const base64 = pngDataUrl.slice(pngDataUrl.indexOf(',') + 1);

        const userContent: AssistantContentBlock[] = [
          {
            type: 'text',
            text: `任务目标: ${goal}\n\n上一步结果: ${lastResult || '（无，第一步）'}\n\n请给出下一步动作（仅 JSON）。`,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
        ];

        const raw = await sdkQueryMessages(
          [
            { role: 'user', content: userContent },
          ],
          { timeout: STEP_TIMEOUT_MS },
        );

        const action = parseAction(raw);
        if (!action) {
          const stepInfo: AgentStep = {
            runId,
            step,
            thought: '模型未返回可解析的 JSON 动作',
            action: { type: 'failed', reason: '模型响应无法解析' },
            result: raw ? raw.slice(0, 300) : '(空响应)',
            screenshot: pngDataUrl,
          };
          broadcastSandboxAgentEvent(userId, {
            type: 'sandbox_browser_agent_step',
            sessionId,
            ...stepInfo,
          });
          broadcastSandboxAgentEvent(userId, {
            type: 'sandbox_browser_agent_done',
            sessionId,
            runId,
            status: 'failed',
            summary: '模型响应无法解析为动作',
          });
          return;
        }

        let resultStr: string;
        try {
          resultStr = await executeAction(browser, action);
        } catch (e: any) {
          resultStr = `执行出错: ${e?.message ?? e}`;
        }
        lastResult = resultStr;

        broadcastSandboxAgentEvent(userId, {
          type: 'sandbox_browser_agent_step',
          sessionId,
          runId,
          step,
          thought: (raw ?? '').slice(0, 500),
          action,
          result: resultStr,
          screenshot: pngDataUrl,
        });

        if (action.type === 'done') {
          done = true;
          broadcastSandboxAgentEvent(userId, {
            type: 'sandbox_browser_agent_done',
            sessionId,
            runId,
            status: 'done',
            summary: '任务完成',
          });
          return;
        }
        if (action.type === 'failed') {
          broadcastSandboxAgentEvent(userId, {
            type: 'sandbox_browser_agent_done',
            sessionId,
            runId,
            status: 'failed',
            summary: action.reason ?? '任务失败',
          });
          return;
        }
        // 给页面一点时间渲染
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!done) {
        broadcastSandboxAgentEvent(userId, {
          type: 'sandbox_browser_agent_done',
          sessionId,
          runId,
          status: 'max_steps',
          summary: `已达到最大步数 ${maxSteps}，停止`,
        });
      }
    } catch (e: any) {
      logger.error({ err: e?.message }, 'browser agent loop error');
      broadcastSandboxAgentEvent(userId, {
        type: 'sandbox_browser_agent_done',
        sessionId,
        runId,
        status: 'failed',
        summary: `Agent 异常: ${e?.message ?? e}`,
      });
    }
  })();
}
