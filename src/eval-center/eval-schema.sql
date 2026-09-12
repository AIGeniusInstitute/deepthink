-- ============================================================================
-- DeepThink Agent 评测中心 — PostgreSQL Schema
-- 容器: deepthink-eval-pg (pgvector/pgvector:pg16)
-- 库: eval_center  用户: eval
-- 全部评测数据（数据集/用例/Rubric/运行/Trace/评分/发布日志）持久化于此
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;       -- 漂移检测 Embedding 质心
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- 用例关键词搜索

-- ==================== 项目 ====================
CREATE TABLE IF NOT EXISTS eval_project (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    owner_id        TEXT NOT NULL,             -- DeepThink user id (TEXT, 复用主系统用户)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_project_owner ON eval_project(owner_id);

-- ==================== 数据集（逻辑容器） ====================
CREATE TABLE IF NOT EXISTS eval_dataset (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES eval_project(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    dataset_type    VARCHAR(32) NOT NULL DEFAULT 'golden'
                    CHECK (dataset_type IN ('golden','probe','red_team','regression')),
    latest_version  INT DEFAULT 0,             -- 指向已发布最新版本号
    is_archived     BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_dataset_project ON eval_dataset(project_id);

-- ==================== 数据集版本（不可变快照） ====================
CREATE TABLE IF NOT EXISTS eval_dataset_version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id      UUID REFERENCES eval_dataset(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    version_label   VARCHAR(64),               -- 如 golden-v3-2026-09
    parent_version  INT,                        -- lineage 追溯（fork 来源）
    content_hash    VARCHAR(64) NOT NULL,      -- SHA-256 内容寻址
    status          VARCHAR(32) DEFAULT 'draft'
                    CHECK (status IN ('draft','review','published','deprecated')),
    case_count      INT DEFAULT 0,
    change_log      TEXT,
    created_by      TEXT NOT NULL,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, version)
);
CREATE INDEX IF NOT EXISTS idx_eval_dv_dataset ON eval_dataset_version(dataset_id);
CREATE INDEX IF NOT EXISTS idx_eval_dv_status ON eval_dataset_version(dataset_id, status);

-- ==================== 测试用例 ====================
CREATE TABLE IF NOT EXISTS eval_test_case (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version_id  UUID REFERENCES eval_dataset_version(id) ON DELETE CASCADE,
    external_id         VARCHAR(128),
    input_text          TEXT NOT NULL,
    input_metadata      JSONB DEFAULT '{}'::jsonb,
    expected_output     TEXT,
    expected_trajectory JSONB,                 -- Agent 期望执行轨迹
    expected_tool_calls JSONB,                  -- 期望工具调用序列
    context             JSONB DEFAULT '{}'::jsonb,
    tags                TEXT[] DEFAULT '{}',
    difficulty          VARCHAR(16),           -- easy/medium/hard
    category            VARCHAR(64),
    is_golden           BOOLEAN DEFAULT false,
    status              VARCHAR(16) DEFAULT 'active'
                        CHECK (status IN ('active','deprecated','draft')),
    source_trace_id     TEXT,                  -- 来自生产 badcase 的 trace
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_tc_dv ON eval_test_case(dataset_version_id);
CREATE INDEX IF NOT EXISTS idx_eval_tc_tags ON eval_test_case USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_eval_tc_search ON eval_test_case USING GIN (input_text gin_trgm_ops);

-- ==================== Rubric 评分标准 ====================
CREATE TABLE IF NOT EXISTS eval_rubric (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES eval_project(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    latest_version  INT DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_rubric_project ON eval_rubric(project_id);

CREATE TABLE IF NOT EXISTS eval_rubric_version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rubric_id       UUID REFERENCES eval_rubric(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    version_label   VARCHAR(32),               -- semver major.minor
    dimensions      JSONB NOT NULL,            -- [{name,weight,description,scale,judge_criteria}]
    judge_prompt    TEXT,                       -- LLM-as-Judge 评分 Prompt 模板
    judge_model     VARCHAR(128),
    pass_threshold  NUMERIC(5,2) DEFAULT 0.50,
    status          VARCHAR(16) DEFAULT 'draft'
                    CHECK (status IN ('draft','published','deprecated')),
    created_by      TEXT NOT NULL,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rubric_id, version)
);
CREATE INDEX IF NOT EXISTS idx_eval_rv_rubric ON eval_rubric_version(rubric_id);

-- ==================== 评测运行 ====================
CREATE TABLE IF NOT EXISTS eval_run (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID REFERENCES eval_project(id) ON DELETE CASCADE,
    dataset_version_id UUID REFERENCES eval_dataset_version(id),
    rubric_version_id   UUID REFERENCES eval_rubric_version(id),
    agent_id          TEXT NOT NULL,           -- DeepThink Agent 标识（name 或 def id）
    agent_version     VARCHAR(64),
    llm_model          VARCHAR(128) NOT NULL,
    model_params       JSONB DEFAULT '{}'::jsonb,
    status            VARCHAR(32) DEFAULT 'pending'
                      CHECK (status IN ('pending','running','completed','failed','cancelled')),
    total_cases       INT DEFAULT 0,
    completed_cases   INT DEFAULT 0,
    passed_cases      INT DEFAULT 0,
    overall_score     NUMERIC(6,2),
    pass_rate         NUMERIC(5,4),
    config_snapshot   JSONB NOT NULL,           -- 完整配置快照，保证可复现
    error_message     TEXT,
    started_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    created_by        TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_run_project ON eval_run(project_id);
CREATE INDEX IF NOT EXISTS idx_eval_run_status ON eval_run(status);

-- ==================== 单用例评测结果 ====================
CREATE TABLE IF NOT EXISTS eval_result (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID REFERENCES eval_run(id) ON DELETE CASCADE,
    test_case_id    UUID REFERENCES eval_test_case(id),
    status          VARCHAR(16) DEFAULT 'pending'
                    CHECK (status IN ('pending','running','completed','failed')),
    agent_output    TEXT,
    agent_latency_ms BIGINT,
    token_usage     JSONB DEFAULT '{}'::jsonb,
    dimension_scores JSONB DEFAULT '{}'::jsonb,   -- {dim: {score, max, confidence, reasoning}}
    overall_score   NUMERIC(6,2),
    is_pass         BOOLEAN,
    judge_reasoning TEXT,                          -- LLM Judge CoT 推理链
    assertion_results JSONB DEFAULT '[]'::jsonb,  -- 确定性断言逐条结果
    error_message   TEXT,
    retry_count     INT DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, test_case_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_result_run ON eval_result(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_result_case ON eval_result(test_case_id);

-- ==================== Agent 执行轨迹 ====================
-- Trace 顶层：一次完整交互
CREATE TABLE IF NOT EXISTS agent_trace (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eval_result_id  UUID REFERENCES eval_result(id) ON DELETE CASCADE,
    run_id          UUID REFERENCES eval_run(id) ON DELETE CASCADE,
    session_id      TEXT,
    trace_type      VARCHAR(32) DEFAULT 'evaluation',
    input_summary   TEXT,
    output_summary  TEXT,
    total_latency_ms BIGINT,
    total_tokens    INT,
    span_count      INT DEFAULT 0,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trace_eval_result ON agent_trace(eval_result_id);
CREATE INDEX IF NOT EXISTS idx_trace_run ON agent_trace(run_id);

-- Span：Trace 内每个步骤
CREATE TABLE IF NOT EXISTS trace_span (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id        UUID REFERENCES agent_trace(id) ON DELETE CASCADE,
    parent_span_id  UUID REFERENCES trace_span(id),
    span_type       VARCHAR(32) NOT NULL
                    CHECK (span_type IN ('llm_call','tool_call','retrieval',
                                         'agent_handoff','decision','error')),
    sequence_order  INT NOT NULL,
    name            VARCHAR(255),
    input_data      JSONB,
    output_data     JSONB,
    model           VARCHAR(128),
    token_usage     JSONB DEFAULT '{}'::jsonb,
    latency_ms      BIGINT,
    status          VARCHAR(16) DEFAULT 'ok'
                    CHECK (status IN ('ok','error','timeout','skipped')),
    error_message   TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_span_trace ON trace_span(trace_id, sequence_order);
CREATE INDEX IF NOT EXISTS idx_span_type ON trace_span(trace_id, span_type);
CREATE INDEX IF NOT EXISTS idx_span_input_gin ON trace_span USING GIN (input_data);
CREATE INDEX IF NOT EXISTS idx_span_output_gin ON trace_span USING GIN (output_data);

-- ==================== 版本发布审计 ====================
CREATE TABLE IF NOT EXISTS eval_publish_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     VARCHAR(32) NOT NULL,      -- dataset / rubric
    entity_id       UUID NOT NULL,
    from_version    INT,
    to_version      INT NOT NULL,
    action          VARCHAR(32) NOT NULL,      -- publish/rollback/deprecate
    operator_id     TEXT NOT NULL,
    change_summary  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_publish_entity ON eval_publish_log(entity_type, entity_id);

-- ==================== 数据集克隆关系 ====================
CREATE TABLE IF NOT EXISTS eval_dataset_clone_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_dataset_version_id UUID REFERENCES eval_dataset_version(id),
    target_dataset_id         UUID REFERENCES eval_dataset(id),
    target_version            INT,
    clone_type      VARCHAR(16) DEFAULT 'full' CHECK (clone_type IN ('full','partial','fork')),
    case_filter     JSONB,                     -- partial 时的筛选条件
    operator_id     TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ==================== Golden Set 双人标注 + 仲裁 ====================
CREATE TABLE IF NOT EXISTS eval_golden_annotation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_case_id    UUID REFERENCES eval_test_case(id) ON DELETE CASCADE,
    annotator_id    TEXT NOT NULL,
    expected_output TEXT,                       -- 该标注者给的期望输出
    expected_trajectory JSONB,
    note            TEXT,
    round           INT DEFAULT 1,              -- 标注轮次
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (test_case_id, annotator_id, round)
);
CREATE INDEX IF NOT EXISTS idx_golden_anno_case ON eval_golden_annotation(test_case_id);

CREATE TABLE IF NOT EXISTS eval_golden_arbitration (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_case_id    UUID REFERENCES eval_test_case(id) ON DELETE CASCADE,
    arbitrator_id   TEXT NOT NULL,
    final_expected_output TEXT,                 -- 仲裁结论
    final_expected_trajectory JSONB,
    reason          TEXT,
    resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_golden_arb_case ON eval_golden_arbitration(test_case_id);

-- ==================== 漂移检测报告 ====================
CREATE TABLE IF NOT EXISTS eval_drift_report (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version_id UUID REFERENCES eval_dataset_version(id) ON DELETE CASCADE,
    report_type     VARCHAR(32) NOT NULL,       -- input_distribution/prompt_template/retrieval_corpus
    drift_score     NUMERIC(6,3),               -- 0-1，越高越漂移
    detail          JSONB DEFAULT '{}'::jsonb,  -- 质心距离/KL散度/hash diff/overlap 明细
    baseline_ref    TEXT,                       -- 基线版本/快照引用
    is_drifted      BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drift_dv ON eval_drift_report(dataset_version_id);

-- 维度无关 vector 列（embedding config 维度可变，漂移检测在 JS 算质心距离，不需 ANN 索引）
CREATE TABLE IF NOT EXISTS eval_case_embedding (
    test_case_id    UUID PRIMARY KEY REFERENCES eval_test_case(id) ON DELETE CASCADE,
    dataset_version_id UUID REFERENCES eval_dataset_version(id) ON DELETE CASCADE,
    embedding       vector,                   -- 维度由 embedding config 决定
    model           VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_embed_dv ON eval_case_embedding(dataset_version_id);
