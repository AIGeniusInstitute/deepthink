/**
 * AgentGroupsListPage — grid overview of all Agent Swarm Groups.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Users,
  Clock,
  MessageCircle,
  Loader2,
  AlertCircle,
  Settings,
  Archive,
} from 'lucide-react';
import { useAgentGroupStore } from '@/stores/agent-group';
import { CreateGroupDialog } from '@/components/agent-group/CreateGroupDialog';

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '暂无活动';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    return `${days} 天前`;
  } catch {
    return '—';
  }
}

export function AgentGroupsListPage() {
  const navigate = useNavigate();
  const groups = useAgentGroupStore((s) => s.groups);
  const loading = useAgentGroupStore((s) => s.groupsLoading);
  const error = useAgentGroupStore((s) => s.groupsError);
  const fetchGroups = useAgentGroupStore((s) => s.fetchGroups);
  const deleteGroup = useAgentGroupStore((s) => s.deleteGroup);

  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="font-semibold text-foreground text-sm">Agent 群组</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            多 Agent 协作群组概览
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="size-3.5" />
          创建群组
        </button>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-500 justify-center py-12">
            <AlertCircle className="size-4" />
            {error}
            <button
              onClick={() => void fetchGroups()}
              className="text-xs underline hover:no-underline"
            >
              重试
            </button>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
            <div className="size-16 rounded-2xl bg-muted flex items-center justify-center">
              <Users className="size-8 text-muted-foreground/40" />
            </div>
            <div>
              <p className="text-sm text-foreground font-medium">暂无 Agent 群组</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                创建一个多 Agent 协作群组，让不同角色的 Agent
                在群聊中协同完成复杂任务。
              </p>
            </div>
            <button
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors mt-2"
            >
              <Plus className="size-3.5" />
              创建第一个群组
            </button>
          </div>
        )}

        {/* grid */}
        {!loading && groups.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {groups.map((g) => (
              <div
                key={g.jid}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/agent-groups/${g.jid}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(`/agent-groups/${g.jid}`);
                }}
                className="rounded-xl border border-border bg-card hover:border-ring/40 hover:shadow-sm transition-all cursor-pointer group"
              >
                <div className="p-4 space-y-3">
                  {/* top row */}
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-foreground truncate">
                        {g.name}
                      </h3>
                      {g.description && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                          {g.description}
                        </p>
                      )}
                    </div>

                    {/* status dot */}
                    <span className="shrink-0 size-2 rounded-full bg-green-500" title="活跃" />
                  </div>

                  {/* meta row */}
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="size-3" />
                      {g.seatCount ?? 0} 席位
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" />
                      {timeAgo(g.createdAt)}
                    </span>
                  </div>

                  {/* action row */}
                  <div className="flex items-center justify-between pt-1 border-t border-border/50">
                    <span className="text-[10px] text-muted-foreground">
                      {g.groupKind === 'swarm' ? '多 Agent 群组' : '群组'}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/agent-groups/${g.jid}`);
                        }}
                        className="size-6 rounded flex items-center justify-center hover:bg-accent transition-colors"
                        title="进入聊天"
                      >
                        <MessageCircle className="size-3 text-primary" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/agent-groups/${g.jid}`);
                        }}
                        className="size-6 rounded flex items-center justify-center hover:bg-accent transition-colors"
                        title="设置"
                      >
                        <Settings className="size-3 text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`确定要删除群组「${g.name}」吗？`)) {
                            void deleteGroup(g.jid);
                          }
                        }}
                        className="size-6 rounded flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                        title="删除"
                      >
                        <Archive className="size-3 text-red-400" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* create dialog */}
      <CreateGroupDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}