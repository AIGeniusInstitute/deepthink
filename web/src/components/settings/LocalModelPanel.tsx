import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Cpu, Download, Loader2, Play, RefreshCw, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { withBasePath } from '../../utils/url';
import { getErrorMessage } from './types';

interface LocalModelStatus {
  service: {
    available: boolean;
    baseUrl: string;
    version: string | null;
    error: string | null;
  };
  models: Array<{ name: string; sizeBytes: number; parameterSize: string | null; family: string | null }>;
  recommended: {
    embedding: { model: string; installed: boolean; active: boolean };
    vision: { model: string; installed: boolean; active: boolean };
  };
  embedding: {
    configured: boolean;
    model: string | null;
    dimensions: number | null;
    usingLocalService: boolean;
    baseUrl: string | null;
  };
  ocr: {
    enabled: boolean;
    provider: 'ollama' | 'openai';
    model: string;
    baseUrl: string;
    endpoint: string;
    dpi: number;
    maxPages: number;
    concurrency: number;
    numCtx: number;
  };
}

interface PullState {
  percent: number;
  status: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '-';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * 「本机内置模型服务」面板。
 *
 * 目标是让管理员**不需要任何 API Key** 就能把向量检索和扫描件 OCR 用起来：
 * 本机跑一个开源模型服务（Ollama），模型按需下载，配置由这里一键写入。
 *
 * 下载走 NDJSON 流：视觉模型约 6GB，不给进度条的话用户只能盯着一个转圈，
 * 无从判断是在下载还是卡死了。
 */
export function LocalModelPanel({ onEmbeddingChanged }: { onEmbeddingChanged?: () => void }) {
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.get<LocalModelStatus>('/api/paas/local-model'));
    } catch (err) {
      toast.error(getErrorMessage(err, '读取本机模型服务状态失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStart = async (): Promise<void> => {
    setBusy('start');
    try {
      const res = await api.post<{ success: boolean; started: boolean }>('/api/paas/local-model/start', {});
      toast.success(res.started ? '本机模型服务已启动' : '本机模型服务已在运行');
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, '启动本机模型服务失败'));
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async (model: string): Promise<void> => {
    setPulls((p) => ({ ...p, [model]: { percent: 0, status: '准备中' } }));
    try {
      // 这里不用 api.post：它会把响应读完再解析，而拉取是长连接流式进度。
      const res = await fetch(withBasePath('/api/paas/local-model/pull'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`下载失败：HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let failure: string | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { percent?: number; status?: string; error?: string };
          if (event.error) failure = event.error;
          setPulls((p) => ({
            ...p,
            [model]: { percent: event.percent ?? p[model]?.percent ?? 0, status: event.status ?? '' },
          }));
        }
      }
      if (failure) throw new Error(failure);
      toast.success(`${model} 下载完成`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, `下载 ${model} 失败`));
    } finally {
      setPulls((p) => {
        const next = { ...p };
        delete next[model];
        return next;
      });
    }
  };

  const handleEnableEmbedding = async (): Promise<void> => {
    setBusy('enable-embedding');
    try {
      const res = await api.put<{
        model: string;
        dimensions: number;
        dimensionChanged: boolean;
      }>('/api/paas/local-model/embedding', {});
      toast.success(`已启用本机向量模型 ${res.model}（${res.dimensions} 维）`, {
        description: res.dimensionChanged
          ? '向量维度发生变化，已有索引已清空。请到各知识库点「重建索引」重新生成向量。'
          : undefined,
        duration: res.dimensionChanged ? 12_000 : 4_000,
      });
      await load();
      onEmbeddingChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err, '启用本机向量模型失败'));
    } finally {
      setBusy(null);
    }
  };

  const handleToggleOcr = async (enabled: boolean): Promise<void> => {
    setBusy('ocr');
    try {
      await api.put('/api/paas/local-model/ocr-config', { enabled });
      toast.success(enabled ? '已启用扫描件 OCR' : '已关闭扫描件 OCR');
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, '更新 OCR 设置失败'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="py-6 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!status) return null;

  const { service, recommended, embedding, ocr } = status;
  const embeddingPull = pulls[recommended.embedding.model];
  const visionPull = pulls[recommended.vision.model];

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Cpu className="w-4 h-4" />
            本机内置模型服务
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            开箱即用的开源模型服务（Ollama），无需申请任何 API Key。向量检索与扫描件 OCR
            都跑在本机，文档内容不出机器。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}>
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <div
        data-testid="local-model-service-status"
        className={`rounded-md px-3 py-2 text-sm flex items-center gap-2 ${
          service.available ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
        }`}
      >
        {service.available ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
        <span className="min-w-0">
          {service.available
            ? `服务可用 · ${service.baseUrl} · v${service.version ?? '?'}`
            : `服务不可用 · ${service.baseUrl} · ${service.error ?? '未启动'}`}
        </span>
        {!service.available ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0"
            onClick={() => void handleStart()}
            disabled={busy !== null}
          >
            {busy === 'start' ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
            启动服务
          </Button>
        ) : null}
      </div>

      {/* ── 向量模型 ── */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              向量模型 · <span className="font-mono">{recommended.embedding.model}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              多语言（中文友好）· 1024 维 · 8192 上下文。用于知识库的语义检索。
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {recommended.embedding.active ? (
              <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-700">已启用</span>
            ) : recommended.embedding.installed ? (
              <Button
                size="sm"
                onClick={() => void handleEnableEmbedding()}
                disabled={busy !== null}
                data-testid="local-model-enable-embedding"
              >
                {busy === 'enable-embedding' ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Zap className="w-4 h-4 mr-1" />
                )}
                一键启用
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handlePull(recommended.embedding.model)}
                disabled={!service.available || embeddingPull !== undefined}
                data-testid="local-model-pull-embedding"
              >
                {embeddingPull ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 mr-1" />
                )}
                下载
              </Button>
            )}
          </div>
        </div>
        {embeddingPull ? (
          <div className="space-y-1">
            <div className="h-1.5 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${embeddingPull.percent}%` }} />
            </div>
            <div className="text-xs text-muted-foreground">
              {embeddingPull.status} {embeddingPull.percent}%
            </div>
          </div>
        ) : null}
        {!embedding.usingLocalService && embedding.configured ? (
          <div className="text-xs text-muted-foreground">
            当前生效的是外部 Embedding：<span className="font-mono">{embedding.model}</span>（
            {embedding.dimensions} 维）。点「一键启用」会切换为本机模型，并清空已有向量索引。
          </div>
        ) : null}
      </div>

      {/* ── 扫描件 OCR ── */}
      <div className="rounded-md border border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              扫描件 OCR · <span className="font-mono">{ocr.model}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              没有文字层的 PDF 会被渲染成图片交给视觉模型转写，表格按 Markdown 保留行列。
              单次最多 {ocr.maxPages} 页。
            </div>
            {/* 显示真正会被请求的地址，而不是"看起来对"的地址 —— 换协议后界面不能撒谎。 */}
            <div className="text-xs text-muted-foreground mt-0.5 font-mono break-all">
              {ocr.endpoint}
              {ocr.provider === 'ollama' ? ` · num_ctx=${ocr.numCtx}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {recommended.vision.installed ? (
              <Button
                size="sm"
                variant={ocr.enabled ? 'outline' : 'default'}
                onClick={() => void handleToggleOcr(!ocr.enabled)}
                disabled={busy !== null}
                data-testid="local-model-toggle-ocr"
              >
                {busy === 'ocr' ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                {ocr.enabled ? '关闭' : '启用'}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handlePull(recommended.vision.model)}
                disabled={!service.available || visionPull !== undefined}
                data-testid="local-model-pull-vision"
              >
                {visionPull ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
                下载
              </Button>
            )}
          </div>
        </div>
        {visionPull ? (
          <div className="space-y-1">
            <div className="h-1.5 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${visionPull.percent}%` }} />
            </div>
            <div className="text-xs text-muted-foreground">
              {visionPull.status} {visionPull.percent}%
            </div>
          </div>
        ) : null}
        {recommended.vision.installed && !ocr.enabled ? (
          <div className="text-xs text-amber-700">OCR 当前已关闭，无文字层的扫描件将被拒绝上传。</div>
        ) : null}
      </div>

      {status.models.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          已安装模型：
          {status.models.map((m) => `${m.name}（${formatBytes(m.sizeBytes)}）`).join('、')}
        </div>
      ) : null}
    </div>
  );
}
