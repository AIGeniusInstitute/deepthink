/**
 * Team list page — shows all teams with member count and task stats.
 * Create team modal + navigate to detail page.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Users, RefreshCw, ChevronRight } from 'lucide-react';
import { useStaffStore, type StaffTeam } from '../stores/staff';
import { PageHeader, EmptyState } from '@/components/common';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export function StaffTeamsPage() {
  const navigate = useNavigate();
  const { teams, loading, loadTeams, createTeam } = useStaffStore();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto">
      <PageHeader
        title="协作团队"
        subtitle="组建数字员工团队，分配任务，共享黑板"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => loadTeams()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> 创建团队
            </Button>
          </div>
        }
      />

      {loading ? (
        <SkeletonCardList count={4} />
      ) : teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title="还没有团队"
          description="创建你的第一个数字员工协作团队"
          action={
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> 创建团队
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
          {teams.map((team: StaffTeam) => {
            const stats = team.taskStats;
            return (
              <div
                key={team.id}
                className="rounded-xl border border-border bg-card p-4 hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => navigate(`/staff-teams/${team.id}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Users className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">{team.name}</h3>
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        {team.description || '无描述'}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>{team.memberCount ?? 0} 成员</span>
                  <span>{stats?.total ?? 0} 任务</span>
                  {stats && stats.done > 0 && (
                    <span className="text-green-600 dark:text-green-400">{stats.done} 已完成</span>
                  )}
                  {stats && stats.in_progress > 0 && (
                    <span className="text-blue-600 dark:text-blue-400">{stats.in_progress} 进行中</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowCreate(false)}>
          <div
            className="bg-background border border-border rounded-xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold mb-4">创建团队</h2>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">团队名称 *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                  placeholder="如：敏捷小组A"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">描述</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background min-h-[60px]"
                  placeholder="团队职责描述..."
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6">
              <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>取消</Button>
              <Button
                size="sm"
                disabled={!name.trim()}
                onClick={async () => {
                  const team = await createTeam(name.trim(), description);
                  if (team) {
                    toast.success('团队已创建');
                    setShowCreate(false);
                    setName('');
                    setDescription('');
                    navigate(`/staff-teams/${team.id}`);
                  } else {
                    toast.error('创建失败');
                  }
                }}
              >
                创建
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
