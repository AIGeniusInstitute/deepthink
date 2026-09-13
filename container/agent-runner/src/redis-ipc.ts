/**
 * Redis IPC for Agent Runner — Distributed Mode
 *
 * When REDIS_URL is set and AGENT_RUNNER_MODE=distributed:
 *   - Task input received via Redis pub/sub (replaces stdin)
 *   - IPC input messages via Redis (replaces file-system sentinel/watch)
 *   - IPC output messages via Redis (replaces file-system writeIpcFile)
 *
 * When REDIS_URL is not set: all functions are no-ops, agent-runner
 * falls back to the file-system IPC path (single-pod child-process mode).
 */

const REDIS_URL = process.env.REDIS_URL || '';
const AGENT_RUNNER_MODE = process.env.AGENT_RUNNER_MODE || '';

export const distributedMode = !!REDIS_URL && AGENT_RUNNER_MODE === 'distributed';

let _pub: any = null;
let _sub: any = null;
let _task: any = null;  // dedicated BLPOP connection — must NOT be shared with _pub
let _connected = false;
let _workerId = ''; // pod-level unique worker ID for pool registration

const TASK_QUEUE_CHANNEL = 'deepthink:agent-tasks';
const IPC_INPUT_PREFIX = 'deepthink:ipc:';
const IPC_OUTPUT_PREFIX = 'deepthink:ipc-out:';
const IPC_TASK_PREFIX = 'deepthink:ipc-task:';

/** Initialize Redis connections. Call once at startup if distributedMode. */
export async function initRedisIpc(): Promise<void> {
  if (!distributedMode) return;
  try {
    const { createClient } = await import('redis');
    _pub = createClient({ url: REDIS_URL });
    _sub = createClient({ url: REDIS_URL });
    _task = createClient({ url: REDIS_URL });  // dedicated connection for BLPOP
    _pub.on('error', () => {});
    _sub.on('error', () => {});
    _task.on('error', () => {});
    await _pub.connect();
    await _sub.connect();
    await _task.connect();
    _connected = true;
    // Worker registration: signal that this agent-runner is ready for tasks.
    // Use hostname (unique per pod) instead of process.pid (=1 in containers,
    // so sAdd deduplicates identical PIDs across pods and the pool stays empty).
    _workerId = process.env.HOSTNAME || `runner-${process.pid}-${Date.now()}`;
    await _pub.sAdd('deepthink:agent-runners:pool', _workerId).catch(() => {});
    console.log('[redis-ipc] Connected — distributed agent-runner mode active');
  } catch (err) {
    console.error('[redis-ipc] Failed to connect, falling back to file-system mode:', err);
    _connected = false;
  }
}

/** Is Redis IPC connected? */
export function isRedisIpcConnected(): boolean {
  return _connected;
}

/** Wait for a task from the Redis queue (replaces readStdin in distributed mode). */
export function waitForTask(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_connected) {
      reject(new Error('Redis not connected'));
      return;
    }
    // Use the dedicated _task connection for BLPOP, NOT _pub.
    // _pub is shared with publishIpcOutput — if BLPOP blocks on _pub
    // and a publish is queued, node-redis can stall the connection
    // causing BLPOP to not return for minutes after LPUSH.
    _task
      .blPop(TASK_QUEUE_CHANNEL, 0)
      .then((res: any) => {
        try {
          const raw = res?.element ?? res?.[1] ?? res;
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`Failed to parse task: ${err}`));
        }
      })
      .catch((err: unknown) => reject(new Error(`Failed to BRPOP task: ${String(err)}`)));
  });
}

/**
 * Subscribe to IPC input channel for a group folder.
 * Returns an unsubscribe function.
 * Messages arrive as { type: 'message' | '_close' | '_drain' | '_interrupt', text, images, ... }
 */
export async function subscribeIpcInput(
  groupFolder: string,
  handler: (payload: any) => void,
): Promise<() => void> {
  if (!_connected) return () => {};
  const channel = IPC_INPUT_PREFIX + groupFolder;
  await _sub.subscribe(channel, (raw: string) => {
    try {
      handler(JSON.parse(raw));
    } catch (err) {
      console.error('[redis-ipc] Failed to parse input message:', err);
    }
  });
  return () => {
    try { _sub.unsubscribe(channel); } catch { /* ignore */ }
  };
}

/** Publish an output message (send_message result, task request) via Redis. */
export async function publishIpcOutput(
  groupFolder: string,
  subdir: 'messages' | 'tasks',
  payload: any,
): Promise<void> {
  if (!_connected) {
    console.error('[redis-ipc] publishIpcOutput skipped: not connected');
    return;
  }
  const channel = `${IPC_OUTPUT_PREFIX}${groupFolder}:${subdir}`;
  try {
    const result = await _pub.publish(channel, JSON.stringify(payload));
    console.error(`[redis-ipc] Published to ${channel}: ${result} subscribers, payload type=${payload.type}, status=${payload.output?.status}`);
  } catch (err) {
    console.error('[redis-ipc] Failed to publish output:', err);
  }
}

/** Publish a task request and wait for result (replaces pollIpcResult). */
export async function requestTaskResult(
  groupFolder: string,
  requestPayload: any,
  requestId: string,
  timeoutMs = 30000,
): Promise<any> {
  if (!_connected) {
    throw new Error('Redis not connected');
  }
  const resultChannel = `${IPC_TASK_PREFIX}${groupFolder}:${requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { _sub.unsubscribe(resultChannel); } catch { /* ignore */ }
      reject(new Error(`Task result timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    _sub.subscribe(resultChannel, (raw: string) => {
      clearTimeout(timer);
      try { _sub.unsubscribe(resultChannel); } catch { /* ignore */ }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Failed to parse task result: ${err}`));
      }
    }).catch(() => {
      clearTimeout(timer);
      reject(new Error('Failed to subscribe to result channel'));
    });

    // Publish the request
    publishIpcOutput(groupFolder, 'tasks', { ...requestPayload, requestId }).catch(() => {});
  });
}

/** Unregister this agent-runner from the pool and close connections. */
export async function closeRedisIpc(): Promise<void> {
  try {
    if (_pub && _workerId) {
      await _pub.sRem('deepthink:agent-runners:pool', _workerId).catch(() => {});
    }
  } catch { /* ignore */ }
  const tasks: Promise<void>[] = [];
  if (_pub) tasks.push(_pub.quit().then(() => {}).catch(() => {}));
  if (_sub) tasks.push(_sub.quit().then(() => {}).catch(() => {}));
  if (_task) tasks.push(_task.quit().then(() => {}).catch(() => {}));
  await Promise.allSettled(tasks);
  _pub = null;
  _sub = null;
  _task = null;
  _connected = false;
  console.log('[redis-ipc] Connections closed');
}
