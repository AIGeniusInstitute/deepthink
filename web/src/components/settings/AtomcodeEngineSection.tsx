import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Plus, Trash2, Check } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from './types';

interface AtomcodeConfig {
  enabled: boolean;
  binaryPath: string;
  host: string;
  basePort: number;
  portRange: number;
  atomcodeHome: string;
  updatedAt: string | null;
}

interface AtomcodeProvider {
  name: string;
  type: string;
  model: string;
  base_url?: string | null;
  has_api_key?: boolean;
  is_default?: boolean;
  context_window?: number | null;
  max_tokens?: number | null;
  thinking_enabled?: boolean | null;
  [k: string]: unknown;
}

interface AtomcodeTestResult {
  health: { ok: boolean; version?: string; error?: string };
  defaultProvider: string | null;
  providerCount: number;
  modelCount: number;
}

const DEFAULT_CONFIG: AtomcodeConfig = {
  enabled: false,
  binaryPath: '',
  host: '127.0.0.1',
  basePort: 14000,
  portRange: 100,
  atomcodeHome: '',
  updatedAt: null,
};

export function AtomcodeEngineSection() {
  const [cfg, setCfg] = useState<AtomcodeConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AtomcodeTestResult | null>(null);
  const [providers, setProviders] = useState<AtomcodeProvider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<AtomcodeConfig>('/api/config/atomcode');
      setCfg({ ...DEFAULT_CONFIG, ...data });
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 AtomCode 配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProviders = useCallback(async (): Promise<void> => {
    if (!cfg.enabled || !cfg.binaryPath) return;
    setLoadingProviders(true);
    try {
      const data = await api.get<{ default_provider: string | null; providers: AtomcodeProvider[] }>(
        '/api/config/atomcode/providers',
      );
      setProviders(data.providers ?? []);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 Provider 列表失败'));
    } finally {
      setLoadingProviders(false);
    }
  }, [cfg.enabled, cfg.binaryPath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const data = await api.put<AtomcodeConfig>('/api/config/atomcode', cfg);
      setCfg({ ...DEFAULT_CONFIG, ...data });
      toast.success('AtomCode 配置已保存');
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
      const result = await api.post<AtomcodeTestResult>('/api/config/atomcode/test', {});
      setTestResult(result);
      if (result.health.ok) {
        toast.success(
          `AtomCode 连接成功（v${result.health.version ?? 'unknown'}, ${result.providerCount} 个 provider, ${result.modelCount} 个模型）`,
        );
      } else {
        toast.error('AtomCode 连接失败', { description: result.health.error });
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '测试连接失败'));
    } finally {
      setTesting(false);
    }
  };

  const handleSetDefault = async (name: string): Promise<void> => {
    try {
      await api.post(`/api/config/atomcode/providers/${encodeURIComponent(name)}/default`, {});
      toast.success(`已将 ${name} 设为默认`);
      await loadProviders();
    } catch (err) {
      toast.error(getErrorMessage(err, '设为默认失败'));
    }
  };

  const handleDelete = async (name: string): Promise<void> => {
    if (!confirm(`确认删除 provider "${name}"?`)) return;
    try {
      await api.delete(`/api/config/atomcode/providers/${encodeURIComponent(name)}`);
      toast.success(`已删除 ${name}`);
      await loadProviders();
    } catch (err) {
      toast.error(getErrorMessage(err, '删除失败'));
    }
  };

  if (loading) {
    return (
      <div className="py-8 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">AtomCode 引擎</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          AtomCode 是开源的 Rust Coding Agent，作为 DeepThink 的第二执行引擎。
          启用后，主对话框可切换到 AtomCode 引擎；Provider 由 atomcode-daemon 自管理。
        </p>
      </div>

      {/* 启用开关 */}
      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div>
          <Label className="text-sm font-medium">启用 AtomCode 引擎</Label>
          <p className="text-xs text-muted-foreground mt-1">
            关闭后，主对话框无法切换到 AtomCode 引擎。
          </p>
        </div>
        <Switch
          checked={cfg.enabled}
          onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })}
        />
      </div>

      {/* 二进制路径 */}
      <div className="space-y-1.5">
        <Label htmlFor="atomcode-binary">atomcode-daemon 二进制路径</Label>
        <Input
          id="atomcode-binary"
          value={cfg.binaryPath}
          onChange={(e) => setCfg({ ...cfg, binaryPath: e.target.value })}
          placeholder="/usr/local/bin/atomcode-daemon 或 ~/.cargo/bin/atomcode-daemon"
        />
        <p className="text-xs text-muted-foreground">
          宿主机模式：直接填写宿主机路径。Docker 模式：填宿主机绝对路径，会自动 bind-mount 到容器同路径。
        </p>
      </div>

      {/* Host + 端口 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="atomcode-host">Daemon Host</Label>
          <Input
            id="atomcode-host"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="127.0.0.1"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="atomcode-port">起始端口</Label>
          <Input
            id="atomcode-port"
            type="number"
            value={cfg.basePort}
            onChange={(e) => setCfg({ ...cfg, basePort: Number(e.target.value) || 14000 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="atomcode-range">端口池大小</Label>
          <Input
            id="atomcode-range"
            type="number"
            value={cfg.portRange}
            onChange={(e) => setCfg({ ...cfg, portRange: Number(e.target.value) || 100 })}
          />
        </div>
      </div>

      {/* ATOMCODE_HOME */}
      <div className="space-y-1.5">
        <Label htmlFor="atomcode-home">ATOMCODE_HOME（可选）</Label>
        <Input
          id="atomcode-home"
          value={cfg.atomcodeHome}
          onChange={(e) => setCfg({ ...cfg, atomcodeHome: e.target.value })}
          placeholder="留空 = 使用默认 ~/.atomcode"
        />
        <p className="text-xs text-muted-foreground">
          atomcode 的 sessions/providers/mcp.json 都在此目录下。
        </p>
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          保存配置
        </Button>
        <Button variant="outline" onClick={() => void handleTest()} disabled={testing || !cfg.binaryPath}>
          {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plug className="w-4 h-4 mr-2" />}
          测试连接
        </Button>
      </div>

      {testResult ? (
        <div className="rounded-lg border border-border p-3 text-sm space-y-1">
          <div>
            <span className="text-muted-foreground">状态：</span>
            {testResult.health.ok ? (
              <span className="text-green-600">✓ 就绪 (v{testResult.health.version})</span>
            ) : (
              <span className="text-red-600">✗ {testResult.health.error}</span>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">默认 Provider：</span>
            {testResult.defaultProvider ?? '无'}
          </div>
          <div>
            <span className="text-muted-foreground">Provider 数量：</span>
            {testResult.providerCount}
          </div>
          <div>
            <span className="text-muted-foreground">模型数量：</span>
            {testResult.modelCount}
          </div>
        </div>
      ) : null}

      {/* Provider 管理 */}
      <div className="pt-4 border-t border-border">
        <div className="flex items-center justify-between">
          <h3 className="text-md font-semibold">Provider 管理</h3>
          <Button size="sm" variant="outline" onClick={() => setShowAddForm(!showAddForm)}>
            <Plus className="w-4 h-4 mr-1" />
            新增
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Provider 透传到 atomcode-daemon 的 ~/.atomcode/config.toml，独立于 DeepThink 的 Claude provider 池。
        </p>

        {showAddForm ? (
          <AddProviderForm
            onDone={() => {
              setShowAddForm(false);
              void loadProviders();
            }}
          />
        ) : null}

        {loadingProviders ? (
          <div className="py-4 flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : providers.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground text-center">
            尚未配置任何 provider。点击"新增"添加（如 openai / claude / ollama）。
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {providers.map((p) => (
              <div
                key={p.name}
                className="rounded-md border border-border p-3 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{p.name}</span>
                    {p.is_default ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-700">默认</span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {p.type} · {p.model}
                    {p.base_url ? ` · ${p.base_url}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {p.has_api_key ? '✓ API Key 已配置' : '⚠ 未配置 API Key'}
                    {p.context_window ? ` · ctx=${p.context_window}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!p.is_default ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleSetDefault(p.name)}
                      title="设为默认"
                    >
                      <Check className="w-4 h-4" />
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleDelete(p.name)}
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [setDefault, setSetDefault] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name || !model) {
      toast.error('name 和 model 必填');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/config/atomcode/providers', {
        name,
        type,
        model,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        set_default: setDefault,
      });
      toast.success('Provider 已创建');
      onDone();
    } catch (err) {
      toast.error(getErrorMessage(err, '创建失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border p-3 space-y-3 bg-muted/20">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="openai" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">type *</Label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="openai">openai</option>
            <option value="claude">claude</option>
            <option value="ollama">ollama</option>
            <option value="deepseek">deepseek</option>
            <option value="qwen">qwen</option>
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">model *</Label>
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">api_key</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">base_url（可选）</Label>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={setDefault} onCheckedChange={setSetDefault} />
        <Label className="text-xs">设为默认 provider</Label>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          创建
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>取消</Button>
      </div>
    </div>
  );
}
