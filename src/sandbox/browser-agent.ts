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
    | 'input_and_search'
    | 'done'
    | 'failed';
  url?: string;
  /** CSS 选择器（click/type 优先用 selector，比坐标更稳）。 */
  selector?: string;
  /** 复合动作 input_and_search 的提交按钮选择器。 */
  submit_selector?: string;
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

const SYSTEM_PROMPT = `你是一个浏览器自动化 Agent。你将看到当前浏览器页面的截图、当前 URL 与用户任务目标。
你的任务是决定"下一步动作"以推进任务，直到完成。

可用动作（只允许以下类型，禁止发明其它类型名）：
{
  "thought": "一句话说明你观察到了什么、为什么这样做",
  "action": {
    "type": "navigate" | "click" | "type" | "press" | "scroll" | "evaluate" | "input_and_search" | "done" | "failed",
    "selector": "CSS 选择器",          // click/type/input_and_search 用，优先于坐标
    "url": "https://...",              // navigate 用
    "text": "要输入的内容",             // type/input_and_search 用
    "submit_selector": "提交按钮选择器", // input_and_search 可选，省略则按回车提交
    "key": "Enter" | "Tab" | "Backspace" | "Escape",  // press 用
    "deltaX": 0, "deltaY": 200,        // scroll，像素，正值向下/右
    "script": "JS 表达式",             // evaluate，只读采集如 location.href
    "reason": "..."                    // failed 时说明原因
  }
}

各动作说明：
- navigate: 跳转到 url。**当前 URL 已给出，若已在目标页不要重复导航。**
- click: 点击目标元素。优先用 "selector"（如 "#kw"、".btn"）；确实无法用选择器时再用 "x"/"y" 坐标（基于截图像素）。
- type: 在输入框输入 text。优先用 "selector" 定位输入框（会被聚焦并清空后输入）。
- press: 按键。提交搜索常用 press Enter。
- input_and_search: 在 selector 指定的输入框输入 text，然后点 submit_selector（省略则按回车）。等价于 type+提交，**一步完成搜索提交**。
- scroll / evaluate / done / failed：同上。

规则：
1. 只输出一个 JSON 对象，不要 Markdown 代码块、不要解释文字、不要嵌套 steps 数组。
2. 不要发明 "search" / "fill" / "wait" / "screenshot" 等本列表外的动作类型。
3. 任务完成 → action.type = "done"。无法推进 → "failed" 并给 reason。
4. 每次只做一步。输入并提交搜索请用 input_and_search 一步完成。`;

/** 从模型输出中提取动作字段（兼容模型把字段扁平到顶层的写法）。 */
function buildAction(type: string, src: Record<string, any>): AgentAction {
  return {
    type: type as AgentAction['type'],
    ...(src.url != null && { url: String(src.url) }),
    ...(src.selector != null && { selector: String(src.selector) }),
    ...(src.submit_selector != null && {
      submit_selector: String(src.submit_selector),
    }),
    ...(src.x != null && { x: Number(src.x) }),
    ...(src.y != null && { y: Number(src.y) }),
    ...(src.text != null && { text: String(src.text) }),
    ...(src.key != null && { key: String(src.key) }),
    ...(src.deltaX != null && { deltaX: Number(src.deltaX) }),
    ...(src.deltaY != null && { deltaY: Number(src.deltaY) }),
    ...(src.script != null && { script: String(src.script) }),
    ...(src.reason != null && { reason: String(src.reason) }),
  };
}

/**
 * 从模型文本中抠出 JSON 对象并解析为动作。
 * 兼容三种实际出现的形态（不同模型/供应商对 schema 的遵循度不一）：
 *   A. 规范：{ "action": { "type": "navigate", "url": "..." } }
 *   B. 扁平：{ "action": "navigate", "url": "...", "reason": "..." }
 *      （模型把 action.type 简化成字符串 action，其余字段提到顶层）
 *   C. 顶层：{ "type": "navigate", "url": "..." }
 */
export function parseAction(raw: string | null): AgentAction | null {
  if (!raw) return null;
  let text = raw.trim();
  // 去掉 Markdown 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // 抠第一个 {...}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // A. action 为对象且带 type（顶层字段如 reason 也合并进来）
  if (obj.action && typeof obj.action === 'object' && obj.action.type) {
    return buildAction(obj.action.type, { ...obj, ...obj.action });
  }
  // B. action 为字符串（类型名），其余字段在顶层
  if (typeof obj.action === 'string') {
    return buildAction(obj.action, obj);
  }
  // C. 顶层直接带 type
  if (typeof obj.type === 'string') {
    return buildAction(obj.type, obj);
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
      if (action.selector) {
        await browser.click(action.selector);
        return `已点击 ${action.selector}`;
      }
      if (action.x == null || action.y == null) return 'click: 缺少 selector 或坐标';
      await browser.clickAt(action.x, action.y);
      return `已点击 (${action.x}, ${action.y})`;
    case 'type':
      if (!action.text) return 'type: 缺少 text';
      if (action.selector) {
        await browser.type(action.selector, action.text);
        return `已在 ${action.selector} 输入 ${action.text.slice(0, 50)}`;
      }
      await browser.typeText(action.text);
      return `已输入 ${action.text.slice(0, 50)}`;
    case 'input_and_search': {
      if (!action.text) return 'input_and_search: 缺少 text';
      if (!action.selector)
        return 'input_and_search: 缺少 selector（输入框）';
      await browser.type(action.selector, action.text);
      if (action.submit_selector) {
        await browser.click(action.submit_selector);
        return `已在 ${action.selector} 输入 ${action.text.slice(0, 50)} 并点击 ${action.submit_selector}`;
      }
      await browser.pressKey('Enter');
      return `已在 ${action.selector} 输入 ${action.text.slice(0, 50)} 并回车提交`;
    }
    case 'press':
      if (!action.key) return 'press: 缺少 key';
      await browser.pressKey(action.key);
      return `已按键 ${action.key}`;
    case 'scroll':
      await browser.scroll(action.deltaX ?? 0, action.deltaY ?? 0);
      return `已滚动 (${action.deltaX ?? 0}, ${action.deltaY ?? 0})`;
    case 'evaluate': {
      if (!action.script) return 'evaluate: 缺少 script';
      const value = await browser.evaluate(action.script);
      return `执行结果: ${JSON.stringify(value).slice(0, 300)}`;
    }
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

        // 当前页面上下文（避免模型重复导航、辅助判断）
        const curUrl = await browser.getCurrentUrl().catch(() => null);
        const curTitle = await browser.getTitle().catch(() => null);

        const userContent: AssistantContentBlock[] = [
          {
            type: 'text',
            text: `任务目标: ${goal}\n\n当前 URL: ${curUrl ?? '未知'}\n当前标题: ${curTitle ?? '未知'}\n上一步结果: ${lastResult || '（无，第一步）'}\n\n请给出下一步动作（只输出一个 JSON 对象）。`,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
        ];

        let raw = await sdkQueryMessages(
          [{ role: 'user', content: userContent }],
          { timeout: STEP_TIMEOUT_MS, systemPrompt: SYSTEM_PROMPT },
        );

        // 空响应/无法解析时，带纠正提示重试一次（模型偶发空回复）
        let action = parseAction(raw);
        if (!action) {
          const nudge: AssistantContentBlock[] = [
            {
              type: 'text',
              text: `上一条响应无法解析为 JSON 动作${raw ? '' : '（空响应）'}。请**只输出一个 JSON 对象**，形如 {"thought":"...","action":{"type":"input_and_search","selector":"#kw","text":"关键词"}}，不要代码块、不要解释、不要嵌套 steps。可用 type 仅限：navigate/click/type/press/scroll/evaluate/input_and_search/done/failed。`,
            },
          ];
          raw = await sdkQueryMessages(
            [{ role: 'user', content: nudge }],
            { timeout: STEP_TIMEOUT_MS, systemPrompt: SYSTEM_PROMPT },
          );
          action = parseAction(raw);
        }

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
