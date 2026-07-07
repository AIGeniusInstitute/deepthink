// 在保存用户飞书配置时,先用 (appId, appSecret) 调一次 tenant_access_token 接口,
// 验证凭据真能换出 token。这条防御挡掉两类历史事故:
//  - appId 填成了用户名 / 手机号(没带 cli_ 前缀),schema 已挡;
//  - appId 格式对但凭据错配(复制错应用、appSecret 被废),schema 挡不住,只能靠
//    实际 API 响应识别。
// 飞书 token API 失败时返回非零 code + msg,我们把 code/msg 透传给前端做提示。

const FEISHU_TENANT_TOKEN_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

export interface FeishuConnectivityResult {
  ok: boolean;
  errorCode?: number;
  errorMessage?: string;
}

export async function testFeishuCredentials(
  appId: string,
  appSecret: string,
  options: { timeoutMs?: number; endpoint?: string } = {},
): Promise<FeishuConnectivityResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const endpoint = options.endpoint ?? FEISHU_TENANT_TOKEN_ENDPOINT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        ok: false,
        errorMessage: `Feishu API HTTP ${res.status}`,
      };
    }

    const data = (await res.json().catch(() => null)) as
      | { code?: number; msg?: string; tenant_access_token?: string }
      | null;

    if (!data) {
      return { ok: false, errorMessage: 'Feishu API returned non-JSON body' };
    }

    if (data.code === 0 && data.tenant_access_token) {
      return { ok: true };
    }

    return {
      ok: false,
      errorCode: typeof data.code === 'number' ? data.code : undefined,
      errorMessage: data.msg || 'Feishu API rejected the credentials',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError 在 timeout 时触发,把它翻译成用户能读懂的提示
    if (msg.includes('aborted') || msg.includes('AbortError')) {
      return {
        ok: false,
        errorMessage: `Feishu API request timed out after ${timeoutMs}ms`,
      };
    }
    return { ok: false, errorMessage: msg };
  } finally {
    clearTimeout(timer);
  }
}
