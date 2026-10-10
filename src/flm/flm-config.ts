/**
 * FLM 模块配置。
 *
 * 全部配置放在 flm_config 这张 KV 表里（而不是环境变量 / JSON 文件），因为
 * PRD 要求「脱敏规则可热更新」「采样率改动即时生效」—— KV 表读起来就是最新值，
 * 不需要重启，也不需要四处找配置源。
 *
 * 读取一律经过 readConfig()：它先查表、再回落默认值，并且**永不抛异常**
 * （配置读失败不能拖垮主链路，PRD AC-F0.2）。
 */

import { getDb } from '../db.js';
import type { FeedbackSource } from './flm-types.js';

/** 脱敏规则。pattern 是正则源串，来源是 admin 配置（非用户输入）。 */
export interface DesensitizeRule {
  name: string;
  pattern: string;
  flags: string;
  mask: string;
}

export interface RetryPolicy {
  maxRetries: number;
  /** 退避序列（毫秒），第 n 次重试用 backoffMs[min(n-1, len-1)]。 */
  backoffMs: number[];
  toolWhitelist: string[];
  /** 纠偏耗时闸门：投影耗时超过原任务该倍数即放弃重试。PRD AC-F4.2 = 2。 */
  maxDurationRatio: number;
}

export interface AlertThresholds {
  /** 成功率相较基线下降多少个百分点触发告警。 */
  successRateDropPct: number;
  /** 错误率超过该绝对值触发告警。 */
  errorRateSpikePct: number;
  /** 单位时间窗内反馈量低于该值视为异常（0 = 不检查）。 */
  feedbackVolumeMin: number;
}

export interface FlmConfig {
  /** 降级开关（PRD AC-F0.1）。false = 停止采集与评价，智能体按"无反馈执行"运行。 */
  enabled: boolean;
  /** 系统日志采集采样率 0–100（PRD AC-F1.2.2）。 */
  sampleRate: number;
  /** 字段白名单；空数组 = 不限字段。 */
  fieldWhitelist: string[];
  retryPolicy: RetryPolicy;
  desensitizeRules: DesensitizeRule[];
  alertThresholds: AlertThresholds;
  /** 回归门禁阈值：核心指标劣化超过该百分点即拦截（PRD F5.2）。 */
  gateThresholdPct: number;
  /** 冲突消解用的来源权重（PRD F2.4）。 */
  sourceWeights: Record<FeedbackSource, number>;
  /** 去重时间窗（秒，PRD F2.5）。 */
  dedupWindowSec: number;
}

/**
 * 默认脱敏规则。覆盖 PRD AC-F2.6 要求的五类：手机号 / 身份证 / 银行卡 / 邮箱 / Token。
 * 规则顺序有意义：先长后短，避免身份证被手机号规则截断。
 */
export const DEFAULT_DESENSITIZE_RULES: DesensitizeRule[] = [
  { name: '身份证', pattern: '\\b\\d{17}[\\dXx]\\b', flags: 'g', mask: '***ID***' },
  { name: '银行卡', pattern: '\\b\\d{16,19}\\b', flags: 'g', mask: '***CARD***' },
  { name: '手机号', pattern: '\\b1[3-9]\\d{9}\\b', flags: 'g', mask: '***PHONE***' },
  { name: '邮箱', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', flags: 'g', mask: '***EMAIL***' },
  {
    name: 'Token',
    pattern: '(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\\s+[A-Za-z0-9._-]{8,})',
    flags: 'g',
    mask: '***TOKEN***',
  },
];

export const DEFAULT_CONFIG: FlmConfig = {
  enabled: true,
  sampleRate: 100,
  fieldWhitelist: [],
  retryPolicy: {
    maxRetries: 2,
    backoffMs: [500, 1500],
    toolWhitelist: [],
    maxDurationRatio: 2,
  },
  desensitizeRules: DEFAULT_DESENSITIZE_RULES,
  alertThresholds: {
    successRateDropPct: 10,
    errorRateSpikePct: 30,
    feedbackVolumeMin: 0,
  },
  gateThresholdPct: 5,
  sourceWeights: { user: 1.0, system: 1.5, env: 1.2 },
  dedupWindowSec: 60,
};

/** 配置项在 flm_config 表里的键名。 */
const KEYS = {
  enabled: 'enabled',
  sampleRate: 'sample_rate',
  fieldWhitelist: 'field_whitelist',
  retryPolicy: 'retry_policy',
  desensitizeRules: 'desensitize_rules',
  alertThresholds: 'alert_thresholds',
  gateThresholdPct: 'gate_threshold_pct',
  sourceWeights: 'source_weights',
  dedupWindowSec: 'dedup_window_sec',
} as const;

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/** 读取全部配置。任何一步失败都回落默认值，不抛。 */
export function readConfig(): FlmConfig {
  try {
    const rows = getDb().prepare('SELECT key, value FROM flm_config').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const str = (k: string) => map.get(k);

    const retry = parseJson<Partial<RetryPolicy>>(str(KEYS.retryPolicy), {});
    const alerts = parseJson<Partial<AlertThresholds>>(str(KEYS.alertThresholds), {});
    const weights = parseJson<Partial<Record<FeedbackSource, number>>>(str(KEYS.sourceWeights), {});
    const rules = parseJson<DesensitizeRule[] | null>(str(KEYS.desensitizeRules), null);
    const whitelist = parseJson<string[] | null>(str(KEYS.fieldWhitelist), null);

    const numOr = (raw: string | undefined, dflt: number) => {
      if (raw == null) return dflt;
      const n = Number(raw);
      return Number.isFinite(n) ? n : dflt;
    };

    return {
      // 只有显式写 'false' 才算关闭 —— 缺省即开启，避免配置读取异常导致静默停摆。
      enabled: str(KEYS.enabled) == null ? DEFAULT_CONFIG.enabled : str(KEYS.enabled) !== 'false',
      sampleRate: Math.max(0, Math.min(100, numOr(str(KEYS.sampleRate), DEFAULT_CONFIG.sampleRate))),
      fieldWhitelist: Array.isArray(whitelist) ? whitelist : DEFAULT_CONFIG.fieldWhitelist,
      retryPolicy: { ...DEFAULT_CONFIG.retryPolicy, ...retry },
      desensitizeRules:
        Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_CONFIG.desensitizeRules,
      alertThresholds: { ...DEFAULT_CONFIG.alertThresholds, ...alerts },
      gateThresholdPct: numOr(str(KEYS.gateThresholdPct), DEFAULT_CONFIG.gateThresholdPct),
      sourceWeights: { ...DEFAULT_CONFIG.sourceWeights, ...weights },
      dedupWindowSec: numOr(str(KEYS.dedupWindowSec), DEFAULT_CONFIG.dedupWindowSec),
    };
  } catch {
    // DB 未初始化 / 表缺失：返回默认值。静默是对的 —— 配置读不到不该阻断主链路。
    return DEFAULT_CONFIG;
  }
}

/** 降级开关。热路径上调用，失败即视为开启（不因配置读不到而停掉反馈）。 */
export function isEnabled(): boolean {
  try {
    const row = getDb()
      .prepare('SELECT value FROM flm_config WHERE key = ?')
      .get(KEYS.enabled) as { value: string } | undefined;
    return row == null ? true : row.value !== 'false';
  } catch {
    return true;
  }
}

export function writeConfig(patch: Partial<FlmConfig>, actor = 'system'): FlmConfig {
  const db = getDb();
  const now = Date.now();
  const put = (key: string, value: string) => {
    db.prepare(
      `INSERT OR REPLACE INTO flm_config (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run(key, value, now);
  };
  if (patch.enabled !== undefined) put(KEYS.enabled, patch.enabled ? 'true' : 'false');
  if (patch.sampleRate !== undefined) put(KEYS.sampleRate, String(patch.sampleRate));
  if (patch.fieldWhitelist !== undefined) put(KEYS.fieldWhitelist, JSON.stringify(patch.fieldWhitelist));
  if (patch.retryPolicy !== undefined) put(KEYS.retryPolicy, JSON.stringify(patch.retryPolicy));
  if (patch.desensitizeRules !== undefined) {
    put(KEYS.desensitizeRules, JSON.stringify(patch.desensitizeRules));
  }
  if (patch.alertThresholds !== undefined) {
    put(KEYS.alertThresholds, JSON.stringify(patch.alertThresholds));
  }
  if (patch.gateThresholdPct !== undefined) put(KEYS.gateThresholdPct, String(patch.gateThresholdPct));
  if (patch.sourceWeights !== undefined) put(KEYS.sourceWeights, JSON.stringify(patch.sourceWeights));
  if (patch.dedupWindowSec !== undefined) put(KEYS.dedupWindowSec, String(patch.dedupWindowSec));
  void actor;
  return readConfig();
}
