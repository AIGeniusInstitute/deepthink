/**
 * FLM 闭环执行与安全机制（PRD F5）。
 *
 * 这条链的设计意图只有一句话：**任何自动改动都不能"直接上线"**。
 * 生成 → 门禁 → 灰度 → 观察 → 放量/回滚，每一步都可拦截、可回退、可审计。
 *
 * 三个安全装置（对应 PRD 风险表里的三重保护）：
 *   1. 回归门禁（F5.2）—— 劣化版本在进入灰度**之前**就被拦下
 *   2. 强制人工审核（F5.5）—— 安全合规类改动绕过自动化，必须人签字
 *   3. 自动回滚（F5.4）—— 灰度期真出事了，60 秒内退回上一稳定版本
 */

import { randomUUID } from 'node:crypto';
import { readConfig, type FlmConfig } from './flm-config.js';
import {
  activeStrategy,
  getStrategy,
  insertAlert,
  insertAudit,
  insertAction,
  listEvaluations,
  listStrategies,
  nextPublishTime,
  updateStrategyStatus,
  type FlmStrategyRow,
} from './flm-db.js';
import type { GateStatus, StrategyType, VersionComparison } from './flm-types.js';

// ── 审计（AC-F5.6）───────────────────────────────────────────────────

export type AuditAction =
  | 'generate'
  | 'gate_passed'
  | 'gate_blocked'
  | 'canary'
  | 'gray_adjust'
  | 'release'
  | 'rollback'
  | 'human_review';

/** 写一条审计。所有状态变更都必须经过这里 —— 没有例外，否则时间线会有洞。 */
export function audit(
  versionId: string | null,
  action: AuditAction,
  detail: string,
  actor = 'system',
): void {
  insertAudit({
    id: `aud_${randomUUID()}`,
    version_id: versionId,
    action,
    detail,
    actor,
    created_at: Date.now(),
  });
}

// ── 回归门禁（AC-F5.2、TC-FLM-21）────────────────────────────────────

/** 门禁看的核心指标。每一项都有方向：越高越好 or 越低越好。 */
export interface CoreMetrics {
  successRate: number;
  satisfaction: number;
  qualityMean: number;
  correctionRate: number;
  avgLatencyMs: number;
  avgCostTokens: number;
}

export const CORE_METRIC_DEFS: Array<{ key: keyof CoreMetrics; label: string; higherIsBetter: boolean }> = [
  { key: 'successRate', label: '任务成功率', higherIsBetter: true },
  { key: 'satisfaction', label: '用户满意度', higherIsBetter: true },
  { key: 'qualityMean', label: '质量均分', higherIsBetter: true },
  { key: 'correctionRate', label: '纠偏成功率', higherIsBetter: true },
  { key: 'avgLatencyMs', label: '平均时延', higherIsBetter: false },
  { key: 'avgCostTokens', label: '平均成本', higherIsBetter: false },
];

export interface MetricDegradation {
  key: keyof CoreMetrics;
  label: string;
  baseline: number;
  candidate: number;
  delta: number;
  /** 劣化幅度（百分点 / 相对百分比）。正数 = 变差。 */
  degradation: number;
  unit: 'pct' | 'relative';
  breached: boolean;
}

export interface GateReport {
  gateStatus: GateStatus;
  thresholdPct: number;
  degradations: MetricDegradation[];
  /** 只有被拦截时才有值 —— 门禁要给出"劣化在哪"，不能只说"没过"。 */
  blockedBy: string[];
  summary: string;
}

/**
 * 回归门禁（AC-F5.2）。
 *
 * 劣化口径按指标性质分两种：
 *   - 比率型（成功率/满意度/质量分/纠偏率）：看**百分点**差值，直观且不受基数影响
 *   - 量纲型（时延/成本）：看**相对百分比**变化，因为 100ms→200ms 和 10s→20s 的
 *     绝对差都是"翻倍"，但危险程度不同，绝对差值没有可比性
 *
 * 任一项劣化超过阈值即拦截，并把全部劣化项列出（不是只报第一项）。
 */
export function runRegressionGate(
  baseline: CoreMetrics,
  candidate: CoreMetrics,
  config: FlmConfig = readConfig(),
): GateReport {
  const threshold = config.gateThresholdPct;
  const degradations: MetricDegradation[] = [];

  for (const def of CORE_METRIC_DEFS) {
    const b = baseline[def.key] ?? 0;
    const c = candidate[def.key] ?? 0;
    const delta = c - b;

    const isRatio = def.key === 'successRate' || def.key === 'satisfaction' || def.key === 'qualityMean' || def.key === 'correctionRate';
    let degradation: number;
    if (isRatio) {
      // 比率型：直接取百分点差，只在变差时计为正。
      degradation = def.higherIsBetter ? -delta : delta;
    } else {
      // 量纲型：相对变化率。基数为 0 时无从判断，记为 0（不冤杀）。
      degradation = b === 0 ? 0 : (def.higherIsBetter ? -delta : delta) / Math.abs(b) * 100;
    }

    degradations.push({
      key: def.key,
      label: def.label,
      baseline: Number(b.toFixed(4)),
      candidate: Number(c.toFixed(4)),
      delta: Number(delta.toFixed(4)),
      degradation: Number(degradation.toFixed(4)),
      unit: isRatio ? 'pct' : 'relative',
      breached: degradation > threshold,
    });
  }

  const blockedBy = degradations.filter((d) => d.breached).map((d) => d.label);
  const gateStatus: GateStatus = blockedBy.length > 0 ? 'blocked' : 'passed';

  const summary =
    gateStatus === 'blocked'
      ? `门禁拦截：${blockedBy.length} 项核心指标劣化超过 ${threshold} 阈值（${blockedBy.join('、')}）`
      : `门禁通过：全部 ${degradations.length} 项核心指标劣化均在 ${threshold} 阈值内`;

  return { gateStatus, thresholdPct: threshold, degradations, blockedBy, summary };
}

/**
 * 提交版本过门禁（TC-FLM-21/22 的前置）。
 *
 * 顺序即安全：先查人工审核（F5.5），再审门禁（F5.2）。安全类改动哪怕指标再好，
 * 没签字也不放行 —— 所以审核检查必须在门禁之前，否则会出现"指标过了但没审"的窗口。
 */
export function submitForGate(
  versionId: string,
  baseline: CoreMetrics,
  candidate: CoreMetrics,
  actor = 'admin',
): { ok: boolean; report: GateReport | null; blockedReason?: string } {
  const version = getStrategy(versionId);
  if (!version) return { ok: false, report: null, blockedReason: '版本不存在' };

  audit(versionId, 'generate', `版本提交门禁评测，触发来源：${version.trigger_source}`, actor);

  if (version.requires_human_review === 1 && !version.reviewed_by) {
    updateStrategyStatus(versionId, { gateStatus: 'blocked' });
    audit(versionId, 'gate_blocked', '涉及安全合规，未通过人工审核，禁止放量', actor);
    insertAlert({
      id: `alert_${randomUUID()}`,
      metric: 'human_review_required',
      threshold: 'reviewed_by != null',
      actual: 'pending',
      level: 'warning',
      message: `版本 ${versionId} 涉及安全合规，等待人工审核`,
      acked: 0,
      created_at: Date.now(),
    });
    return { ok: false, report: null, blockedReason: '涉及安全合规的策略变更必须先通过人工审核' };
  }

  const report = runRegressionGate(baseline, candidate);
  updateStrategyStatus(versionId, {
    gateStatus: report.gateStatus,
    evalReport: JSON.stringify(report),
  });
  audit(
    versionId,
    report.gateStatus === 'blocked' ? 'gate_blocked' : 'gate_passed',
    report.summary,
    actor,
  );

  return { ok: report.gateStatus === 'passed', report };
}

// ── 灰度发布（AC-F5.3、TC-FLM-22/23）────────────────────────────────

export const MIN_GRAY_RATIO = 1;

/**
 * 灰度放量。
 *
 * 前置条件三连：门禁已过、比例 ≥ 1%（AC-F5.3 的最小 1%）、不超过 100%。
 * 比例到 100% 即视为正式发布（`released`）—— 100% 灰度和全量发布在语义上没有区别，
 * 分成两个状态只会让状态机多一条永远不会被正确维护的分支。
 */
export function setCanary(
  versionId: string,
  ratio: number,
  actor = 'admin',
): { ok: boolean; version?: FlmStrategyRow; error?: string } {
  const version = getStrategy(versionId);
  if (!version) return { ok: false, error: '版本不存在' };

  if (version.requires_human_review === 1 && !version.reviewed_by) {
    return { ok: false, error: '涉及安全合规，未通过人工审核，禁止放量' };
  }
  if (version.gate_status !== 'passed' && version.gate_status !== 'na') {
    return { ok: false, error: `门禁状态为 ${version.gate_status}，未通过的版本不可放量` };
  }
  if (!Number.isFinite(ratio) || ratio < MIN_GRAY_RATIO || ratio > 100) {
    return { ok: false, error: `灰度比例必须在 ${MIN_GRAY_RATIO}–100 之间` };
  }

  const rounded = Math.round(ratio);
  const isFull = rounded >= 100;

  // 放量前把同类型的上一个 canary 收掉，避免同一策略同时有两个灰度版本分流。
  for (const other of listStrategies({ strategyType: version.strategy_type, status: 'canary' })) {
    if (other.version_id !== versionId) {
      updateStrategyStatus(other.version_id, { status: 'archived', grayRatio: 0 });
      audit(other.version_id, 'gray_adjust', `被新灰度版本 ${versionId} 取代，归档`, actor);
    }
  }

  updateStrategyStatus(versionId, {
    status: isFull ? 'released' : 'canary',
    grayRatio: rounded,
    // 单调时间戳：同一毫秒内连续放量时，publish_time 的全序才是可靠的（见 nextPublishTime）。
    publishTime: nextPublishTime(),
    publisher: actor,
  });
  audit(
    versionId,
    isFull ? 'release' : version.status === 'canary' ? 'gray_adjust' : 'canary',
    isFull ? `全量发布（100%）` : `灰度放量至 ${rounded}%`,
    actor,
  );

  insertAction({
    action_id: `act_${randomUUID()}`,
    eval_id: null,
    action_type: isFull ? 'release' : 'strategy_update',
    before_version: version.parent_version,
    after_version: versionId,
    executor: actor,
    result: isFull ? 'released' : 'canary',
    detail: isFull ? '全量发布' : `灰度 ${rounded}%`,
    exec_time: Date.now(),
  });

  return { ok: true, version: getStrategy(versionId) };
}

/** 人工审核签字（AC-F5.5）。签完字仍需过门禁 —— 审核是必要条件，不是充分条件。 */
export function approveHumanReview(
  versionId: string,
  reviewer: string,
  note: string,
): { ok: boolean; error?: string } {
  const version = getStrategy(versionId);
  if (!version) return { ok: false, error: '版本不存在' };
  if (version.requires_human_review !== 1) {
    return { ok: false, error: '该版本未标记强制人工审核，无需签字' };
  }
  updateStrategyStatus(versionId, { reviewedBy: `${reviewer}: ${note}` });
  audit(versionId, 'human_review', `人工审核通过：${note}`, reviewer);
  return { ok: true };
}

// ── 自动回滚（AC-F5.4、TC-FLM-24）───────────────────────────────────

export interface RollbackResult {
  rolledBack: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  elapsedMs: number;
  reason: string;
}

/**
 * 灰度期指标劣化 → 自动回滚（AC-F5.4）。
 *
 * 回滚是**状态翻转 + 归档**，不是删除 —— 出问题的版本必须留在版本库里供事后分析。
 * 恢复目标取该策略类型下最近一个 `released` 版本排除自身；找不到就退回 `archived`
 * 之外的空档（此时告警提示需人工指定）。找不到稳定版本这件事本身必须告警，不能静默。
 *
 * 耗时：本函数是纯 DB 状态翻转，无网络等待，实测远低于 60 秒上限。
 * `elapsedMs` 如实返回实测值，不写死。
 */
export function autoRollback(
  versionId: string,
  reason: string,
  actor = 'auto-guard',
): RollbackResult {
  const started = Date.now();
  const version = getStrategy(versionId);
  if (!version) {
    return { rolledBack: false, fromVersion: null, toVersion: null, elapsedMs: 0, reason: '版本不存在' };
  }

  const previous = findPreviousStable(version.strategy_type, versionId);

  updateStrategyStatus(versionId, { status: 'rolled_back', grayRatio: 0 });
  if (previous) {
    updateStrategyStatus(previous.version_id, { status: 'released' });
  }

  const elapsedMs = Date.now() - started;
  const detail = previous
    ? `回滚 ${versionId} → ${previous.version_id}，原因：${reason}，耗时 ${elapsedMs}ms`
    : `回滚 ${versionId} 至无可用稳定版本，原因：${reason}，耗时 ${elapsedMs}ms`;

  audit(versionId, 'rollback', detail, actor);
  if (previous) audit(previous.version_id, 'rollback', `因 ${versionId} 回滚而恢复生效`, actor);

  insertAction({
    action_id: `act_${randomUUID()}`,
    eval_id: null,
    action_type: 'rollback',
    before_version: versionId,
    after_version: previous?.version_id ?? null,
    executor: actor,
    result: 'rolled_back',
    detail,
    exec_time: Date.now(),
  });

  insertAlert({
    id: `alert_${randomUUID()}`,
    metric: 'canary_regression',
    threshold: String(readConfig().gateThresholdPct),
    actual: reason,
    level: previous ? 'warning' : 'critical',
    message: detail,
    acked: 0,
    created_at: Date.now(),
  });

  return {
    rolledBack: true,
    fromVersion: versionId,
    toVersion: previous?.version_id ?? null,
    elapsedMs,
    reason: detail,
  };
}

/** 找同类型下最近一个曾经 released 的版本（排除自身）。 */
function findPreviousStable(type: StrategyType, excludeId: string): FlmStrategyRow | undefined {
  const candidates = listStrategies({ strategyType: type, limit: 500 }).filter(
    (v) => v.version_id !== excludeId && v.publish_time != null,
  );
  // 全序排序：publish_time 相同时退到 created_at，再退到 version_id。
  // 只按 publish_time 排会在时间戳撞毫秒时留下未定义次序 —— 回滚会挑错版本。
  candidates.sort(
    (a, b) =>
      (b.publish_time ?? 0) - (a.publish_time ?? 0) ||
      b.created_at - a.created_at ||
      (a.version_id < b.version_id ? 1 : a.version_id > b.version_id ? -1 : 0),
  );
  return candidates[0];
}

/**
 * 灰度期劣化巡检（AC-F5.4 的触发条件）。
 *
 * 只看 canary 状态的版本：released 是稳定态，不需要每次巡检都判它；draft 还没上线。
 * 劣化判据与门禁同源（runRegressionGate），避免"门禁说没事、回滚说有事"的双标。
 */
export function checkCanaryRegression(
  baselineByType: Map<StrategyType, CoreMetrics>,
  currentByType: Map<StrategyType, CoreMetrics>,
): RollbackResult[] {
  const results: RollbackResult[] = [];
  for (const v of listStrategies({ status: 'canary' })) {
    const baseline = baselineByType.get(v.strategy_type);
    const current = currentByType.get(v.strategy_type);
    if (!baseline || !current) continue;

    const report = runRegressionGate(baseline, current);
    if (report.gateStatus === 'blocked') {
      results.push(autoRollback(v.version_id, report.summary));
    }
  }
  return results;
}

// ── 版本对比（AC-F6.4）───────────────────────────────────────────────

/**
 * 两版本 A/B 指标对比。
 *
 * `shouldRelease` 的判据就是门禁结论 —— 对比视图给出"是否放量"的建议，不能和门禁
 * 各说各话。若 B 是劣化版本，这里直接说"不建议放量"。
 */
export function compareVersions(
  versionA: string,
  versionB: string,
  metricsA: CoreMetrics,
  metricsB: CoreMetrics,
  labels: { a?: string; b?: string } = {},
): VersionComparison {
  const report = runRegressionGate(metricsA, metricsB);

  return {
    a: labels.a ?? versionA,
    b: labels.b ?? versionB,
    metrics: report.degradations.map((d) => ({
      name: d.label,
      a: d.baseline,
      b: d.candidate,
      delta: d.delta,
      verdict: d.breached ? 'regressed' : d.degradation < 0 ? 'improved' : 'neutral',
    })),
    recommendation: report.summary,
    shouldRelease: report.gateStatus === 'passed',
  };
}

// ── 看板聚合（PRD F6.1，供 flm-insights 复用）────────────────────────

/** 当前生效版本，供灰度分流判定。 */
export function currentVersion(type: StrategyType): FlmStrategyRow | undefined {
  return activeStrategy(type);
}

/**
 * 分流判定：这个 key 是否走当前生效版本（AC-F5.3 的"按流量比例"）。
 *
 * 用哈希取模而不是 Math.random —— 同一个会话在整个灰度期必须**固定**落在新版本或
 * 旧版本上，否则同一用户一会儿新一会儿旧，指标完全没法归因。
 *
 * `released` 视为比例 100：已发布的版本就是对全部流量生效，返回 false 会与实际
 * 路由行为相反。
 */
export function isInCanary(
  type: StrategyType,
  key: string,
): { inCanary: boolean; ratio: number; versionId: string | null; status: string | null } {
  const v = activeStrategy(type);
  if (!v) return { inCanary: false, ratio: 0, versionId: null, status: null };
  if (v.status === 'released') {
    return { inCanary: true, ratio: 100, versionId: v.version_id, status: v.status };
  }
  if (v.status !== 'canary') {
    return { inCanary: false, ratio: 0, versionId: v.version_id, status: v.status };
  }
  return {
    inCanary: createHashSafe(key) < v.gray_ratio,
    ratio: v.gray_ratio,
    versionId: v.version_id,
    status: v.status,
  };
}

function createHashSafe(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

/** 供路由层直接取用的评价列表（门禁基线计算用）。 */
export function evaluationsForMetrics(limit = 500) {
  return listEvaluations({ limit });
}
