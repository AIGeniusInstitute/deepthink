/**
 * Digital Employee management page. Card grid + create/edit modal + delete.
 */
import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, RefreshCw } from 'lucide-react';
import { useStaffStore, parseJsonArray, type StaffEmployee } from '../stores/staff';
import { PageHeader, EmptyState } from '@/components/common';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common';
import { toast } from 'sonner';

const ROLE_PRESETS = [
  { role: '前端开发', emoji: '👨‍💻' },
  { role: '后端开发', emoji: '🔧' },
  { role: '数据分析师', emoji: '📊' },
  { role: '技术文档工程师', emoji: '📝' },
  { role: '测试工程师', emoji: '🧪' },
  { role: '产品经理', emoji: '📋' },
];

export function StaffEmployeesPage() {
  const { employees, loading, loadEmployees, createEmployee, updateEmployee, deleteEmployee } = useStaffStore();
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<StaffEmployee | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StaffEmployee | null>(null);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto">
      <PageHeader
        title="数字员工"
        subtitle="管理企业数字员工 — 定义角色、人设、模型与技能绑定"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => loadEmployees()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => { setEditTarget(null); setShowCreate(true); }}>
              <Plus className="h-4 w-4 mr-1" /> 创建员工
            </Button>
          </div>
        }
      />

      {loading ? (
        <SkeletonCardList count={6} />
      ) : employees.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="还没有数字员工"
          description="创建你的第一个数字员工，定义角色和人设"
          action={
            <Button size="sm" onClick={() => { setEditTarget(null); setShowCreate(true); }}>
              <Plus className="h-4 w-4 mr-1" /> 创建员工
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
          {employees.map((emp) => (
            <div
              key={emp.id}
              className="rounded-xl border border-border bg-card p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{emp.avatar_emoji || '🤖'}</span>
                  <div>
                    <h3 className="font-semibold text-sm">{emp.name}</h3>
                    <p className="text-xs text-muted-foreground">{emp.role || '未设置角色'}</p>
                    <p className="text-xs text-muted-foreground">{emp.department || ''}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    onClick={() => { setEditTarget(emp); setShowCreate(true); }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                    onClick={() => setDeleteTarget(emp)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                {emp.persona_prompt || '未设置人设提示词'}
              </p>
              <div className="flex flex-wrap gap-1">
                {parseJsonArray(emp.skills_json).slice(0, 3).map((s, i) => (
                  <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {s}
                  </span>
                ))}
                {parseJsonArray(emp.skills_json).length > 3 && (
                  <span className="text-xs text-muted-foreground">
                    +{parseJsonArray(emp.skills_json).length - 3}
                  </span>
                )}
                {emp.model && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    {emp.model}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(showCreate || editTarget) && (
        <EmployeeFormModal
          employee={editTarget}
          onClose={() => { setShowCreate(false); setEditTarget(null); }}
          onSave={async (data) => {
            if (editTarget) {
              await updateEmployee(editTarget.id, data);
              toast.success('员工已更新');
            } else {
              const emp = await createEmployee(data);
              if (emp) toast.success('员工已创建');
              else toast.error('创建失败');
            }
            setShowCreate(false);
            setEditTarget(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除员工「${deleteTarget?.name}」？`}
        message="删除后员工将设为 inactive，可恢复。"
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteEmployee(deleteTarget.id);
            toast.success('员工已删除');
            setDeleteTarget(null);
          }
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

// --- Employee Form Modal ---

function EmployeeFormModal({
  employee,
  onClose,
  onSave,
}: {
  employee: StaffEmployee | null;
  onClose: () => void;
  onSave: (data: {
    name: string; role: string; department?: string; avatarEmoji?: string;
    personaPrompt?: string; model?: string; skills?: string[];
    knowledgeBases?: string[]; tools?: string[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState(employee?.name ?? '');
  const [role, setRole] = useState(employee?.role ?? '');
  const [department, setDepartment] = useState(employee?.department ?? '');
  const [avatarEmoji, setAvatarEmoji] = useState(employee?.avatar_emoji ?? '🤖');
  const [personaPrompt, setPersonaPrompt] = useState(employee?.persona_prompt ?? '');
  const [model, setModel] = useState(employee?.model ?? '');
  const [skillsText, setSkillsText] = useState(
    employee ? parseJsonArray(employee.skills_json).join(', ') : '',
  );
  const [knowledgeBasesText, setKnowledgeBasesText] = useState(
    employee ? parseJsonArray(employee.knowledge_bases_json).join(', ') : '',
  );
  const [toolsText, setToolsText] = useState(
    employee ? parseJsonArray(employee.tools_json).join(', ') : '',
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">{employee ? '编辑员工' : '创建数字员工'}</h2>
        <div className="space-y-4">
          <div className="flex gap-2 items-end">
            <div>
              <label className="text-sm font-medium mb-1 block">头像</label>
              <input
                value={avatarEmoji}
                onChange={(e) => setAvatarEmoji(e.target.value)}
                className="w-16 text-center text-2xl border border-border rounded-lg px-2 py-1 bg-background"
              />
            </div>
            <div className="flex-1">
              <label className="text-sm font-medium mb-1 block">姓名 *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                placeholder="如：小明"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">角色 *</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {ROLE_PRESETS.map((p) => (
                <button
                  key={p.role}
                  onClick={() => { setRole(p.role); setAvatarEmoji(p.emoji); }}
                  className={`text-xs px-2 py-1 rounded border ${
                    role === p.role ? 'border-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  {p.emoji} {p.role}
                </button>
              ))}
            </div>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              placeholder="自定义角色"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">部门</label>
            <input
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              placeholder="如：技术部"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">人设提示词</label>
            <textarea
              value={personaPrompt}
              onChange={(e) => setPersonaPrompt(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background min-h-[80px]"
              placeholder="定义数字员工的行为方式和专业能力..."
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">模型</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              placeholder="如：gpt-4o, deepseek-v4-pro"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">技能 (逗号分隔)</label>
            <input
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              placeholder="skill-id-1, skill-id-2"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">知识库 (逗号分隔)</label>
            <input
              value={knowledgeBasesText}
              onChange={(e) => setKnowledgeBasesText(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              placeholder="kb-id-1, kb-id-2"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">工具/MCP (逗号分隔)</label>
            <input
              value={toolsText}
              onChange={(e) => setToolsText(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
              placeholder="tool-id-1, mcp-id-2"
            />
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-6">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={!name.trim() || !role.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                role: role.trim(),
                department,
                avatarEmoji,
                personaPrompt,
                model,
                skills: skillsText.split(',').map((s) => s.trim()).filter(Boolean),
                knowledgeBases: knowledgeBasesText.split(',').map((s) => s.trim()).filter(Boolean),
                tools: toolsText.split(',').map((s) => s.trim()).filter(Boolean),
              })
            }
          >
            {employee ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  );
}
