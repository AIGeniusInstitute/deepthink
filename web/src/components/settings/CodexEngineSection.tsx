import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from './types';

interface CodexProvider {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

interface CodexConfig {
  enabled: boolean;
  binaryPath: string;
  defaultModel: string;
  workingDir: string;
  providers: CodexProvider[];
  updatedAt: string | null;
}

interface CodexTestResult {
  ok: boolean;
  version: string;
  error?: string;
}

const DEFAULT_CONFIG: CodexConfig = {
  enabled: false,
  binaryPath: '',
  defaultModel: 'gpt-5.1-codex',
  workingDir: '/workspace/group',
  providers: [],
  updatedAt: null,
};

export function CodexEngineSection() {
  const [cfg, setCfg] = useState<CodexConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CodexTestResult | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<CodexConfig>('/api/config/codex');
      setCfg({ ...DEFAULT_CONFIG, ...data, providers: data.providers ?? [] });
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 Codex 配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const data = await api.put<CodexConfig>('/api/config/codex', cfg);
      setCfg({ ...DEFAULT_CONFIG, ...data, providers: data.providers ?? [] });
      toast.success('Codex 配置已保存');
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
      const result = await api.post<CodexTestResult>('/api/config/codex/test', {});
      setTestResult(result);
      if (result.ok) {
        toast.success(`Codex 可用：${result.version}`);
      } else {
        toast.error(`Codex 不可用：${result.error ?? '未知错误'}`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '测试失败'));
    } finally {
      setTesting(false);
    }
  };

  const updateProvider = (idx: number, patch: Partial<CodexProvider>): void => {
    setCfg((c) => ({
      ...c,
      providers: c.providers.map((p, i) => i === idx ? { ...p, ...patch } : p),
    }));
  };
  const addProvider = (): void => {
    setCfg((c) => ({
      ...c,
      providers: [...c.providers, { name: '', apiKey: '', baseURL: '', model: '' }],
    }));
  };
  const removeProvider = (idx: number): void => {
    setCfg((c) => ({ ...c, providers: c.providers.filter((_, i) => i !== idx) }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载中...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold mb-1">Codex 引擎</h2>
        <p className="text-sm text-muted-foreground">
          配置 OpenAI Codex CLI 作为 DeepThink 的 Agent 执行引擎。Codex 通过
          <code className="mx-1 px-1 py-0.5 bg-muted rounded text-xs">codex exec --json</code>
          JSONL 事件流接入，需预先安装 codex 二进制（Rust 实现）。
        </p>
      </div>

      <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
        <div>
          <Label className="text-base">启用 Codex 引擎</Label>
          <p className="text-xs text-muted-foreground mt-1">
            开启后可在主对话顶部切换为 Codex 引擎
          </p>
        </div>
        <Switch
          checked={cfg.enabled}
          onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="codex-binary">Codex 二进制路径</Label>
        <Input
          id="codex-binary"
          value={cfg.binaryPath}
          onChange={(e) => setCfg({ ...cfg, binaryPath: e.target.value })}
          placeholder="/opt/homebrew/bin/codex 或 ~/codex/target/release/codex"
        />
        <p className="text-xs text-muted-foreground">
          Codex CLI 的绝对路径。可通过 <code>which codex</code> 查找。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="codex-model">默认模型</Label>
        <Input
          id="codex-model"
          value={cfg.defaultModel}
          onChange={(e) => setCfg({ ...cfg, defaultModel: e.target.value })}
          placeholder="gpt-5.1-codex"
        />
        <p className="text-xs text-muted-foreground">
          codex exec --model 传参，必须显式指定。常见值：gpt-5.1-codex / gpt-5.6-sol / gpt-5.4
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="codex-working-dir">工作目录</Label>
        <Input
          id="codex-working-dir"
          value={cfg.workingDir}
          onChange={(e) => setCfg({ ...cfg, workingDir: e.target.value })}
          placeholder="/workspace/group"
        />
        <p className="text-xs text-muted-foreground">
          codex exec --cd 传参。容器模式默认 /workspace/group，宿主机模式自动覆盖为群组目录。
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">LLM Provider 配置</Label>
            <p className="text-xs text-muted-foreground mt-1">
              引擎启动时会动态生成 <code>config.toml</code> 并通过 <code>CODEX_HOME</code> 注入，无需手动编辑 <code>~/.codex/config.toml</code>。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addProvider}>
            <Plus className="w-3.5 h-3.5 mr-1" /> 添加 Provider
          </Button>
        </div>
        {cfg.providers.length === 0 ? (
          <div className="text-xs text-muted-foreground p-3 rounded border border-dashed">
            尚未配置 Provider。点击「添加 Provider」开始。
          </div>
        ) : (
          <div className="space-y-3">
            {cfg.providers.map((p, i) => (
              <div key={i} className="border rounded p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Provider #{i + 1}{i === 0 ? ' (主)' : ''}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeProvider(i)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">名称</Label>
                    <Input
                      value={p.name}
                      onChange={(e) => updateProvider(i, { name: e.target.value })}
                      placeholder="anthropic"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Model</Label>
                    <Input
                      value={p.model}
                      onChange={(e) => updateProvider(i, { model: e.target.value })}
                      placeholder="gpt-5.1-codex"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    value={p.baseURL}
                    onChange={(e) => updateProvider(i, { baseURL: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div>
                  <Label className="text-xs">API Key</Label>
                  <Input
                    type="password"
                    value={p.apiKey.startsWith('****') ? '' : p.apiKey}
                    onChange={(e) => updateProvider(i, { apiKey: e.target.value })}
                    placeholder={p.apiKey.startsWith('****') ? `已保存 (${p.apiKey})` : 'sk-...'}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          保存配置
        </Button>
        <Button variant="outline" onClick={handleTest} disabled={testing}>
          {testing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plug className="w-4 h-4 mr-2" />}
          测试连接
        </Button>
        {testResult ? (
          <span className={`text-sm flex items-center gap-1 ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
            {testResult.ok ? <Check className="w-3.5 h-3.5" /> : null}
            {testResult.ok ? `可用 - ${testResult.version}` : `不可用 - ${testResult.error}`}
          </span>
        ) : null}
      </div>

      {cfg.updatedAt ? (
        <p className="text-xs text-muted-foreground">最后更新：{new Date(cfg.updatedAt).toLocaleString()}</p>
      ) : null}

      <div className="p-3 rounded-md bg-muted/40 text-xs text-muted-foreground">
        <p className="font-medium mb-1">说明</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Provider 配置在 DeepThink 内管理，引擎启动时动态生成临时 <code>config.toml</code>（路径 <code>data/sessions/&lt;folder&gt;/.codex/</code>）</li>
          <li>切换到 Codex 引擎后会开新会话（不重放历史）</li>
          <li>Codex 引擎下 Agent 可使用 DeepThink 内置 MCP 工具（send_message / schedule_task / memory_*），通过 mcp-bridge 桥接</li>
          <li>每个 turn spawn 一次 codex 进程，冷启动 ~2-3s</li>
        </ul>
      </div>
    </div>
  );
}
