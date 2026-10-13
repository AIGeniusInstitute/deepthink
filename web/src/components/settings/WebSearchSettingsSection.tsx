import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plug } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface ProviderMeta {
  id: string;
  label: string;
  needsKey: boolean;
  defaultBaseUrl: string;
  hint: string;
}

interface ProviderState {
  apiKey: string;
  baseUrl: string;
}

interface ConfigResponse {
  active: string;
  configured: boolean;
  providers: Record<string, ProviderState>;
  providersMeta: ProviderMeta[];
}

interface TestResult {
  status: 'ok' | 'empty' | 'error';
  provider: string;
  results: { title: string; link: string }[];
  latency_ms: number;
  error: string | null;
}

/**
 * The backend gives each search provider 20s (DEFAULT_TIMEOUT_MS in
 * shared/web-search.ts). The client's 8s default would abort first and report a
 * timeout for a request that was still in flight, so widen it past that budget.
 */
const TEST_TIMEOUT_MS = 25_000;

export function WebSearchSettingsSection() {
  const [providersMeta, setProvidersMeta] = useState<ProviderMeta[]>([]);
  const [active, setActive] = useState('bing');
  const [configured, setConfigured] = useState(false);
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({});
  // Typed-but-unsaved keys. Absent = "leave what is stored alone".
  const [typedKeys, setTypedKeys] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const meta = useMemo(
    () => providersMeta.find((p) => p.id === active),
    [providersMeta, active],
  );

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<ConfigResponse>('/api/config/web-search');
      setProvidersMeta(data.providersMeta ?? []);
      setActive(data.active || 'bing');
      setConfigured(data.configured);
      const urls: Record<string, string> = {};
      const hasKey: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(data.providers ?? {})) {
        urls[id] = value.baseUrl ?? '';
        hasKey[id] = value.apiKey === '<masked>';
      }
      setBaseUrls(urls);
      setSavedKeys(hasKey);
      setTypedKeys({});
    } catch (err) {
      toast.error(getErrorMessage(err, '加载搜索配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buildPayload = (): Record<string, unknown> => ({
    provider: active,
    baseUrl: baseUrls[active] ?? '',
    ...(typedKeys[active] ? { apiKey: typedKeys[active] } : {}),
  });

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.put('/api/config/web-search', {
        active,
        providers: {
          [active]: {
            baseUrl: baseUrls[active] ?? '',
            ...(typedKeys[active] ? { apiKey: typedKeys[active] } : {}),
          },
        },
      });
      toast.success('搜索配置已保存', { description: '新的 Agent 会话生效' });
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
      const result = await api.post<TestResult>(
        '/api/config/web-search/test',
        buildPayload(),
        TEST_TIMEOUT_MS,
      );
      setTestResult(result);
      if (result.status === 'ok') {
        toast.success(`连接成功，返回 ${result.results.length} 条结果`);
      } else if (result.status === 'empty') {
        toast.warning('连接成功，但没有返回结果');
      } else {
        toast.error('连接失败', { description: result.error ?? undefined });
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">联网搜索后端</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Agent 的 <code className="text-xs">WebSearch</code> 工具由平台自实现（内置搜索在国内不可用），
          这里选择它实际调用的后端。未配置任何后端时回落到免 key 的 Bing 抓取，保证搜索始终可用。
          修改后对<strong className="font-medium">新建的 Agent 会话</strong>生效。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ws-provider">搜索后端</Label>
        <select
          id="ws-provider"
          className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          value={active}
          onChange={(e) => {
            setActive(e.target.value);
            setTestResult(null);
          }}
        >
          {providersMeta.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.needsKey ? '' : '（免 key）'}
            </option>
          ))}
        </select>
        {meta ? <p className="text-xs text-muted-foreground">{meta.hint}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ws-base">Base URL</Label>
        <Input
          id="ws-base"
          value={baseUrls[active] ?? ''}
          onChange={(e) => setBaseUrls((prev) => ({ ...prev, [active]: e.target.value }))}
          placeholder={meta?.defaultBaseUrl ?? ''}
        />
        <p className="text-xs text-muted-foreground">
          留空则使用默认地址 {meta?.defaultBaseUrl}。
        </p>
      </div>

      {meta?.needsKey ? (
        <div className="space-y-1.5">
          <Label htmlFor="ws-key">API Key</Label>
          <Input
            id="ws-key"
            type="password"
            value={typedKeys[active] ?? ''}
            onChange={(e) => setTypedKeys((prev) => ({ ...prev, [active]: e.target.value }))}
            placeholder={savedKeys[active] ? '已保存，留空则不变' : '粘贴该后端控制台签发的 key'}
          />
          <p className="text-xs text-muted-foreground">
            保存在 data/config/web-search.json（文件权限 0600）。留空不会清除已保存的 key。
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          该后端无需 API Key，直接测试连接即可。
        </p>
      )}

      <div className="flex gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          保存配置
        </Button>
        <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
          {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plug className="w-4 h-4 mr-2" />}
          测试连接
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        测试会拿当前填写的 Key / Base URL 真发一次搜索请求（不必先保存），便于定位欠费、额度或网络问题。
      </p>

      {testResult ? (
        <div className="rounded-lg border border-border p-3 text-sm space-y-1">
          {testResult.status === 'ok' ? (
            <div className="text-emerald-600">
              ✓ 连接成功：{testResult.provider} 返回 {testResult.results.length} 条结果
              （{testResult.latency_ms}ms）
            </div>
          ) : testResult.status === 'empty' ? (
            <div className="text-amber-600">⚠ 请求成功但没有返回结果（{testResult.latency_ms}ms）</div>
          ) : (
            <div className="text-red-600">✗ {testResult.error ?? '未知错误'}</div>
          )}
          {testResult.results.length ? (
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {testResult.results.slice(0, 3).map((r) => (
                <li key={r.link} className="truncate">
                  · {r.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!configured ? (
        <p className="text-xs text-amber-600">
          当前没有保存过搜索配置，Agent 会使用免 key 的 Bing 抓取后端。
        </p>
      ) : null}
    </div>
  );
}
