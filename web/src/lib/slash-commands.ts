/**
 * Slash command discovery for the chat input box.
 *
 * Combines a static list of SDK built-in commands with the user/project/external
 * Skills that are already loaded by the Skills store. Skills with
 * `userInvocable=false` are hidden — they activate via description matching,
 * not via direct slash invocation.
 */

import type { Skill } from '../stores/skills';

export interface SlashCommandItem {
  name: string;
  description: string;
  argumentHint: string;
  source: 'builtin' | 'skill';
}

const BUILTIN_SLASH_COMMANDS: Omit<SlashCommandItem, 'source'>[] = [
  { name: 'clear', description: '清空当前会话上下文', argumentHint: '' },
  { name: 'cost', description: '查看本次会话 token 消耗统计', argumentHint: '' },
  { name: 'skills', description: '列出当前可用的 Skills', argumentHint: '' },
  { name: 'recall', description: '总结最近对话要点', argumentHint: '' },
  { name: 'list', description: '查看所有工作区与对话列表', argumentHint: '' },
  { name: 'status', description: '查看当前工作区状态', argumentHint: '' },
  { name: 'ls', description: '/list 的简写', argumentHint: '' },
  { name: 'rc', description: '/recall 的简写', argumentHint: '' },
  { name: 'require_mention', description: '切换群聊 @mention 响应模式', argumentHint: 'true|false' },
];

export function buildSlashCommandList(skills: Skill[]): SlashCommandItem[] {
  const fromSkills: SlashCommandItem[] = skills
    .filter((s) => s.userInvocable && s.enabled)
    .map((s) => ({
      name: s.name,
      description: s.description,
      argumentHint: s.argumentHint || '',
      source: 'skill' as const,
    }));
  const builtins: SlashCommandItem[] = BUILTIN_SLASH_COMMANDS.map((c) => ({
    ...c,
    source: 'builtin' as const,
  }));
  // Builtins first — they are the most common entry points
  return [...builtins, ...fromSkills];
}

/**
 * Detect whether the cursor is currently positioned right after a slash-command
 * token (e.g. "/cos" or "/"). Returns the matched slash command fragment
 * (including the leading "/") and the offset where it starts, or null.
 */
export function detectSlashToken(
  text: string,
  cursorPos: number,
): { match: string; start: number } | null {
  const uptoCursor = text.slice(0, cursorPos);
  // Match a "/" at start of input or preceded by whitespace, followed by
  // [a-zA-Z0-9_-]*. The slash must be the first non-whitespace char of the
  // current "word" — prevents triggering inside URLs or paths.
  const re = /(?:^|\s)(\/[a-zA-Z0-9_-]*)$/;
  const m = re.exec(uptoCursor);
  if (!m) return null;
  const start = (m.index ?? 0) + (m[1] ? 0 : 0) + (m[0].length - m[1]!.length);
  return { match: m[1]!, start };
}

/**
 * Filter a slash command list by the prefix typed after "/".
 */
export function filterSlashCommands(
  list: SlashCommandItem[],
  prefix: string,
): SlashCommandItem[] {
  const q = prefix.toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * Replace the slash token at `start..cursorPos` in `text` with the completed
 * command name. If the command has an argumentHint, append a trailing space so
 * the user can immediately type the argument.
 */
export function completeSlashToken(
  text: string,
  start: number,
  cursorPos: number,
  command: SlashCommandItem,
): { text: string; cursorPos: number } {
  const before = text.slice(0, start);
  const after = text.slice(cursorPos);
  const suffix = command.argumentHint ? ' ' : '';
  const inserted = '/' + command.name + suffix;
  const next = before + inserted + after;
  return { text: next, cursorPos: before.length + inserted.length };
}
