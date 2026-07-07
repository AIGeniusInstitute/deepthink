import type { GroupInfo } from '../types';

export type GroupEntry = GroupInfo & { jid: string };
export type DateSection = { label: string; items: GroupEntry[] };

/** Sort comparator: newest activity first. */
export function compareByLastActivity(a: GroupEntry, b: GroupEntry): number {
  return new Date(b.lastMessageTime || b.added_at).getTime() - new Date(a.lastMessageTime || a.added_at).getTime();
}

/** Bucket groups into date sections (today / last 7 days / earlier). */
export function groupByDate(items: GroupEntry[]): DateSection[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const sections: DateSection[] = [
    { label: '今天', items: [] },
    { label: '最近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  items.forEach((g) => {
    const time = new Date(g.lastMessageTime || g.added_at);
    if (time >= today) sections[0].items.push(g);
    else if (time >= weekAgo) sections[1].items.push(g);
    else sections[2].items.push(g);
  });
  return sections.filter((s) => s.items.length > 0);
}
