import { MessageCircle, Puzzle, User, BookOpen, Bot, Server, KeyRound, Users, Briefcase, FolderOpen, FlaskConical, UserPlus } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/disk', icon: FolderOpen, label: '网盘' },
  { path: '/agent-groups', icon: UserPlus, label: 'Agent群组' },
  { path: '/agents', icon: Bot, label: 'Agent' },
  { path: '/eval-center', icon: FlaskConical, label: '评测中心' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/mcp-servers', icon: Server, label: 'MCP' },
  { path: '/knowledge-bases', icon: BookOpen, label: '知识库' },
  { path: '/staff-employees', icon: Briefcase, label: '数字员工' },
  { path: '/staff-teams', icon: Users, label: '协作团队' },
  { path: '/open-platform', icon: KeyRound, label: '开放平台' },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => {
    if ((item as { requiresBilling?: boolean }).requiresBilling && !billingEnabled) return false;
    return true;
  });
}
