import { useRef, useState } from 'react';
import { Loader2, Upload, FileArchive } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSkillsStore } from '@/stores/skills';

interface UploadSkillDialogProps {
  open: boolean;
  onClose: () => void;
}

const MAX_SIZE = 10 * 1024 * 1024;

export function UploadSkillDialog({ open, onClose }: UploadSkillDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadSkillZip = useSkillsStore((s) => s.uploadSkillZip);

  const acceptFile = (f: File | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      toast.error('文件必须是 .zip 格式');
      return;
    }
    if (f.size === 0) {
      toast.error('文件为空');
      return;
    }
    if (f.size > MAX_SIZE) {
      toast.error('文件大小不能超过 10MB');
      return;
    }
    setFile(f);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      toast.error('请先选择 zip 文件');
      return;
    }
    setUploading(true);
    try {
      const skill = await uploadSkillZip(file);
      toast.success(`技能「${skill.name}」上传成功`);
      setFile(null);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleClose = () => {
    if (uploading) return;
    setFile(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="size-4 text-primary" />
            上传技能 ZIP 包
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div
            className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${
              dragOver
                ? 'border-primary bg-brand-50'
                : 'border-border hover:bg-muted/50'
            }`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0] ?? null;
              acceptFile(f);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
            />
            {file ? (
              <div className="flex flex-col items-center gap-2">
                <FileArchive className="size-10 text-primary" />
                <p className="text-sm font-medium text-foreground">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} KB
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Upload className="size-8" />
                <p className="text-sm">点击或拖拽 zip 文件到此处</p>
                <p className="text-xs">最大 10MB · 必须含 SKILL.md</p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={uploading}>
              取消
            </Button>
            <Button type="submit" disabled={uploading || !file}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              上传
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
