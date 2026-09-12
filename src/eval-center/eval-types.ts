// DeepThink Eval Center — shared types

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface DatasetRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  dataset_type: 'golden' | 'probe' | 'red_team' | 'regression';
  latest_version: number;
  is_archived: boolean;
  created_at: string;
}

export interface DatasetVersionRow {
  id: string;
  dataset_id: string;
  version: number;
  version_label: string | null;
  parent_version: number | null;
  content_hash: string;
  status: 'draft' | 'review' | 'published' | 'deprecated';
  case_count: number;
  change_log: string | null;
  created_by: string;
  published_at: string | null;
  created_at: string;
}

export interface TestCaseRow {
  id: string;
  dataset_version_id: string;
  external_id: string | null;
  input_text: string;
  input_metadata: any;
  expected_output: string | null;
  expected_trajectory: any;
  expected_tool_calls: any;
  context: any;
  tags: string[];
  difficulty: string | null;
  category: string | null;
  is_golden: boolean;
  status: 'active' | 'deprecated' | 'draft';
  source_trace_id: string | null;
  created_at: string;
}

export interface RubricRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  latest_version: number;
  created_at: string;
}

export interface RubricDimension {
  name: string;
  weight: number;
  description?: string;
  scale?: number; // default 5
  judge_criteria?: string;
  scorer?: 'deterministic' | 'llm_judge';
  assertions?: any[]; // for deterministic scorer
}

export interface RubricVersionRow {
  id: string;
  rubric_id: string;
  version: number;
  version_label: string | null;
  dimensions: RubricDimension[];
  judge_prompt: string | null;
  judge_model: string | null;
  pass_threshold: number;
  status: 'draft' | 'published' | 'deprecated';
  created_by: string;
  published_at: string | null;
  created_at: string;
}

export interface EvalRunRow {
  id: string;
  project_id: string;
  dataset_version_id: string;
  rubric_version_id: string;
  agent_id: string;
  agent_version: string | null;
  llm_model: string;
  model_params: any;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  total_cases: number;
  completed_cases: number;
  passed_cases: number;
  overall_score: number | null;
  pass_rate: number | null;
  config_snapshot: any;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
}

export interface EvalResultRow {
  id: string;
  run_id: string;
  test_case_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  agent_output: string | null;
  agent_latency_ms: number | null;
  token_usage: any;
  dimension_scores: any;
  overall_score: number | null;
  is_pass: boolean | null;
  judge_reasoning: string | null;
  assertion_results: any;
  error_message: string | null;
  retry_count: number;
  created_at: string;
}

export interface AgentTraceRow {
  id: string;
  eval_result_id: string;
  run_id: string;
  session_id: string | null;
  trace_type: string;
  input_summary: string | null;
  output_summary: string | null;
  total_latency_ms: number | null;
  total_tokens: number | null;
  span_count: number;
  metadata: any;
  created_at: string;
}

export interface TraceSpanRow {
  id: string;
  trace_id: string;
  parent_span_id: string | null;
  span_type: 'llm_call' | 'tool_call' | 'retrieval' | 'agent_handoff' | 'decision' | 'error';
  sequence_order: number;
  name: string | null;
  input_data: any;
  output_data: any;
  model: string | null;
  token_usage: any;
  latency_ms: number | null;
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  error_message: string | null;
  metadata: any;
  started_at: string | null;
  ended_at: string | null;
}

export interface CreateTestCaseInput {
  input_text: string;
  input_metadata?: any;
  expected_output?: string | null;
  expected_trajectory?: any;
  expected_tool_calls?: any;
  context?: any;
  tags?: string[];
  external_id?: string | null;
  difficulty?: string | null;
  category?: string | null;
  is_golden?: boolean;
  status?: 'active' | 'deprecated' | 'draft';
  source_trace_id?: string | null;
}
