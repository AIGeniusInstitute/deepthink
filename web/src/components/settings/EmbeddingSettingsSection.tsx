import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '../../stores/auth';
import { getErrorMessage } from './types';

interface EmbeddingConfigAdmin {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  configured: boolean;
}

interface EmbeddingConfigMember {
  model: string;
  dimensions: number;
  configured: boolean;
}

interface TestResult {
  success: boolean;
  dimensions?: number;
  error?: string;
}

export function EmbeddingSettingsSection() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('text-embedding-3-small');
  const [dimensions, setDimensions] = useState(1536);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      if (isAdmin) {
        const data = await api.get<EmbeddingConfigAdmin>('/api/paas/embedding-config');
        setBaseUrl(data.baseUrl ?? '');
        setApiKey(data.apiKey === '<masked>' ? '' : data.apiKey ?? '');
        setModel(data.model ?? 'text-embedding-3-small');
        setDimensions(data.dimensions ?? 1536);
        setConfigured(data.configured);
      } else {
        const data = await api.get<EmbeddingConfigMember>('/api/paas/embedding-config');
        setModel(data.model ?? 'text-embedding-3-small');
        setDimensions(data.dimensions ?? 1536);
        setConfigured(data.configured);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 Embedding 配置失败'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.put('/api/paas/embedding-config', {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        dimensions,
      });
      toast.success('Embedding 配置已保存');
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<TestResult>('/api/paas/embedding-config/test', {});
      setTestResult(result);
      if (result.success) {
        toast.success(`连接成功，向量维度 ${result.dimensions ?? '?'}`);
      } else {
        toast.error('连接失败', { description: result.error });
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '测试连接失败'));
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="py-8 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          向量检索依赖 Embedding API。当前状态：
          <span className={`ml-1 ${configured ? 'text-emerald-600' : 'text-amber-600'}`}>
            {configured ? '已配置' : '未配置（仅启用 FTS5 全文检索）'}
          </span>
        </p>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm space-y-1">
          <div><span className="text-muted-foreground">模型：</span>{model}</div>
          <div><span className="text-muted-foreground">维度：</span>{dimensions}</div>
        </div>
        <p className="text-xs text-muted-foreground">
          如需启用向量检索，请联系管理员配置 Embedding API。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Embedding 配置</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          知识库向量检索依赖外部 Embedding API（OpenAI 兼容协议）。配置后，文档上传时自动生成向量；
          未配置时仅启用 FTS5 全文检索。后端使用 sqlite-vec 扩展做 KNN 查询。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="emb-base">Base URL</Label>
        <Input
          id="emb-base"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
        <p className="text-xs text-muted-foreground">OpenAI 兼容 API 的根地址，结尾不要带 /。</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="emb-key">API Key</Label>
        <Input
          id="emb-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={configured ? '已保存，留空则不变' : 'sk-...'}
        />
        <p className="text-xs text-muted-foreground">
          保存在 data/config/embedding.json（文件权限 0600，服务器本地加密存储）。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="emb-model">模型</Label>
          <Input
            id="emb-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="text-embedding-3-small"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="emb-dims">维度</Label>
          <Input
            id="emb-dims"
            type="number"
            min={1}
            max={8192}
            value={dimensions}
            onChange={(e) => setDimensions(Number(e.target.value) || 1536)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        维度需匹配模型实际输出（text-embedding-3-small 默认 1536）。修改维度后需重新 embed 所有文档。
      </p>

      <div className="flex gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          保存配置
        </Button>
        <Button variant="outline" onClick={() => void handleTest()} disabled={testing || !configured}>
          {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plug className="w-4 h-4 mr-2" />}
          测试连接
        </Button>
      </div>

      {testResult ? (
        <div className="rounded-lg border border-border p-3 text-sm">
          {testResult.success ? (
            <span className="text-emerald-600">✓ 连接成功，维度 {testResult.dimensions}</span>
          ) : (
            <span className="text-red-600">✗ {testResult.error ?? '未知错误'}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
