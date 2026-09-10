/**
 * Team detail page — three tabs: Members / Tasks / Blackboard.
 * Reuses useStaffStore for all data and actions.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Plus, Trash2, Pin, Archive, UserPlus } from 'lucide-react';
import { useStaffStore, type StaffTeamTask } from '../stores/staff';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

const TASK_STATUS_LABELS: Record<string, { label: string; color: string; next?: string }> = {
  pending: { label: '待处理', color: 'bg-gray-500/10 text-gray-600 dark:text-gray-400', next: 'in_progress' },
  in_progress: { label: '进行中', color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400', next: 'review' },
  review: { label: '评审中', color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', next: 'done' },
  done: { label: '已完成', color: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  rework: { label: '返工', color: 'bg-red-500/10 text-red-600 dark:text-red-400', next: 'in_progress' },
};

export function StaffTeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    currentTeam, currentTeamMembers, currentTeamTasks, currentTeamBlackboard,
    employees, loading, loadTeamDetail, loadEmployees,
    addTeamMember, removeTeamMember, createTask, updateTaskStatus,
    createBlackboardEntry, updateBlackboardEntry,
  } = useStaffStore();
  const [tab, setTab] = useState<'members' | 'tasks' | 'blackboard'>('members');

  useEffect(() => {
    if (id) {
      loadTeamDetail(id);
      loadEmployees();
    }
  }, [id, loadTeamDetail, loadEmployees]);

  if (!id) return null;
  if (loading && !currentTeam) {
    return <div className="p-6 text-center text-muted-foreground">加载中...</div>;
  }
  if (!currentTeam) {
    return <div className="p-6 text-center text-muted-foreground">团队不存在</div>;
  }

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/staff-teams')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{currentTeam.name}</h1>
          <p className="text-sm text-muted-foreground">{currentTeam.description || '无描述'}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadTeamDetail(id)}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {([
          { key: 'members', label: `成员 (${currentTeamMembers.length})` },
          { key: 'tasks', label: `任务 (${currentTeamTasks.length})` },
          { key: 'blackboard', label: `黑板 (${currentTeamBlackboard.length})` },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Members Tab */}
      {tab === 'members' && (
        <MembersTab
          teamId={id}
          members={currentTeamMembers}
          employees={employees}
          onAdd={addTeamMember}
          onRemove={removeTeamMember}
        />
      )}

      {/* Tasks Tab */}
      {tab === 'tasks' && (
        <TasksTab
          teamId={id}
          tasks={currentTeamTasks}
          members={currentTeamMembers}
          onCreate={createTask}
          onStatusChange={updateTaskStatus}
        />
      )}

      {/* Blackboard Tab */}
      {tab === 'blackboard' && (
        <BlackboardTab
          teamId={id}
          entries={currentTeamBlackboard}
          onCreate={createBlackboardEntry}
          onUpdate={updateBlackboardEntry}
        />
      )}
    </div>
  );
}

// --- Members Tab ---

function MembersTab({
  teamId, members, employees, onAdd, onRemove,
}: {
  teamId: string;
  members: ReturnType<typeof useStaffStore.getState>['currentTeamMembers'];
  employees: ReturnType<typeof useStaffStore.getState>['employees'];
  onAdd: (teamId: string, employeeId: string, role: string) => Promise<void>;
  onRemove: (teamId: string, employeeId: string) => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState('');
  const [role, setRole] = useState('member');
  const availableEmployees = employees.filter(
    (e) => !members.some((m) => m.employee_id === e.id),
  );

  return (
    <div>
      <div className="flex justify-between mb-4">
        <h3 className="font-medium text-sm">团队成员</h3>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
          <UserPlus className="h-4 w-4 mr-1" /> 添加成员
        </Button>
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">还没有成员，点击添加</p>
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <div
              key={m.employee_id}
              className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{m.employee?.avatar_emoji || '🤖'}</span>
                <div>
                  <p className="font-medium text-sm">{m.employee?.name ?? '未知员工'}</p>
                  <p className="text-xs text-muted-foreground">{m.employee?.role ?? ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  m.role === 'leader' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {m.role === 'leader' ? '队长' : '成员'}
                </span>
                <Button
                  variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                  onClick={() => onRemove(teamId, m.employee_id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-background border border-border rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">添加成员</h2>
            {availableEmployees.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有可添加的员工，请先创建数字员工</p>
            ) : (
              <>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium mb-1 block">选择员工</label>
                    <select
                      value={selectedEmp}
                      onChange={(e) => setSelectedEmp(e.target.value)}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                    >
                      <option value="">请选择...</option>
                      {availableEmployees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.avatar_emoji} {e.name} - {e.role}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">角色</label>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                    >
                      <option value="member">成员</option>
                      <option value="leader">队长</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 justify-end mt-6">
                  <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>取消</Button>
                  <Button
                    size="sm"
                    disabled={!selectedEmp}
                    onClick={async () => {
                      await onAdd(teamId, selectedEmp, role);
                      toast.success('成员已添加');
                      setShowAdd(false);
                      setSelectedEmp('');
                    }}
                  >
                    添加
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Tasks Tab ---

function TasksTab({
  teamId, tasks, members, onCreate, onStatusChange,
}: {
  teamId: string;
  tasks: StaffTeamTask[];
  members: ReturnType<typeof useStaffStore.getState>['currentTeamMembers'];
  onCreate: (teamId: string, input: {
    title: string; description?: string; assigneeId?: string | null; priority?: string;
  }) => Promise<void>;
  onStatusChange: (teamId: string, taskId: string, status: string) => Promise<boolean>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState('medium');

  return (
    <div>
      <div className="flex justify-between mb-4">
        <h3 className="font-medium text-sm">团队任务</h3>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> 创建任务
        </Button>
      </div>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">还没有任务</p>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => {
            const statusInfo = TASK_STATUS_LABELS[task.status] ?? {
              label: task.status, color: 'bg-muted text-muted-foreground',
            };
            return (
              <div key={task.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <h4 className="font-medium text-sm">{task.title}</h4>
                    {task.description && (
                      <p className="text-xs text-muted-foreground mt-1">{task.description}</p>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-1 rounded ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                  {task.assignee && (
                    <span>{task.assignee.avatar_emoji} {task.assignee.name}</span>
                  )}
                  <span className={
                    task.priority === 'high' ? 'text-red-500' :
                    task.priority === 'low' ? 'text-gray-400' : ''
                  }>
                    {task.priority === 'high' ? '高优先级' : task.priority === 'low' ? '低优先级' : '中优先级'}
                  </span>
                </div>
                {statusInfo.next && (
                  <Button
                    variant="outline" size="sm" className="text-xs h-7"
                    onClick={async () => {
                      const ok = await onStatusChange(teamId, task.id, statusInfo.next!);
                      if (ok) toast.success(`状态已更新为 ${TASK_STATUS_LABELS[statusInfo.next!]?.label}`);
                      else toast.error('状态更新失败');
                    }}
                  >
                    → {TASK_STATUS_LABELS[statusInfo.next!]?.label}
                  </Button>
                )}
                {task.events && task.events.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-muted-foreground cursor-pointer">
                      事件历史 ({task.events.length})
                    </summary>
                    <div className="mt-2 space-y-1">
                      {task.events.map((ev) => (
                        <div key={ev.id} className="text-xs text-muted-foreground flex gap-2">
                          <span className="text-muted-foreground/60">
                            {new Date(ev.created_at).toLocaleString('zh-CN')}
                          </span>
                          <span>{ev.event_type}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-background border border-border rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">创建任务</h2>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">标题 *</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                  placeholder="如：接口开发"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">描述</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background min-h-[60px]"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">分配给</label>
                <select
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                >
                  <option value="">不指定</option>
                  {members.map((m) => (
                    <option key={m.employee_id} value={m.employee_id}>
                      {m.employee?.avatar_emoji} {m.employee?.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">优先级</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                >
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6">
              <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>取消</Button>
              <Button
                size="sm"
                disabled={!title.trim()}
                onClick={async () => {
                  await onCreate(teamId, {
                    title: title.trim(),
                    description,
                    assigneeId: assigneeId || null,
                    priority,
                  });
                  toast.success('任务已创建');
                  setShowCreate(false);
                  setTitle('');
                  setDescription('');
                  setAssigneeId('');
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

// --- Blackboard Tab ---

function BlackboardTab({
  teamId, entries, onCreate, onUpdate,
}: {
  teamId: string;
  entries: ReturnType<typeof useStaffStore.getState>['currentTeamBlackboard'];
  onCreate: (teamId: string, content: string, tags?: string[]) => Promise<void>;
  onUpdate: (teamId: string, entryId: string, fields: { pinned?: boolean; archived?: boolean }) => Promise<void>;
}) {
  const [content, setContent] = useState('');
  const [tagsText, setTagsText] = useState('');

  const parseTags = (json: string): string[] => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="font-medium text-sm mb-3">写入黑板</h3>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background min-h-[60px]"
          placeholder="写入团队共享知识、决策、笔记..."
        />
        <div className="flex gap-2 mt-2">
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-background"
            placeholder="标签 (逗号分隔)"
          />
          <Button
            size="sm"
            disabled={!content.trim()}
            onClick={async () => {
              await onCreate(
                teamId,
                content.trim(),
                tagsText.split(',').map((s) => s.trim()).filter(Boolean),
              );
              toast.success('已写入黑板');
              setContent('');
              setTagsText('');
            }}
          >
            写入
          </Button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">黑板为空</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`rounded-lg border bg-card p-4 ${
                entry.pinned ? 'border-amber-500/30 bg-amber-500/5' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-sm whitespace-pre-wrap flex-1">{entry.content}</p>
                <div className="flex gap-1">
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    onClick={() => onUpdate(teamId, entry.id, { pinned: !entry.pinned })}
                  >
                    <Pin className={`h-3.5 w-3.5 ${entry.pinned ? 'fill-current text-amber-500' : ''}`} />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    onClick={() => onUpdate(teamId, entry.id, { archived: true })}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {parseTags(entry.tags_json).map((tag, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-muted">
                    {tag}
                  </span>
                ))}
                {entry.employee && (
                  <span>· {entry.employee.avatar_emoji} {entry.employee.name}</span>
                )}
                <span>· {new Date(entry.created_at).toLocaleString('zh-CN')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
