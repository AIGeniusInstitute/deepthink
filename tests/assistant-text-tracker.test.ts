import { describe, expect, test } from 'vitest';
import { AssistantTextTracker } from '../container/agent-runner/src/utils.js';

// Turn 内 assistant 文本分段：工具调用之间的过程旁白不进定稿正文，
// 定稿 = 最后一次 top-level tool_use 之后的文本（与 SDK result 字段 /
// Claude Code 最终回复语义一致）。
// 实测事故：glm-5.2 每次工具调用前输出一句过程叙述（"我先检查 opencli 状态"、
// "现在打开 X 主页"…），旧实现把 turn 内全部 text block 无分隔拼接为定稿，
// 一条 9524 字符回复中前 3340 字符全是旁白独白。
describe('AssistantTextTracker', () => {
  const text = (t: string) => ({ type: 'text', text: t });
  const toolUse = () => ({ type: 'tool_use' });

  test('纯文本无工具调用 → 定稿为全部文本', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('你好，')]);
    tracker.addContentBlocks([text('这是回复。')]);
    expect(tracker.pickFinalText(null)).toBe('你好，这是回复。');
  });

  test('旁白 → 工具 → 旁白 → 工具 → 报告：定稿只含报告', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('我先检查 opencli 状态。')]);
    tracker.addContentBlocks([toolUse()]);
    tracker.addContentBlocks([text('现在打开 X 主页。')]);
    tracker.addContentBlocks([toolUse()]);
    tracker.addContentBlocks([text('# 修正版调研报告\n\n完整结论…')]);
    expect(tracker.pickFinalText(null)).toBe('# 修正版调研报告\n\n完整结论…');
  });

  test('text 与 tool_use 在同一条消息（[text, tool_use]）→ text 归旁白', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('让我先看看工作区。'), toolUse()]);
    tracker.addContentBlocks([text('最终结论。')]);
    expect(tracker.pickFinalText(null)).toBe('最终结论。');
  });

  test('[tool_use, text] 顺序 → text 属于工具之后，进定稿', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([toolUse(), text('工具跑完了，结论如下。')]);
    expect(tracker.pickFinalText(null)).toBe('工具跑完了，结论如下。');
  });

  test('以工具调用收尾（最终段为空）→ 回退 SDK result', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('我来存档。'), toolUse()]);
    expect(tracker.pickFinalText('SDK 给的最终文本')).toBe('SDK 给的最终文本');
  });

  test('最终段与 SDK result 都空 → 回退最后一段旁白（挂起中间 turn 的状态说明）', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('先做初步排查。'), toolUse()]);
    tracker.addContentBlocks([text('三个调研任务已派出，等待完成。'), toolUse()]);
    expect(tracker.pickFinalText(null)).toBe('三个调研任务已派出，等待完成。');
    expect(tracker.pickFinalText('')).toBe('三个调研任务已派出，等待完成。');
  });

  test('全空 → null（主进程 if (result.result) 不发消息）', () => {
    const tracker = new AssistantTextTracker();
    expect(tracker.pickFinalText(null)).toBeNull();
    tracker.addContentBlocks([toolUse()]);
    expect(tracker.pickFinalText(undefined)).toBeNull();
  });

  test('纯空白 text block 不产生旁白段', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('\n\n  '), toolUse()]);
    expect(tracker.pickFinalText(null)).toBeNull();
  });

  test('addContentBlocks 返回是否含文本（供调用方更新 canonical uuid）', () => {
    const tracker = new AssistantTextTracker();
    expect(tracker.addContentBlocks([toolUse()])).toBe(false);
    expect(tracker.addContentBlocks([text('有文本')])).toBe(true);
    expect(tracker.addContentBlocks([{ type: 'thinking' }])).toBe(false);
  });

  test('reset 后不携带上一 turn 的文本（mid-query follow-up）', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('上一 turn 旁白。'), toolUse()]);
    tracker.addContentBlocks([text('上一 turn 定稿。')]);
    tracker.reset();
    expect(tracker.pickFinalText(null)).toBeNull();
    tracker.addContentBlocks([text('新 turn 定稿。')]);
    expect(tracker.pickFinalText(null)).toBe('新 turn 定稿。');
  });

  test('SDK result 不参与"取更长者"比较：定稿段存在时即使更短也优先', () => {
    const tracker = new AssistantTextTracker();
    tracker.addContentBlocks([text('很长很长的过程旁白'.repeat(50)), toolUse()]);
    tracker.addContentBlocks([text('短结论。')]);
    expect(tracker.pickFinalText('别的文本')).toBe('短结论。');
  });
});
