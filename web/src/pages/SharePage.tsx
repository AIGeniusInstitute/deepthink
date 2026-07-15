import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Bot, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '../stores/auth';
import { api, ApiError } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface ShareInfo {
  shareId: string;
  agentName: string;
  description: string;
  systemPromptPreview: string;
  model: string | null;
  engine: 'claude' | 'atomcode';
  mountCount: number;
  installCount: number;
  createdAt: string;
}

interface InstallResult {
  agentId: string;
  name: string;
}

export function SharePage() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<ShareInfo>(`/api/paas/share/${encodeURIComponent(token)}`)
      .then((data) => { if (!cancelled) { setInfo(data); setError(null); } })
      .catch((err: ApiError) => {
        if (!cancelled) setError(err?.message ?? '加载失败');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const res = await api.post<InstallResult>(`/api/paas/share/${encodeURIComponent(token)}/install`, {});
      toast.success(`已安装到你的账户：${res.name}`);
      navigate('/agents');
    } catch (err) {
      const msg = err instanceof Error ? err.message :
        (typeof err === 'object' && err !== null && 'message' in err ? String((err as { message?: unknown }).message) : '安装失败');
      toast.error(msg);
    } finally {
      setInstalling(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center space-y-3">
            <div className="text-4xl">🔍</div>
            <div className="text-lg font-semibold">分享链接无效</div>
            <div className="text-sm text-muted-foreground">{error}</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!info) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-background p-6">
      <Card className="max-w-lg w-full">
        <CardContent className="p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-teal-500/10 flex items-center justify-center">
              <Bot className="size-6 text-teal-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xl font-semibold truncate">{info.agentName}</div>
              <div className="text-xs text-muted-foreground">
                {info.engine} · {info.model ?? '默认模型'} · {info.mountCount} 挂载 · 已被安装 {info.installCount} 次
              </div>
            </div>
          </div>

          {info.description && (
            <div className="text-sm text-foreground">{info.description}</div>
          )}

          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">System Prompt 预览</div>
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words bg-muted/40 rounded-md p-3 border border-border max-h-48 overflow-y-auto">
              {info.systemPromptPreview}
            </pre>
          </div>

          <div className="text-xs text-muted-foreground">
            创建于 {new Date(info.createdAt).toLocaleString('zh-CN')}
          </div>

          {user ? (
            <Button className="w-full" size="lg" onClick={() => handleInstall()} disabled={installing}>
              {installing ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Download className="size-4 mr-2" />}
              安装到我的账户
            </Button>
          ) : (
            <Button className="w-full" size="lg" onClick={() => navigate('/login?redirect=' + encodeURIComponent(`/share/${token}`))}>
              登录后安装
            </Button>
          )}

          <div className="text-xs text-center text-muted-foreground">
            安装后会在你的账户创建一份 Agent 副本（含相同挂载配置），你可以在 Agent Studio 中调整。
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
