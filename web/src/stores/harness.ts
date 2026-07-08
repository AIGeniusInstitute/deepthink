import { create } from 'zustand';
import { apiFetch } from '../api/client';

export interface HarnessVersion {
  id: string;
  parent_id: string | null;
  hash: string;
  manifest_json: string;
  status: 'experimental' | 'promoted' | 'archived' | 'rolled_back';
  source: string;
  created_at: string;
  promoted_at: string | null;
  notes: string | null;
  is_promoted?: boolean;
}

export interface HarnessManifest {
  schema_version: number;
  captured_at: string;
  system_prompt: string;
  subagents: Record<string, { description: string; prompt: string; tools: string[]; model: string; maxTurns: number }>;
  tool_signatures: { name: string; description: string }[];
  skill_ids: string[];
  claude_md_hash: string;
  source_files: { path: string; hash: string }[];
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  changed: { field: string; from_preview: string; to_preview: string }[];
}

export interface HarnessProposal {
  id: string;
  proposed_version_id: string;
  baseline_version_id: string;
  hypothesis: string;
  expected_behavior: string;
  mutation_patch: string;
  verdict: 'improved' | 'regressed' | 'neutral' | 'inconclusive' | null;
  evidence_run_ids_json: string | null;
  trace_summary: string | null;
  created_at: string;
  judged_at: string | null;
}

export interface HarnessEvalRun {
  id: string;
  version_id: string;
  proposal_id: string | null;
  case_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  pass: number | null;
  score: number | null;
  trace_node_root_id: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface HarnessEvalCase {
  case_id: string;
  name: string;
  prompt: string;
  assertions: { kind: string; value: string }[];
  rubric: { weights?: Record<string, number>; pass_threshold: number };
}

export interface MetaLoopResult {
  proposalId: string;
  proposedVersionId: string;
  baselineVersionId: string;
  verdict: 'improved' | 'regressed' | 'neutral' | 'inconclusive';
  baselineAggregate: { total: number; passed: number; failed: number; errored: number; score: number };
  proposedAggregate: { total: number; passed: number; failed: number; errored: number; score: number };
  evidenceRunIds: string[];
  traceSummary: string;
}

interface HarnessState {
  versions: HarnessVersion[];
  promotedId: string | null;
  proposals: HarnessProposal[];
  evalCases: HarnessEvalCase[];
  selectedVersionId: string | null;
  loading: boolean;
  error: string | null;
  fetchVersions: () => Promise<void>;
  fetchProposals: () => Promise<void>;
  fetchEvalCases: () => Promise<void>;
  selectVersion: (id: string | null) => void;
  snapshot: (opts: { source?: string; status?: 'experimental' | 'promoted'; notes?: string }) => Promise<HarnessVersion>;
  promote: (versionId: string) => Promise<void>;
  rollback: (versionId: string) => Promise<void>;
  submitProposal: (input: { hypothesis: string; expected_behavior: string; mutation_patch: string; baseline_version_id?: string }) => Promise<MetaLoopResult>;
  getDetail: (id: string) => Promise<{ version: HarnessVersion; manifest: HarnessManifest | null }>;
  getDiff: (aId: string, bId: string) => Promise<VersionDiff>;
  getProposalEvidence: (id: string) => Promise<{
    proposal: HarnessProposal;
    baselineVersion: HarnessVersion | null;
    proposedVersion: HarnessVersion | null;
    diff: VersionDiff;
    evalRuns: HarnessEvalRun[];
  }>;
  getEvalRuns: (versionId?: string) => Promise<HarnessEvalRun[]>;
  runEvalForVersion: (versionId: string) => Promise<{ runs: HarnessEvalRun[]; aggregate: any }>;
}

export const useHarnessStore = create<HarnessState>((set, get) => ({
  versions: [],
  promotedId: null,
  proposals: [],
  evalCases: [],
  selectedVersionId: null,
  loading: false,
  error: null,

  fetchVersions: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch<{ versions: HarnessVersion[]; promoted_id: string | null }>('/api/harness/versions');
      set({ versions: data.versions, promotedId: data.promoted_id, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },
  fetchProposals: async () => {
    try {
      const data = await apiFetch<{ proposals: HarnessProposal[] }>('/api/harness/proposals');
      set({ proposals: data.proposals });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  fetchEvalCases: async () => {
    try {
      const data = await apiFetch<{ cases: HarnessEvalCase[] }>('/api/harness/eval-cases');
      set({ evalCases: data.cases });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  selectVersion: (id) => set({ selectedVersionId: id }),
  snapshot: async (opts) => {
    const data = await apiFetch<{ version: HarnessVersion }>('/api/harness/snapshot', {
      method: 'POST',
      body: JSON.stringify(opts),
    });
    await get().fetchVersions();
    return data.version;
  },
  promote: async (versionId) => {
    await apiFetch(`/api/harness/versions/${versionId}/promote`, { method: 'POST' });
    await get().fetchVersions();
  },
  rollback: async (versionId) => {
    await apiFetch(`/api/harness/versions/${versionId}/rollback`, { method: 'POST' });
    await get().fetchVersions();
  },
  submitProposal: async (input) => {
    const result = await apiFetch<MetaLoopResult>('/api/harness/proposals', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    } as any);
    await Promise.all([get().fetchVersions(), get().fetchProposals()]);
    return result;
  },
  getDetail: async (id) => {
    return apiFetch(`/api/harness/versions/${id}`);
  },
  getDiff: async (aId, bId) => {
    const data = await apiFetch<{ diff: VersionDiff }>(`/api/harness/versions/${aId}/diff/${bId}`);
    return data.diff;
  },
  getProposalEvidence: async (id) => {
    return apiFetch(`/api/harness/proposals/${id}`);
  },
  getEvalRuns: async (versionId) => {
    const q = versionId ? `?version_id=${encodeURIComponent(versionId)}` : '';
    const data = await apiFetch<{ runs: HarnessEvalRun[] }>(`/api/harness/eval-runs${q}`);
    return data.runs;
  },
  runEvalForVersion: async (versionId) => {
    return apiFetch(`/api/harness/versions/${versionId}/eval`, { method: 'POST' });
  },
}));
