import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSkillsStore } from '@/stores/skills';

interface CreateSkillDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateSkillDialog({ open, onClose }: CreateSkillDialogProps) {
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const createSkill = useSkillsStore((s) => s.createSkill);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (trimmed.length < 10) {
      toast.error('描述至少 10 个字符');
      return;
    }
    setCreating(true);
    try {
      const skill = await createSkill(trimmed, name.trim() || undefined);
      toast.success(`技能「${skill.name}」已生成`);
      setDescription('');
      setName('');
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'AI 生成技能失败');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    if (creating) return;
    setDescription('');
    setName('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            AI 生成技能
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              需求描述
            </label>
            <textarea
              className="w-full min-h-[120px] rounded-md border border-border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如：每天爬取 GitHub trending 仓库，按语言分类后汇总到飞书群，包含仓库名、star 数、增长趋势"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={creating}
              maxLength={500}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {description.length}/500 · AI 会根据描述生成完整的 SKILL.md
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              技能名称（可选）
            </label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="留空则由 AI 自动生成，如 github-trending-daily"
              disabled={creating}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              建议使用 kebab-case（小写字母、数字、连字符）
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={creating}>
              取消
            </Button>
            <Button type="submit" disabled={creating || description.trim().length < 10}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              生成技能
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
