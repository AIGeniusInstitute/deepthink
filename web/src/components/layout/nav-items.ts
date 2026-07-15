import { MessageCircle, Clock4, Puzzle, Wallet, User, Repeat, GitBranch, Bot, BookOpen, ShoppingBag } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/agents', icon: Bot, label: 'Agent' },
  { path: '/knowledge-bases', icon: BookOpen, label: '知识库' },
  { path: '/marketplace', icon: ShoppingBag, label: '市场' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/loops', icon: Repeat, label: '循环' },
  { path: '/harness', icon: GitBranch, label: 'Harness' },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => {
    if (item.requiresBilling && !billingEnabled) return false;
    return true;
  });
}
