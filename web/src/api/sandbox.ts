import { api } from './client';

export interface SandboxSession {
  id: string;
  userId: string;
  containerName: string;
  language: 'python' | 'node' | 'sh';
  browserEnabled: boolean;
  status: 'created' | 'running' | 'idle' | 'stopped' | 'error';
  createdAt: number;
  lastActiveAt: number;
  stoppedAt: number | null;
  stoppedReason: string | null;
  cdpPort: number | null;
}

export interface SandboxExecResult {
  executionId: string;
  sessionId: string;
  status: 'completed' | 'timeout' | 'oom' | 'killed' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxExecution {
  id: string;
  session_id: string;
  language: string;
  code_hash: string;
  status: string;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated: number;
  duration_ms: number;
  created_at: number;
}

export const sandboxApi = {
  listSessions: () => api.get<{ sessions: SandboxSession[] }>('/api/sandbox/sessions'),
  createSession: (opts: { language?: string; browserEnabled?: boolean; ttlMinutes?: number }) =>
    api.post<SandboxSession>('/api/sandbox/sessions', opts),
  getSession: (id: string) => api.get<SandboxSession>(`/api/sandbox/sessions/${id}`),
  destroySession: (id: string) => api.delete<{ ok: boolean }>(`/api/sandbox/sessions/${id}`),
  execute: (id: string, body: { language: string; code: string; stdin?: string; timeoutMs?: number }) =>
    api.post<SandboxExecResult>(`/api/sandbox/sessions/${id}/execute`, body, 120_000),
  listExecutions: (id: string) =>
    api.get<{ executions: SandboxExecution[] }>(`/api/sandbox/sessions/${id}/executions`),
  browserStart: (id: string, url?: string) =>
    api.post<{ ok: boolean; started: boolean }>(`/api/sandbox/sessions/${id}/browser/start`, url ? { url } : {}),
  browserNavigate: (id: string, url: string) =>
    api.post<{ ok: boolean; url: string }>(`/api/sandbox/sessions/${id}/browser/navigate`, { url }),
  browserClick: (id: string, selector: string) =>
    api.post<{ ok: boolean }>(`/api/sandbox/sessions/${id}/browser/click`, { selector }),
  browserType: (id: string, selector: string, text: string) =>
    api.post<{ ok: boolean }>(`/api/sandbox/sessions/${id}/browser/type`, { selector, text }),
  browserScreenshot: (id: string) =>
    api.post<{ screenshot: string; title: string | null; url: string | null }>(`/api/sandbox/sessions/${id}/browser/screenshot`),
  browserEvaluate: (id: string, script: string) =>
    api.post<{ value: unknown }>(`/api/sandbox/sessions/${id}/browser/evaluate`, { script }),
  browserStop: (id: string) =>
    api.post<{ ok: boolean }>(`/api/sandbox/sessions/${id}/browser/stop`),
  getByGroup: (groupFolder: string) =>
    api.get<{ sessionId: string | null; status?: string; browserEnabled?: boolean }>(`/api/sandbox/by-group/${groupFolder}`),
  listFiles: (id: string, path: string) =>
    api.get<{ path: string; entries: SandboxFileEntry[] }>(`/api/sandbox/sessions/${id}/files?path=${encodeURIComponent(path)}`),
};

export interface SandboxFileEntry {
  name: string;
  type: 'file' | 'dir' | 'link';
  size: number;
  mtime: string;
}
