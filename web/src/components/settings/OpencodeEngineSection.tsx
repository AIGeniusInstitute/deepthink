import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from './types';

interface OpencodeProvider {
  id: string;
  name: string;
  /** GET /api/config/opencode 公开响应中不返回 apiKey，仅为本地编辑态存在 */
  apiKey?: string;
  baseURL: string;
  models: string[];
  hasApiKey?: boolean;
}

interface OpencodeConfig {
  enabled: boolean;
  bunPath: string;
  opencodePath: string;
  host: string;
  basePort: number;
  portRange: number;
  hasPassword: boolean;
  providerID: string;
  modelID: string;
  workingDir: string;
  providers: OpencodeProvider[];
  updatedAt: string | null;
}

interface OpencodeTestResult {
  ok: boolean;
  bunVersion: string;
  error?: string;
}

const DEFAULT_CONFIG: OpencodeConfig = {
  enabled: false,
  bunPath: '',
  opencodePath: '',
  host: '127.0.0.1',
  basePort: 15000,
  portRange: 100,
  hasPassword: false,
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-6',
  workingDir: '/workspace/group',
  providers: [],
  updatedAt: null,
};

export function OpencodeEngineSection() {
  const [cfg, setCfg] = useState<OpencodeConfig>(DEFAULT_CONFIG);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OpencodeTestResult | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<OpencodeConfig>('/api/config/opencode');
      setCfg({ ...DEFAULT_CONFIG, ...data, providers: data.providers ?? [] });
      setPassword('');
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 OpenCode 配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { ...cfg, password: password || undefined };
      delete payload.hasPassword;
      const data = await api.put<OpencodeConfig>('/api/config/opencode', payload);
      setCfg({ ...DEFAULT_CONFIG, ...data, providers: data.providers ?? [] });
      setPassword('');
      toast.success('OpenCode 配置已保存');
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
      const result = await api.post<OpencodeTestResult>('/api/config/opencode/test', {});
      setTestResult(result);
      if (result.ok) {
        toast.success(`Bun 可用：${result.bunVersion}`);
      } else {
        toast.error(`Bun 不可用：${result.error ?? '未知错误'}`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '测试失败'));
    } finally {
      setTesting(false);
    }
  };

  const updateProvider = (idx: number, patch: Partial<OpencodeProvider>): void => {
    setCfg((c) => ({
      ...c,
      providers: c.providers.map((p, i) => i === idx ? { ...p, ...patch } : p),
    }));
  };
  const addProvider = (): void => {
    setCfg((c) => ({
      ...c,
      providers: [...c.providers, { id: '', name: '', apiKey: '', baseURL: '', models: [] }],
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
        <h2 className="text-lg font-semibold mb-1">OpenCode 引擎</h2>
        <p className="text-sm text-muted-foreground">
          配置 OpenCode 作为 DeepThink 的 Agent 执行引擎。OpenCode 通过
          <code className="mx-1 px-1 py-0.5 bg-muted rounded text-xs">opencode serve</code>
          HTTP/SSE API 接入，需预装 Bun 运行时 + opencode 源码（Bun + TypeScript + Effect）。
        </p>
      </div>

      <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
        <div>
          <Label className="text-base">启用 OpenCode 引擎</Label>
          <p className="text-xs text-muted-foreground mt-1">
            开启后可在主对话顶部切换为 OpenCode 引擎
          </p>
        </div>
        <Switch
          checked={cfg.enabled}
          onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="opencode-bun">Bun 二进制路径</Label>
        <Input
          id="opencode-bun"
          value={cfg.bunPath}
          onChange={(e) => setCfg({ ...cfg, bunPath: e.target.value })}
          placeholder="/opt/homebrew/bin/bun 或留空让 DeepThink 自动安装"
        />
        <p className="text-xs text-muted-foreground">
          bun 可执行文件路径。可通过 <code>which bun</code> 查找。留空时宿主机模式启动会自动下载 bun v1.3.14 到 <code>data/bin/</code>。要求 bun@1.3.14+。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="opencode-source">OpenCode 源码入口路径</Label>
        <Input
          id="opencode-source"
          value={cfg.opencodePath}
          onChange={(e) => setCfg({ ...cfg, opencodePath: e.target.value })}
          placeholder="/Users/xingzhi/opencode/packages/opencode/src/index.ts"
        />
        <p className="text-xs text-muted-foreground">
          opencode 仓库的 packages/opencode/src/index.ts 文件路径。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="opencode-host">监听地址</Label>
          <Input
            id="opencode-host"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="127.0.0.1"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="opencode-baseport">起始端口</Label>
          <Input
            id="opencode-baseport"
            type="number"
            value={cfg.basePort}
            onChange={(e) => setCfg({ ...cfg, basePort: Number(e.target.value) || 0 })}
            placeholder="15000"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="opencode-portrange">端口池大小</Label>
        <Input
          id="opencode-portrange"
          type="number"
          value={cfg.portRange}
          onChange={(e) => setCfg({ ...cfg, portRange: Number(e.target.value) || 0 })}
          placeholder="100"
        />
        <p className="text-xs text-muted-foreground">
          每个会话随机选取端口在 [basePort, basePort+portRange) 区间。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="opencode-password">OPENCODE_SERVER_PASSWORD</Label>
        <Input
          id="opencode-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={cfg.hasPassword ? '（已设置，留空保留原值）' : '输入新密码'}
        />
        <p className="text-xs text-muted-foreground">
          用于 Basic Auth（用户名固定 opencode）。留空保存时保留原值。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="opencode-provider">默认 Provider ID</Label>
          <Input
            id="opencode-provider"
            value={cfg.providerID}
            onChange={(e) => setCfg({ ...cfg, providerID: e.target.value })}
            placeholder="anthropic"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="opencode-model">默认 Model ID</Label>
          <Input
            id="opencode-model"
            value={cfg.modelID}
            onChange={(e) => setCfg({ ...cfg, modelID: e.target.value })}
            placeholder="claude-sonnet-4-6"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="opencode-working-dir">工作目录</Label>
        <Input
          id="opencode-working-dir"
          value={cfg.workingDir}
          onChange={(e) => setCfg({ ...cfg, workingDir: e.target.value })}
          placeholder="/workspace/group"
        />
        <p className="text-xs text-muted-foreground">
          opencode serve 启动时的 cwd，也是 ?directory= 查询参数。
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">LLM Provider 配置</Label>
            <p className="text-xs text-muted-foreground mt-1">
              引擎启动时会动态生成 <code>opencode.jsonc</code> 并通过 <code>OPENCODE_CONFIG</code> 注入，无需手动编辑 <code>~/.opencode/opencode.jsonc</code>。
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
                    <Label className="text-xs">ID</Label>
                    <Input
                      value={p.id}
                      onChange={(e) => updateProvider(i, { id: e.target.value })}
                      placeholder="anthropic"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">名称</Label>
                    <Input
                      value={p.name}
                      onChange={(e) => updateProvider(i, { name: e.target.value })}
                      placeholder="Anthropic"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    value={p.baseURL}
                    onChange={(e) => updateProvider(i, { baseURL: e.target.value })}
                    placeholder="https://api.anthropic.com/v1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Models（逗号分隔）</Label>
                  <Input
                    value={p.models.join(', ')}
                    onChange={(e) => updateProvider(i, { models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                    placeholder="claude-sonnet-4-6, claude-opus-4-7"
                  />
                </div>
                <div>
                  <Label className="text-xs">API Key</Label>
                  <Input
                    type="password"
                    value={p.apiKey ?? ''}
                    onChange={(e) => updateProvider(i, { apiKey: e.target.value })}
                    placeholder={p.hasApiKey ? '已保存（留空保留原值）' : 'sk-...'}
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
          测试 Bun
        </Button>
        {testResult ? (
          <span className={`text-sm flex items-center gap-1 ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
            {testResult.ok ? <Check className="w-3.5 h-3.5" /> : null}
            {testResult.ok ? `Bun ${testResult.bunVersion}` : `不可用 - ${testResult.error}`}
          </span>
        ) : null}
      </div>

      {cfg.updatedAt ? (
        <p className="text-xs text-muted-foreground">最后更新：{new Date(cfg.updatedAt).toLocaleString()}</p>
      ) : null}

      <div className="p-3 rounded-md bg-muted/40 text-xs text-muted-foreground">
        <p className="font-medium mb-1">说明</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Provider 配置在 DeepThink 内管理，引擎启动时动态生成临时 <code>opencode.jsonc</code>（路径 <code>data/sessions/&lt;folder&gt;/.opencode/</code>）</li>
          <li>切换到 OpenCode 引擎后会开新会话（不重放历史）</li>
          <li>OpenCode 引擎下 Agent 可使用 DeepThink 内置 MCP 工具（send_message / schedule_task / memory_*），通过 mcp-bridge 桥接</li>
          <li>Bun 未安装时宿主机模式自动下载到 <code>data/bin/bun-v1.3.14/</code>；容器模式需预先指定路径</li>
          <li>每个 agent-runner 进程启动独立的 opencode serve 实例（随机端口）</li>
        </ul>
      </div>
    </div>
  );
}
