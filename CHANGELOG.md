# Changelog

All notable changes to DeepThink are documented here. For the full release notes of each version, follow the linked file under `docs/release_notes/`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.6.0] — 2026-10-10

A **new-capability** release whose axis is **FLM (Feedback & Learning Module)** — closing the loop from "what actually happened on a task" back to "how the next task behaves". Until now the platform could execute and observe (trace / eval-center / autonomy), but the return path from results to behaviour was broken: user opinions of a reply had nowhere to land (`messages` had no rating columns, message bubbles had no rating buttons), failures could not be attributed to a specific stage, and strategy changes were all-or-nothing flips with no canary.

- **FLM: three-source feedback collection** — User feedback (👍/👎 with six reason tags plus a correction text field, and implicit signals), system logs (tool-call receipts / error codes / latency / retries / token cost, with configurable sample rate and field whitelist), and environment data (observation-point registry + before/after snapshot diff + expiry).
- **FLM: unified analysis framework** — All three sources normalise into one `FeedbackEvent`; four-level entity alignment with an explicitly flagged time-and-content fallback; chronological reordering; `source weight × confidence` conflict resolution; time-window dedup; five classes of desensitisation (phone / ID card / bank card / email / token) with **hot-reloadable rules**.
- **FLM: three-layer evaluation engine** — Outcome layer (`achieved / partial / failed`), process layer (path conformance / step latency / retry count / first anomalous step) and quality layer (six dimensions); failures are attributed to one of `intent / planning / tool_selection / param_gen / execution / summary`, and **every conclusion carries evidence fragments**. The rule track is the always-available default; the LLM-judge track is opt-in per evaluation, and disagreements between the two tracks enter a human review queue.
- **FLM: learning and self-evolution** — Short-term correction (retry cap + backoff + tool whitelist + a duration gate that escalates to a human), experience memory (positive/negative cases with vector Top-K retrieval), strategy optimisation (prompt / routing / param / fewshot versions), data feedback producing exportable chosen/rejected preference pairs and SFT corpora with provenance, and knowledge-base self-update where corrections become candidates that only enter the knowledge base **after review**.
- **FLM: closed-loop execution with safety rails** — Every change becomes a version with its trigger source and related attribution labels; a **regression gate** blocks any version whose core metrics degrade beyond threshold and lists the degraded metrics; canary rollout by traffic percentage (1% minimum); automatic rollback; forced human sign-off for security-relevant changes; and a full audit timeline that can be replayed.
- **FLM: operations console** — A seven-tab console at `/feedback-learning` (navigation entry "Self-Evolving"): overview dashboard, attribution drill-down, case search with manual label correction, strategy A/B comparison with a rollout recommendation, and threshold alerts.
- **Eight product defects found and fixed during acceptance** — All eight existed while unit tests were green and every endpoint returned 200; they lived where unit tests structurally cannot reach (front-end consumption, upstream/downstream contracts, the event loop, and repeatability of operations). The most subtle one: `/admin/data-feedback` did ~3.8s of synchronous CPU work on the request path, **freezing the Node event loop** so that every other API in the process (including a 192-byte `/health`) stalled with it — fixed by target-text-level memoisation, taking data-feedback 3.83s → 0.041s and the concurrent health probe 3.46s → 0.16s with bit-identical output.
- **Ten of the acceptance script's own assertions were unsound and fixed** — Several of them could only ever pass (a fixed "or" over four audit actions, a length comparison that saturates once the table grows, `degraded !== true` being true for `undefined`). These are more dangerous than product defects because they certify unverified behaviour as verified; one new test case (TC-33) was added specifically to make a previously unreproducible failure deterministic via `page.route`.
- **Open-platform (AaaS) long tasks always failed with 500** — `agent-service.ts` hard-coded a 120s timeout while the same agent's web path took ~14 minutes for a writing task, and the catch replaced the real cause with an uninformative message. Timeouts now come from `CONTAINER_TIMEOUT` (default 30 min), with 504 for timeouts and 500 preserving the upstream message; verified end-to-end at 592s returning a success payload.
- **Open-platform agents ran with `cwd` set to the repository root** — `buildQueryOptions()` never passed `cwd`, so an agent running under `bypassPermissions` executed with the repo root as its working directory. It now resolves to the agent's own workspace, and deleting an agent cleans up its orphaned workspace directories.
- **Deleting an Agent left its workspace behind** — The delete route removed one `agent_definitions` row and had no teardown at all, leaving ghost workspaces that could never be reused and disk directories (including container `.npm-global`) of tens to hundreds of MB; `removeFlowArtifacts` was also missing `data/extra/{folder}`, which affected **every** delete path.
- **The CI smoke gate had never once run a test since it was created** — 58 consecutive failures from its creation on 2026-08-31, each dying in seconds. Two layers: `setup-node` with `cache: 'npm'` requires a lockfile that `.gitignore` deliberately excludes, and once that was removed npm 10's arborist crashed resolving vitest peer dependencies without a lockfile. The job now calls `make test-smoke` (18 files) instead of an inline list that had drifted to 6.
- **Production builds silently dropped `eval-schema.sql`** — `npm run build` was a bare `tsc`, which emits no non-TS assets, so `node dist/index.js` hit ENOENT and the whole Eval Center was unavailable in production while `tsx` worked fine in development. `build` is now `tsc && node scripts/copy-runtime-assets.cjs` with an explicit asset manifest.
- **A StreamEvent type added only to the synced copies broke the build** — the single source of truth was never touched, and `make sync-types` unconditionally overwrites copies; worse, the drift check only ran via `make typecheck`, whose prerequisite is `sync-types` itself, so it could never fail. CI now runs `check-stream-event-sync.sh` directly as its own step.
- **Swarm debate context was never passed to later seats** — `composeAgentPrompt()` ignored the `node_*_output` state keys, so downstream seats reported seeing no prior analysis; `resolveExecutionMode()` also short-circuited on `container` before the swarm-prefix check, making agents try to spawn containers in a Docker-less K8s pod.
- **Agent Studio's detail form did not refresh when switching agents** — Five fields used uncontrolled `defaultValue` inside a `<Card>` with no `key`, so React reused the DOM nodes and `defaultValue` only ever applied on first mount, leaving the panel showing the previous agent's config. Fixed by extracting `AgentDetailPage.tsx` with `key={agent.id}`; the test conversation URL moved to `/chat/agent/:agentId` and the `测试:` name prefix is migrated away at startup (display name only — jids and folders are untouched).
- **Housekeeping** — Removed the zero-reference modules `db-adapter.ts` and `redis-client.ts`; replaced hard-coded `schema_version === '61'` test assertions with an import of `SCHEMA_VERSION`; trimmed `CLAUDE.md` by 21.5% and extracted the large tables into `docs/architecture-index.md`, `docs/db-tables.md` and ten `docs/howto/` guides.

Schema v70 → **v71** (12 new `flm_*` tables, auto-migrated); no breaking API changes. 34 commits, 140 files changed, +29456/−1699. Test suite: 158 files / 1987 cases — 1972 passed, 14 skipped, 1 known `feishu-card` timeout flake (94/94 when re-run alone). FLM acceptance: 32/32 UI cases with screenshots, 253 unit tests.

📖 Full notes: [docs/release_notes/v1.6.0.md](docs/release_notes/v1.6.0.md)

## [v1.5.0] — 2026-09-24

A **focused fix** release whose single axis is making the Agent Group Chat (Swarm) delivered in v1.4.0 actually usable. v1.4.0 shipped the group/seat UI, the tables and the Pipeline panel, but the execution path that turns "a message" into "a seat speaking" was never wired — so messages produced no replies, blank bubbles, and seats with no mounted capabilities.

- **Agent group messages now actually execute** — `POST /:jid/messages` previously only wrote to `group_messages` and triggered nothing (`graph_runs` stayed at 0 rows), while the "Start Pipeline" button wrote a hard-coded `definition_id='swarm-pipeline'` that violated a foreign key, and the only dispatch channel was Redis, which reported success without doing anything when disconnected. The whole ad-hoc Redis path was deleted: a swarm group is now **a real `graph_definition`** whose nodes are its seats and whose edges are the speaking order.
- **Seat-attributed streaming** — Each seat's reply streams token by token, attributed to the seat that produced it. Previously the front end understood only `group_message_created`, and rendered blank bubbles because the WS payload carried `content` while the renderer read `contentRef`.
- **Mount parity with regular chat** — Seats inherit the turn's Skills / MCP servers / knowledge bases through the same toolbar, store and `selectedMounts` field that regular conversations use; the seat's synthetic group now carries the owner identity the mount pipeline resolves against.
- **Execution mode & cold start** — Swarm groups inherit the creator's home execution mode instead of silently falling back to `container`; the cold-start guard no longer silently discards a new workspace's first message.
- **Architecture convergence** — The graph engine gained two optional, add-only hooks (`onNodeSettled` / `onNodeStream`) that are no-ops when unwired. No new engine, no new middleware, no new dependencies, **no schema change** (v70 → v70).

📖 Full notes: [docs/release_notes/v1.5.0.md](docs/release_notes/v1.5.0.md)

## [v1.4.0] — 2026-09-23

A **distributed capability landing + enterprise collaboration workload** release. v1.3.0 moved DeepThink's state stack onto K8s, but a batch of capabilities still worked only single-node: config read from local files, workspace files on local disk, agent dispatch via in-process calls.

- **Configuration fully migrated to PostgreSQL + workspace files into MinIO** — 21 configuration domains moved from local files to the `provider_configs` / `mcp_server_configs` tables (DB-first read, so any Pod sees a change immediately); workspace files synchronize to the `deepthink-workspaces` MinIO bucket, with the full delete / move / rename / search / download / preview chain S3-synced.
- **Distributed agent dispatch closed loop** — fixes for four classes of distributed agent-runner dispatch defects (close signal, subscription race, duplicate delivery, BLPOP latency), plus turnMounts (Skills / MCP / KB) taking effect before distributed dispatch, cross-Pod Skill visibility, IM leader-election races, and `must_change_password` BIGINT semantics.
- **Four enterprise business surfaces** — Digital Employee Collaboration Workbench, AgentNet Disk, Eval Center, and Agent Group Chat (Swarm) with a traceable Pipeline execution panel.
- **Platform capability close-out** — Skills into PostgreSQL, conversation mount controls, office quick bar, 6 Agent conversation-mount context fixes, run-trace persistence + execution summary + PDF export.
- **Fixes** — SQLite migration abort caused by PG-only `ADD COLUMN IF NOT EXISTS` syntax, Disk trash route-priority 404, Eval Center drift `toFixed` crash, and several other K8s-exposed defects.

Schema v59 → **v70**; 46 commits.

📖 Full notes: [docs/release_notes/v1.4.0.md](docs/release_notes/v1.4.0.md)

## [v1.3.0] — 2026-09-06

A **cloud-native & collaboration** release. DeepThink evolves from "single-node multi-agent orchestration + open services" (v1.2.0) to "K8s fully stateless + horizontal multi-Pod scaling + collaborative work + deeper platform capabilities".

- **Cloud-native: single-node → K8s fully stateless horizontal scaling** — the release's dominant engineering arc, closed across 5 phases: K8s cloud deployment & data persistence (Phase 1); true multi-Pod statelessness (**Redis event bus + distributed leader election + PostgreSQL sync bridge**); **Agent IPC Redis message-driven + Agent Runner as an independent Service**; Phase 3 production-grade (**pgvector** over Milvus, **MinIO/S3** object storage, **Litestream** WAL backup), followed by a full stateless-gap audit (Tier A PG data-layer: true upsert / lastInsertRowid / date(localtime); Tier B scaling: IM leader election / Claude-engine Redis IPC / periodic-task gating) and a shared concurrency counter wired to Redis so per-user/global limits hold across Pods.
- **Multi-user collaboration** — three work modes (orchestrator-worker / peer / critic-adversarial) + group-shared workspaces (`collaborations/{collabId}/` deliverables/manifest/shared-memory), all expressed as `agent + gate` graph nodes with zero intrusion into the graph-engineering core.
- **Platform capability deepening** — full-lifecycle trace (`trace_steps` atomic table + span chains + timeline API + DAG render), validate nodes & hooks (json-schema-validator + onFail fail/retry/fallback + business webhooks with HMAC/timeout/retry/idempotency), harness-eval assertions (json_schema/json_path/numeric_range/llm_judge) + eval dashboard, Skills version management (snapshot/rollback) + tools overview page. Schema 56→58; 1634 tests passing.
- **Enterprise tool governance & least-privilege baseline** — side-effect grading (read/write/admin), write idempotency keys, tool-call audit log, sliding-window rate limiting (read=120/write=30/admin=10 per 60s), AES-256-GCM credential encryption.
- **PG INTEGER→BIGINT timestamp overflow fix** + **local persistent storage stack** (`deploy/local/` docker-compose: PG+pgvector / Redis AOF / MinIO S3).
- First-level navigation simplified to 7 items; ops toolchain + one-click deploy + desktop packaging hardening.
- Image-build 403/slow-source fix, desktop packaging `tsc not found`, `_ensure-native-abi` better-sqlite3 detection, start-prod watchdog auto-restart.

📖 Full notes: [docs/release_notes/v1.3.0.md](docs/release_notes/v1.3.0.md)

## [v1.2.0] — 2026-08-28

An **orchestration & opening-up** release. DeepThink evolves from "a single autonomous Agent's vertical leap" (v1.1.0) to "multi-agent horizontal orchestration + standardized external services".

- **Multi-agent orchestration** (three orthogonal paths, all reusing the `graph-engineering` DAG engine): **Team Graph** complex task planning & execution (extended Graph DSL with `llm`/`tool`/`start`/`end`/`parallel`/`aggregate` nodes + conditional edges + fallback, Graph Planner auto-planner, node isolation / timeout / budget circuit-breaker / resume hash validation, `graph_*` WS live visualization + Gantt + replay); **Agent Workflow visual orchestration** (editable DAG canvas, per-user CRUD, team-builder draft mode, single-node Agent editing); **Orchestrator–Workers mode** (user explicitly curates reusable Workers in Agent Studio and a main Agent autonomously dispatches to them).
- **Full Autonomy Recovery Engine**: upgrades the 4 terminal hard brakes to recoverable ones (≤3 recoveries each), adds knowledge-gap self-resolution (`install_skill`/`create_skill`/`web_search`), lesson re-injection, gate auto-resume, and external-interaction archiving.
- **Agent Studio AI generate/optimize**: AI-generate a full Agent from a name/description and AI-optimize an existing Agent's prompt with diff preview; fixes the empty-canvas drag-drop bug.
- **MCP ecosystem**: **MCP Server Registry** (register any HTTP API as a standard MCP tool with param mapping / auth injection / OpenAPI import / tool test); **MCP module merge** (unified one-level menu + MCP server tool listing & test).
- **Open Platform (Agent Service)**: API Key credential system, OpenAI-style LLM MaaS (`/v1/chat/completions` + `/v1/models`), Agent as a Service (`/v1/agents/:id/chat/completions`), independent billing loop (`model_pricing` + 402 pre-check + post-hoc metering), in-console debug playground.
- **OPC one-person-company module**: company/objective CRUD + goal-driven team launch + enterprise operation dashboard.
- Security & stability fixes: SSRF CGNAT/DNS bypass, desktop dmg missing better-sqlite3 binding, npm 12 compatibility, graph terminal-state persistence, web-fetch prompt leak.

📖 Full notes: [docs/release-notes/v1.2.0.md](docs/release-notes/v1.2.0.md)

## [v1.1.0] — 2026-08-07

An **autonomy leap** release. DeepThink evolves from "tool-user-driven Loop Engineering" to a self-contained autonomous Agent system with a measurable, verifiable closed loop.

- **Autonomy Layer** — a cross-cutting layer unifying the 7 capabilities (perception / cognition / decision / execution / learning / adaptation / monitoring) with an event bus, capability registry, metrics collection (8 indicator dimensions), and a Playwright E2E acceptance suite. Schema migration 53 → 54.
- **Autonomous Mode** — a per-group continuous-push switch letting the Agent complete a task end-to-end without human hand-holding, with three defense layers (CLAUDE.md constitutional override / Supervisor clarify bypass / RLHF end-turn politeness) and four hard brakes (destructive-command detection / turn limit / token limit / loop detection).
- Desktop packaging dependency hardening.

📖 Full notes: [docs/release-notes/v1.1.0.md](docs/release-notes/v1.1.0.md)

## [v1.0.10] — 2026-07-25

An **engine expansion + execution stability + collaboration visualization** release.

- **pi engine**: the fourth Agent execution engine, integrated via long-lived stdio JSONL RPC (`pi --mode rpc`), with a rewritten protocol core (binary RPC subprocess, `PiRpcDriver`, `models.json` generation).
- **Agent Reminder mechanism**: periodically / event-driven re-injection of the task goal during long tasks to prevent context drift, surfaced in a live reminder panel.
- **Execution stability fixes**: stuck-running state, container sleep, trace not persisted.
- TeamPage execution view enhancement v2.

📖 Full notes: [docs/release-notes/v1.0.10.md](docs/release-notes/v1.0.10.md)

## [v1.0.7] — 2026-07-19

📖 Full notes: [docs/release-notes/v1.0.7.md](docs/release-notes/v1.0.7.md)

## [v1.0.5] — 2026-07-18

📖 Full notes: [docs/release-notes/v1.0.5.md](docs/release-notes/v1.0.5.md)

---

**How releases are published**: see the "Release Publishing" section of the README — tag a version (`vX.Y.Z`), the `release.yml` GitHub Action builds the three-platform desktop artifacts and publishes the GitHub Release.
