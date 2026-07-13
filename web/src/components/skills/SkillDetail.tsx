import { useState, useEffect } from 'react';
import {
  File, Folder, Loader2, Lock, Trash2, RefreshCw, Package,
  Wand2, Save, Play, Pencil,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useSkillsStore, type SkillDetail as SkillDetailType } from '../../stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { OptimizeSkillDialog } from './OptimizeSkillDialog';

interface SkillDetailProps {
  skillId: string | null;
  onDeleted?: () => void;
}

type TabKey = 'view' | 'edit' | 'debug';

export function SkillDetail({ skillId, onDeleted }: SkillDetailProps) {
  const [detail, setDetail] = useState<SkillDetailType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [tab, setTab] = useState<TabKey>('view');
  const [editContent, setEditContent] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showOptimize, setShowOptimize] = useState(false);
  const [testInput, setTestInput] = useState('');
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugDuration, setDebugDuration] = useState<number | null>(null);
  const [debugging, setDebugging] = useState(false);
  const getSkillDetail = useSkillsStore((s) => s.getSkillDetail);
  const deleteSkill = useSkillsStore((s) => s.deleteSkill);
  const reinstallSkill = useSkillsStore((s) => s.reinstallSkill);
  const saveSkillContent = useSkillsStore((s) => s.saveSkillContent);
  const debugSkill = useSkillsStore((s) => s.debugSkill);

  useEffect(() => {
    if (!skillId) {
      setDetail(null);
      setError(null);
      return;
    }
    const loadDetail = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getSkillDetail(skillId);
        setDetail(data);
        setEditContent(data.content);
        setEditDirty(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
        setDetail(null);
      } finally {
        setLoading(false);
      }
    };
    loadDetail();
  }, [skillId, getSkillDetail]);

  const isUserLevel = detail?.source === 'user';

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await saveSkillContent(detail.id, editContent);
      // Re-fetch detail to get fresh content + files
      const updated = await getSkillDetail(detail.id);
      setDetail(updated);
      setEditContent(updated.content);
      setEditDirty(false);
      toast.success('已保存');
    } catch (err: any) {
      toast.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDebug = async () => {
    if (!detail) return;
    const trimmed = testInput.trim();
    if (!trimmed) {
      toast.error('请输入测试输入');
      return;
    }
    setDebugging(true);
    setDebugOutput(null);
    setDebugDuration(null);
    try {
      const result = await debugSkill(detail.id, trimmed);
      setDebugOutput(result.output);
      setDebugDuration(result.duration_ms);
    } catch (err: any) {
      toast.error(err?.message || '调试失败');
    } finally {
      setDebugging(false);
    }
  };

  if (!skillId) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-muted-foreground text-center">选择一个技能查看详情</p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="animate-spin text-primary" size={32} />
        </CardContent>
      </Card>
    );
  }

  if (error || !detail) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-error text-center">{error || '加载失败'}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-6 border-b border-border">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-foreground">{detail.name}</h2>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  detail.source === 'user'
                    ? 'bg-brand-100 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {detail.source === 'user' ? '用户级' : detail.source === 'external' ? '宿主机' : '项目级'}
              </span>
              {detail.userInvocable && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                  可调用
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{detail.description}</p>
          </div>

          {detail.source === 'project' || detail.source === 'external' ? (
            <div className="flex items-center gap-2">
              <Lock size={16} className="text-muted-foreground" />
              <div
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  detail.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
                } opacity-50`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-foreground transition-transform ${
                    detail.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                disabled={deleting || reinstalling}
                onClick={() => setShowOptimize(true)}
              >
                <Wand2 size={14} />
                AI 优化
              </Button>
              {detail.packageName && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reinstalling || deleting}
                  onClick={async () => {
                    if (!confirm(`确认重新安装技能「${detail.name}」？`)) return;
                    setReinstalling(true);
                    try {
                      await reinstallSkill(detail.id);
                      const data = await getSkillDetail(detail.id);
                      setDetail(data);
                      setEditContent(data.content);
                    } catch { /* handled by store */ }
                    finally { setReinstalling(false); }
                  }}
                >
                  <RefreshCw size={14} className={reinstalling ? 'animate-spin' : ''} />
                  {reinstalling ? '重装中...' : '重新安装'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={deleting || reinstalling}
                onClick={async () => {
                  if (!confirm(`确认删除技能「${detail.name}」？`)) return;
                  setDeleting(true);
                  try {
                    await deleteSkill(detail.id);
                    onDeleted?.();
                  } catch { /* error handled by store */ }
                  finally { setDeleting(false); }
                }}
                className="text-error hover:bg-error-bg"
              >
                <Trash2 size={14} />
                {deleting ? '删除中...' : '删除'}
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2 text-sm">
          {detail.packageName && (
            <div className="flex items-center gap-1.5">
              <Package size={14} className="text-muted-foreground" />
              <span className="text-muted-foreground">来源：</span>
              <span className="text-foreground font-mono text-xs">{detail.packageName}</span>
            </div>
          )}
          {detail.installedAt && (
            <div>
              <span className="text-muted-foreground">安装时间：</span>
              <span className="text-foreground ml-1">
                {new Date(detail.installedAt).toLocaleString('zh-CN')}
              </span>
            </div>
          )}
          {detail.allowedTools && detail.allowedTools.length > 0 && (
            <div>
              <span className="text-muted-foreground">允许工具：</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {detail.allowedTools.map((tool: string) => (
                  <span
                    key={tool}
                    className="px-2 py-0.5 bg-muted text-foreground rounded text-xs"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {detail.argumentHint && (
            <div>
              <span className="text-muted-foreground">参数提示：</span>
              <span className="text-foreground ml-2">{detail.argumentHint}</span>
            </div>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="flex-1 min-h-0 flex flex-col">
        <div className="px-6 pt-4">
          <TabsList>
            <TabsTrigger value="view">查看</TabsTrigger>
            <TabsTrigger value="edit" disabled={!isUserLevel}>
              <Pencil className="size-3 mr-1" />
              编辑
            </TabsTrigger>
            <TabsTrigger value="debug">
              <Play className="size-3 mr-1" />
              调试
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="view" className="px-6 pb-6">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">技能说明</h3>
            <div className="max-w-none">
              <MarkdownRenderer content={detail.content} variant="docs" />
            </div>
          </div>

          {detail.files && detail.files.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-foreground mb-3">文件列表</h3>
              <div className="space-y-1">
                {detail.files.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    {file.type === 'directory' ? (
                      <Folder size={16} className="text-muted-foreground" />
                    ) : (
                      <File size={16} className="text-muted-foreground" />
                    )}
                    <span>{file.name}</span>
                    {file.type === 'file' && (
                      <span className="text-xs text-muted-foreground">({file.size} B)</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="edit" className="px-6 pb-6 flex flex-col gap-3">
          {!isUserLevel ? (
            <p className="text-sm text-muted-foreground">只读技能不支持编辑</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  编辑 SKILL.md 全文，保存后下次会话生效
                  {editDirty && <span className="text-amber-600 ml-2">· 未保存</span>}
                </p>
                <Button size="sm" onClick={handleSave} disabled={saving || !editDirty}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存
                </Button>
              </div>
              <textarea
                className="w-full min-h-[400px] rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value);
                  setEditDirty(e.target.value !== detail.content);
                }}
                disabled={saving}
                spellCheck={false}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="debug" className="px-6 pb-6 flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            输入测试 prompt，AI 会以该技能的指令响应一次（不调用工具，纯文本）
          </p>
          <textarea
            className="w-full min-h-[100px] rounded-md border border-border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="例如：列出今日 Python 仓库前 10 名"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            disabled={debugging}
          />
          <div className="flex items-center justify-between">
            {debugDuration !== null && (
              <span className="text-xs text-muted-foreground">
                耗时 {(debugDuration / 1000).toFixed(2)}s
              </span>
            )}
            <Button size="sm" onClick={handleDebug} disabled={debugging || !testInput.trim()} className="ml-auto">
              {debugging ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              执行
            </Button>
          </div>
          {debugOutput !== null && (
            <div className="rounded-md border border-border bg-muted/30 p-3 max-h-[400px] overflow-y-auto">
              <MarkdownRenderer content={debugOutput} variant="docs" />
            </div>
          )}
        </TabsContent>
      </Tabs>

      {showOptimize && detail && (
        <OptimizeSkillDialog
          open={showOptimize}
          onClose={() => setShowOptimize(false)}
          skillId={detail.id}
          skillName={detail.name}
        />
      )}
    </Card>
  );
}
