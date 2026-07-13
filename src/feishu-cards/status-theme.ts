import type { CardStatus } from './types.js';

/** Status-driven header theme. Must use Feishu v2 color enums — never CSS hex. */
export interface StatusTheme {
  template: 'blue' | 'violet' | 'orange' | 'red';
  tagColor: 'blue' | 'violet' | 'orange' | 'red';
  tagText: string;
}

const STATUS_THEMES: Record<CardStatus, StatusTheme> = {
  running: {
    template: 'blue',
    tagColor: 'blue',
    tagText: '生成中',
  },
  done: {
    template: 'violet',
    tagColor: 'violet',
    tagText: '完成',
  },
  warning: {
    template: 'orange',
    tagColor: 'orange',
    tagText: '部分成功',
  },
  error: {
    template: 'red',
    tagColor: 'red',
    tagText: '失败',
  },
};

export function resolveStatusTheme(status: CardStatus): StatusTheme {
  return STATUS_THEMES[status];
}
