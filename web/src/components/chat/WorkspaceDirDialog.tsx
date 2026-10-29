import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';
import { useChatStore } from '../../stores/chat';

interface WorkspaceDirDialogProps {
  open: boolean;
  jid: string;
  folder: string;
  currentCustomCwd?: string;
  onClose: () => void;
}

/**
 * 工作目录设置：把工作区根目录指向用户本机目录（custom_cwd），或恢复默认
 * 平台托管目录 data/groups/{folder}/。修改对下一次 Agent 运行生效。
 */
export function WorkspaceDirDialog({
  open,
  jid,
  folder,
  currentCustomCwd,
  onClose,
}: WorkspaceDirDialogProps) {
  const [dir, setDir] = useState(currentCustomCwd || '');
  const [loading, setLoading] = useState(false);
  const updateWorkspaceDir = useChatStore((s) => s.updateWorkspaceDir);

  useEffect(() => {
    if (open) setDir(currentCustomCwd || '');
  }, [open, currentCustomCwd]);

  const defaultDirLabel = `data/groups/${folder}/（默认）`;

  const save = async (customCwd: string | null) => {
    setLoading(true);
    try {
      await updateWorkspaceDir(jid, customCwd);
      toast.success(customCwd ? '工作目录已更新，下一次运行生效' : '已恢复默认工作区目录');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>工作目录</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="mb-2">当前目录</Label>
            <p className="text-sm text-muted-foreground font-mono break-all">
              {currentCustomCwd || defaultDirLabel}
            </p>
          </div>

          <div>
            <Label className="mb-2">选择本机目录作为工作区</Label>
            <DirectoryBrowser value={dir} onChange={setDir} placeholder={defaultDirLabel} />
            <p className="text-xs text-muted-foreground mt-1">
              Agent 将直接读写所选目录（修改落在目录本身）；留空保存即恢复默认目录。
            </p>
          </div>

          <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              修改对下一次 Agent 运行生效（运行中的会话继续使用原目录）。「重建工作区」不会删除本机目录中的文件。
            </p>
          </div>
        </div>

        <DialogFooter>
          {currentCustomCwd && (
            <Button
              variant="outline"
              onClick={() => save(null)}
              disabled={loading}
              className="mr-auto"
            >
              恢复默认
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => save(dir.trim() || null)} disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
