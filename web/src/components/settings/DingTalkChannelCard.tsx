import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface UserDingTalkConfig {
  clientId: string;
  hasClientSecret: boolean;
  clientSecretMasked: string | null;
  enabled: boolean;
  streamingMode: 'card' | 'text';
  connected: boolean;
  updatedAt: string | null;
}

export function DingTalkChannelCard() {
  const [config, setConfig] = useState<UserDingTalkConfig | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;
  const streamingMode = config?.streamingMode ?? 'card';

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserDingTalkConfig>(
        '/api/config/user-im/dingtalk',
      );
      setConfig(data);
      setClientId(data.clientId || '');
      setClientSecret('');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    try {
      const data = await api.put<UserDingTalkConfig>(
        '/api/config/user-im/dingtalk',
        { enabled: newEnabled },
      );
      setConfig(data);
      toast.success(`钉钉渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换钉钉渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleStreamingModeToggle = async (useCard: boolean) => {
    try {
      const data = await api.put<UserDingTalkConfig>(
        '/api/config/user-im/dingtalk',
        { streamingMode: useCard ? 'card' : 'text' },
      );
      setConfig(data);
      toast.success(`已切换为${useCard ? '流式卡片' : '普通文本'}模式`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换流式模式失败'));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const id = clientId.trim();
      const secret = clientSecret.trim();

      if (id && !secret && !config?.hasClientSecret) {
        toast.error('首次配置钉钉需要同时提供 AppKey 和 AppSecret');
        setSaving(false);
        return;
      }

      if (!id && !secret) {
        if (config?.clientId || config?.hasClientSecret) {
          toast.info('钉钉配置未变更');
        } else {
          toast.error('请填写钉钉机器人 AppKey 和 AppSecret');
        }
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (id) payload.clientId = id;
      if (secret) payload.clientSecret = secret;
      const data = await api.put<UserDingTalkConfig>(
        '/api/config/user-im/dingtalk',
        payload,
      );
      setConfig(data);
      setClientSecret('');
      toast.success('钉钉配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存钉钉配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await api.post('/api/config/user-im/dingtalk/test');
      toast.success('钉钉连接测试成功');
    } catch (err) {
      toast.error(getErrorMessage(err, '钉钉连接测试失败'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">钉钉</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              通过钉钉机器人接收和回复消息
            </p>
          </div>
        </div>
        <Switch checked={enabled} disabled={loading || toggling} onCheckedChange={handleToggle} />
      </div>

      <div
        className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {config?.hasClientSecret && (
              <div className="text-xs text-slate-500">
                当前 Secret: {config.clientSecretMasked || '已配置'}
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  AppKey (Client ID)
                </label>
                <Input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="输入钉钉机器人 AppKey"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  AppSecret (Client Secret)
                </label>
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    config?.hasClientSecret ? '留空不修改' : '输入钉钉机器人 AppSecret'
                  }
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存钉钉配置
              </Button>
              {config?.hasClientSecret && (
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing}
                >
                  {testing && <Loader2 className="size-4 animate-spin" />}
                  测试连接
                </Button>
              )}
            </div>

            <div className="flex items-center justify-between py-2 border-t border-slate-100">
              <div>
                <p className="text-sm font-medium text-slate-700">流式卡片模式</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {streamingMode === 'card'
                    ? 'AI 回复以打字机效果实时展示'
                    : 'AI 回复以普通文本消息发送'}
                </p>
              </div>
              <Switch
                checked={streamingMode === 'card'}
                onCheckedChange={(checked) => handleStreamingModeToggle(checked)}
              />
            </div>

            <div className="text-xs text-slate-400 mt-2">
              <p>
                获取凭据：钉钉开放平台 → 应用开发 → 企业内部开发 → 机器人配置
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
