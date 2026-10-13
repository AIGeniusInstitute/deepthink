/**
 * 时间归一 —— 本模块唯一需要区分 SQLite / PostgreSQL 方言的地方。
 *
 * 统一运行视图把 8 个来源 UNION 到一起后要靠 `started_at` 排序与过滤。SQLite 里
 * 时间戳以 ISO 8601 字符串存储，字典序 == 时间序；一旦某个来源的时间列是 epoch
 * 数字（`sandbox_executions.created_at` 就是 INTEGER），排序与范围过滤**静默出错**，
 * 而且错得不明显。所以所有 epoch 列必须先在本文件里换算成同一格式的 ISO 字符串。
 *
 * 格式契约：`YYYY-MM-DDTHH:MM:SS.sssZ`（与 `chat_trace_nodes.started_at` 一致）。
 */

import { isPostgresBackend } from '../sqlite-compat.js';

/**
 * epoch 毫秒列 → ISO 8601 SQL 表达式。
 *
 * PG 侧必须 `AT TIME ZONE 'UTC'`：`to_timestamp()` 返回 timestamptz，`to_char`
 * 会按会话时区渲染，不锁 UTC 的话同一行在不同部署上会得到不同字符串。
 *
 * ⚠️ `col` 一律加括号再除。`col` 允许传算术表达式（`sandbox_executions` 的结束
 * 时刻就是 `created_at + duration_ms`），而 `/` 的优先级高于 `+`：
 *   `created_at + duration_ms / 1000.0`  ≡ `created_at + (duration_ms/1000)`
 * 会算出一个天文数字的 epoch，`strftime` 直接返回 **NULL** —— 不报错，只是这一列
 * 静默变空，沙箱运行的耗时与 P95 统计随之全部失真。
 */
export function epochMsToIso(col: string): string {
  return isPostgresBackend
    ? `to_char(to_timestamp((${col}) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `strftime('%Y-%m-%dT%H:%M:%fZ', (${col}) / 1000.0, 'unixepoch')`;
}

/** ISO 8601 → epoch ms；无法解析返回 null。 */
export function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 两个 ISO 时间之间的毫秒差；任一缺失/非法则 null（而不是 0 —— 0 会被误读成"瞬时完成"）。 */
export function durationMsBetween(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): number | null {
  const a = parseIso(startedAt);
  const b = parseIso(endedAt);
  if (a === null || b === null) return null;
  return Math.max(0, b - a);
}

/** 距今毫秒数；无法解析返回 null。 */
export function ageMs(iso: string | null | undefined, nowMs: number = Date.now()): number | null {
  const t = parseIso(iso);
  return t === null ? null : Math.max(0, nowMs - t);
}

/** 向上取整到整点/整日，用于趋势桶的补齐。 */
export function floorToBucket(iso: string, bucket: 'hour' | 'day'): string {
  return bucket === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10);
}

/**
 * 枚举 [from, to) 之间的全部桶 key，**含没有任何数据的桶**。
 *
 * 必要性：缺桶不补的话，趋势图 x 轴会跳过安静时段，把"早上跑了 3 次、晚上跑了 3 次"
 * 画成相邻两点，视觉上变成一条平线，误导读者以为一直很闲。
 */
export function enumerateBuckets(fromIso: string, toIso: string, bucket: 'hour' | 'day'): string[] {
  const out: string[] = [];
  let t = parseIso(fromIso);
  const end = parseIso(toIso);
  if (t === null || end === null || end <= t) return out;
  // 对齐到桶边界
  const d = new Date(t);
  if (bucket === 'hour') {
    d.setUTCMinutes(0, 0, 0);
  } else {
    d.setUTCHours(0, 0, 0, 0);
  }
  t = d.getTime();
  let guard = 0;
  while (t < end && guard++ < 1000) {
    out.push(floorToBucket(new Date(t).toISOString(), bucket));
    t += bucket === 'hour' ? 3600_000 : 86_400_000;
  }
  return out;
}
