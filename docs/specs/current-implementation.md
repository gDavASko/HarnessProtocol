# Harness Protocol — Current Implementation (v2)

> Source of truth for the CURRENT Harness mechanics. Supplements and clarifies
> the historical documents (`implementation_plan.md`, `memory-protocol.md`,
> `tactical-memory-spec.md`, `Workflows/*`) — on any conflict THIS file wins.
> Kept in sync with the scripts in `../Scripts/` and the
> `davasko-harness-dispatcher` skill.

---

## 1. Script map (`HarnessProtocol/Scripts/`)

| Script | Role |
|:-------|:-----|
| `harnessPaths.js` | Single path resolver. Anchor — the repo root found by the `ProjectSettings/ProjectVersion.txt` marker (NOT by `.git`, since submodules have their own `.git`). All paths are deterministic regardless of cwd. |
| `harnessState.js` | Roadmap/state model: read/write `.harness_roadmap.json` (source of truth), node normalization, Markdown sync (one-way JSON→MD). |
| `task_initializer.js` | Deploys the L2 task skeleton (master + forks + `.harness_roadmap.json` + `.harness_state.json`). |
| `roadmapEdit.js` | Roadmap edits (add-node, set-status, set-dod, set-field, set-current, set-config, list). The only way to change the roadmap. |
| `contextAssembler.js` | 4 modes: `init`/`step`/`status` (JSON for the agent) and `validate` (generates `validation_report.md`). State gates. |
| `validator.js` | Node validation: `auto` (commands), `ai` (external judge), `oracle` (rungs), `human` (approve/reject). Enforces Oracle Floor and receipts. |
| `loopAdvancer.js` | Loop advancement: SUCCESS/FAIL, RETRY, CRITICAL_FAIL, TASK_COMPLETE, **SYNC_DUE** (drift-guard), **NEEDS_FINAL_INTEGRATION**. |
| `syncCheck.js` | Drift-guard: checks the accumulated implementation against the original spec via the external judge. |
| `cliTransport.js` | Reliable invocation of external CLI AIs (external judge). Content never in argv — file/stdin only. Session reuse for workers. |
| `aiProbe.js` | Preflight availability probe of the CLI judges. Runs in parallel at cycle start (`contextAssembler --mode init`), caches to `.harness/ai_probe.json` (TTL). All judge consumers filter the chain by the probe. |
| `cli-judge.js` | Manual external judge over an arbitrary file. |
| `judgeSelector.js` | Pure, side-effect-free judge-selection calculus (criticality → which judge(s), or `oracle_only` / `UNVALIDATED`). Node-runnable self-test. |
| `evidenceLadder.js` | Evidence Ladder certification contract & Oracle Floor enforcement (rungs: compile, tests, console_clean, security). |
| `sourceEvidence.js` | Cryptographic fingerprinting of source bytes and directory structure; detects tampering/rewriting during validation. |
| `oracleSuggest.js` | Stack auto-detection and oracle command generation for node classes (`code.testable`, `code.behavioral`). |
| `rubric.js` | 4-dimensional weighted scoring (functionality, quality, security, edge cases) with hard security floor for adversarial AI judges. |
| `securityScan.js` | Turnkey deterministic scanning of changed deliverables for leaked credentials, secrets, and insecure patterns. |
| `headlessLoop.mjs` | Virtualized requestAnimationFrame game loop runner for headless `console_clean` verification of web/canvas games. |
| `unityRunner.mjs` | Bounded Unity CLI runner (preflight, compile, EditMode/PlayMode tests with NUnit parsing, WebGL builds). |
| `parseUnityTestResults.mjs` | Strict NUnit XML parser for Unity test suites; asserts matching leaf test counts. |
| `webglSmoke.mjs` | Loopback Playwright automation harness verifying WebGL WASM bundles and runtime state (`__harnessUnityState`). |
| `modelPolicy.js` | Bounded model dispatch enforcing studio profiles, atomic reservation ledgers, and offline restrictions. |
| `skillDistribution.mjs` | Cryptographically verified synchronization and distribution of canonical dispatcher skills across environments. |
| `managedJob.mjs` | Structured background job manager for long-running CLI/compiler processes with atomic locks. |
| `measureTokens.js` | Measures the token savings of contextAssembler vs naive L2 reading. |
| `reindexTactical.js` | Auto-builds the navigation matrix in the master document. |
| `run_all_tests.js` | Master test runner executing 18 complete suites across all subsystems in ~40 seconds. |

---

## 2. Gated state machine

```
[awaiting_context] → contextAssembler init|step → [context_served]
                                                       │ (agent works)
                                                       │ contextAssembler validate
                                                       ▼
                                                 [report_ready]
                                                       │ validator auto|ai|human
                                    ┌──────────────────┴───────────────┐
                                    ▼                                  ▼
                              [validated]                 [awaiting_human_validation]
                                    │ loopAdvancer                     │ --approve
                     ┌──────────────┼───────────────┐            [validated]
                     ▼              ▼               ▼
            [awaiting_context]  [SYNC_DUE]     [task_complete]
                             (drift-guard: sync_due gate,
                              unlocked via syncCheck.js)
```

**Gates (deterministic locks):**
| Script | Gate | Blocks when |
|:-------|:-----|:------------|
| `contextAssembler --validate` | `context_served` | stage ≠ context_served |
| `contextAssembler --init/step` | `awaiting_context` / `sync_due` | stage ≠ awaiting_context OR `sync_due` is set |
| `validator.js` | `report_ready` | no validation report |
| `loopAdvancer.js` | `validated` | node has not passed validation (FAIL is allowed from report_ready) |
| `validator.js` (multi-agent strategies) | `subagent_files_check` | required `op_*.json` files missing |

---

## 3. Validation: three types (auto / ai / human)

- **`auto`** — deterministic commands (compiler/tests/linter). The `auto` verdict must come from deterministic tooling only; if an LLM opinion is needed, use type `ai` instead.
- **`ai`** — **EXTERNAL independent judge**. The AI agent NEVER validates its own result. `validator.js --type ai` itself calls the external judge via `cliTransport` (the `cli_transport.judge_chain` chain from `llm-config.json`, filtered by the `aiProbe.js` preflight probe — dead binaries are skipped, no blind timeouts). Evidence goes to the judge via file/stdin (not argv → no `ENAMETOOLONG`): for `artifact_kind=code` — `git diff HEAD`, for `text` — the deliverables content. The judge returns strict JSON `{pass, dod_results, errors}`. The `--result` flag is ignored for type `ai`.
- **Subagent-fallback for type `ai`**: if NO external CLI judge is alive (per probe, or all judges fail at call time), the validator does not emit a junk FAIL. It writes the judge task to `ai_judge_task.md`, moves the state to `awaiting_subagent_validation` and returns `action: NEEDS_SUBAGENT_JUDGE`. The IDE agent spawns an INDEPENDENT fresh-context subagent as the judge; the subagent writes strict JSON to `ai_judge_verdict.json`; the verdict is accepted via `validator.js --type ai --judge-file ai_judge_verdict.json` (gated to the `awaiting_subagent_validation` stage) and recorded as `validation_mode: subagent_fallback`. Judging inside the executor's own context remains forbidden.
- **`human`** — validation by a human (`--approve`/`--reject`).

**Scope of the rules:** an external LLM judge is allowed at ANY stage and for ANY check (code review, text review, drift-guard, inner Evaluator-Optimizer loops). The only prohibitions are: (a) the executor judging its own result, and (b) substituting an LLM verdict where the node type is `auto` (deterministic tooling required).

**Mandatory human gates — exactly three cases require a human verdict:**
1. **Wiki publishing after L2 processing** — a final document enters the knowledge base (L3) only after user approval.
2. **Git** — read-only by default; any write/change (commit, push, branch operations) only with explicit user permission.
3. **Escalation** — cases the AI could not solve (`CRITICAL_FAIL` / unreachability report).

### CLI transport (reliability)
Content is never placed into argv (file/stdin only); no PowerShell as a launcher; completion = process exit AND a non-empty OUT file. Modes per binary: `codex`=file-out-flag (`-o`), `agy`/`gemini`=file-out-instruct (answer written to a file per instruction + sentinel), `claude`=stdout (`-p --output-format text`). The Gemini judge model is routed only to agy/gemini.

Judges are tried **sequentially (first-alive-wins)** in `judge_chain` order — not parallel fan-out — since only one verdict is ever used. Current chain: `agy → claude → codex` (gemini excluded until its tier is fixed). The `aiProbe` preflight uses a 40s base timeout with an adaptive per-binary bump (`max(40s, 2× last successful latency)`) because agentic CLIs cold-start for tens of seconds; binaries failing with a permanent error (broken config, ineligible tier) are quarantined for 24h instead of re-spawned every init. Probe cache TTL is 60 min. The model catalog is stored in `llm-models-catalog.json` (loaded lazily by `llmClient`/`ping_models`), keeping `llm-config.json` lean for the probe/judge path.

---

## 4. Two brains — by the node's `artifact_kind`

| `artifact_kind` | Executor | Evidence for the `ai` judge | Autonomous engine |
|:----------------|:---------|:----------------------------|:------------------|
| `code` | IDE agent (writes into the working tree) | `git diff HEAD` | skips the node (`NEEDS_IDE_AGENT`) |
| `text` | autonomous `strategyEngine`/`harness-orchestrator.js` | deliverables content | executes |

Reason: strategy executors write results into `op_*.json` blobs, not into the working tree, so real code is always written by the IDE agent.

---

## 5. Drift-guard (check against the original spec)

Every `sync_interval` closed nodes (a roadmap field, default 4, range 3-5) `loopAdvancer` returns `action=SYNC_DUE` and sets `sync_due` in state; `contextAssembler init/step` is blocked by the `sync_due` gate. `syncCheck.js` asks the external judge to compare the accumulated implementation against the original goal+DoD:
- `CONTINUE` (aligned) → lock removed, the `nodes_since_sync` counter reset, move to the next node;
- `REQUIRE_CORRECTION` (drift) → soft lock: add a corrective node (`roadmapEdit add-node`), then `syncCheck.js --acknowledge`.

Threshold: `roadmapEdit set-config --sync-interval N`. Purpose — keep the Ralph-loop solution from silently drifting away from the requirements.

---

## 6. Roadmap: JSON = source of truth

`.harness_roadmap.json` is the single source of truth. Markdown (`forks/tactical_ralph_loop.md`) is generated from JSON (one-way) and is NOT parsed back in the hot path (reverse parsing is a one-time bootstrap for legacy tasks only, disabled via `HARNESS_NO_BOOTSTRAP=1`). Edits — only via `roadmapEdit.js` / `loopAdvancer.js`.

Key node fields: `id`, `status`, `iteration`/`max_iterations`, `strategy`, `validation_type` (`auto|ai|human`), `artifact_kind` (`code|text`), `dod`, `deliverables`, `history`. Roadmap fields: `sync_interval`, `nodes_since_sync`.

---

## 6.1 Goal-контракт и scale gate

Узел roadmap может дополнительно содержать `goal`: измеримый `outcome`, способ доказательства `proof`, неизменяемые `constraints`, лимит `max_no_progress` и фиксированную реакцию `on_limit=CRITICAL_FAIL`. Поле обратно совместимо: старые roadmap без `goal` продолжают использовать `dod`, `max_iterations` и `validation_type`.

`roadmapEdit.js set-goal` — единственный CLI-путь для записи Goal-контракта. `roadmapEdit.js set-scale` сохраняет решение scale gate в поле `workflow`: `classic`, `goal_loop` или `workflow`, вместе с профилем и причиной.

Повторяемые профили лежат в `Workflows/profiles/`: `unity-compile-fix`, `readonly-code-audit`, `safe-migration`, `research-map-reduce`. Это декларации фаз и лимитов, не автономный запуск агентов. Начальные пределы: не более 3 работников одновременно и 8 за запуск; фактический fan-out должен сохранять существующие permission и human gates.

`Scripts/workflowRuntime.js` исполняет только read-only профили через `cliTransport.runWorkerTurn`, создавая изолированные файлы shard-результатов внутри `workflow_runs/`. Фазовый бюджет делится между работниками до запуска, поэтому превышение обнаруживается до вызова CLI. Профили с `writes_code=true` возвращают `WRITE_PHASE_REQUIRES_SEQUENTIAL_IDE_AGENT`: без worktree кодовые изменения выполняются только последовательно IDE-агентом.

---

## 7. Token economy (measured)

`measureTokens.js` yields measured values (not estimates): `init` savings ≈ 86-90%, `step` ≈ 96-99% relative to naively reading all L2 files. All service payloads are < ~260 tokens per call. See also `token-economy.md`.

---

## 8. Tests

`Scripts/test_harness_flow.js` (lifecycle + gates), `test_strategy_selection.js` (7 strategies), `test_cli_transport.js` (ENAMETOOLONG regression), `stress_test.js` (end-to-end run of all mechanisms, incl. drift-guard) + the `STRESS_TEST_REPORT.md` report.

**Regression smoke suite:** `node Scripts/smoke/run.js` — offline/deterministic, exits nonzero on any FAIL. Covers: 7-strategy dispatch+selection, RETRY→CRITICAL_FAIL, sawtooth history compaction, `--judge-file` verdict acceptance.

---

## 9. Judge hardening, sessions, budgets (later hardening)

- **Read-only judges:** judge CLIs never use `--dangerously-skip-permissions`. claude → `--allowedTools Read Grep Glob`; agy → `--sandbox`; codex → `-s read-only`. Judges receive evidence inline and return a verdict; they need no write access.
- **Family-aware judging:** `aiProbe.getAvailableJudgeChain({excludeFamily})` drops judges of the executor's own model family (`BIN_FAMILY`: claude=anthropic, agy/gemini=google, codex=openai), never down to zero. Set `node.worker_family` (roadmapEdit `--worker-family`) or pass `cli-judge --worker-family`.
- **Evidence-cited verdicts:** the `ai` judge JSON must include an `evidence` array of verbatim quotes; a bare PASS with no evidence is rejected (→ FAIL).
- **Persistent worker sessions (`cliTransport.runWorkerTurn`):** multi-stage WORKER turns reuse one CLI session (claude `--session-id`/`--resume`) so later turns send only a delta prompt (~98% fewer bytes). Non-resumable CLIs degrade to a cold spawn with minimal preamble. **Judges stay stateless** (`callExternalJudge` never uses sessions). Registry: `<task>/.harness_sessions.json`.
- **Durable checkpointer (`stateStore.js`):** append-only JSONL WAL at `<task>/.harness_wal.jsonl`; `writeState` checkpoints every transition (best-effort; `HARNESS_CHECKPOINT=0` disables). `node stateStore.js <task> --resume [run]` restores the last checkpoint.
- **Session log gating:** `sessionLogger` writes to `<repoRoot>/.harness_logs/sessions` by default; it only writes into the `kbpro-ai-docs` `NewData/` ingest buffer with `--publish` (or `HARNESS_PUBLISH_SESSION=1`).
- **Handoff SUMMARY (`##  SUMMARY`):** the validation report carries a mandatory ≤300-token SUMMARY; next-node context (`contextAssembler` `done_summaries`) is built from DONE-node summaries, not raw artifacts. Validation fails on a missing/placeholder SUMMARY (`HARNESS_REQUIRE_SUMMARY=0` disables).
- **Tiering + budgets:** `node.tier` (`mechanical|standard|deep`) → model via `cliTransport.modelForTier` (claude: haiku/sonnet/opus; others: CLI default). `runWorkerTurn` refuses before spawning when the prompt estimate exceeds `budgetTokens` (returns `BUDGET_EXCEEDED`, no silent burn). Per-node usage: `measureTokens.js --record …` → `.harness_logs/usage.jsonl`.
- **Model catalog:** the 31-model catalog lives in `Scripts/llm-models-catalog.json` (lazy-loaded by `llmClient`/`ping_models`); `llm-config.json` keeps only tiers/roles/chain.

---

## 10. Authentication, cost-routing, drift-guard economy (evaluation fixes)

- **F1 — probe proves AUTHENTICATION, not reachability:** `aiProbe` sends a fresh random nonce and marks a binary ONLINE only if the exact nonce is echoed AND no auth-failure signature is present (`AUTH_FAIL_SIGNATURES`: "Not logged in", "unauthorized", "IneligibleTier", empty/help/usage text). Non-empty junk (e.g. a login prompt) counts as OFFLINE (`status:'unauthenticated'`, not quarantined — recovers on re-login).
- **F2 — deterministic oracle beats the paid judge:** `validator.js` type `ai` short-circuits when a `--cmd` oracle is supplied — the exit code is the verdict (`judge:'deterministic_oracle'`, zero judge tokens). type `auto` never called a judge; pure-`ai` (no oracle) is unchanged.
- **F3 — drift-guard actionable-or-silent + lean context:** a `REQUIRE_CORRECTION` blocks advance until a corrective node is actually added (`--acknowledge` returns `CORRECTION_MISSING` until the roadmap grows past `drift_baseline_nodes`); non-actionable findings (empty `corrective`) do not block; the auditor is told to ignore not-yet-executed PENDING work; the audit prompt drops the heavy preamble (~900 bytes/call) for a lean header + DONE-scope DoD + git-diff delta.
- **F4 — entry gate (classic vs harness):** nodes carry a `mode` (`classic|harness`). New nodes default to `validation=auto` + `classic` (cheap deterministic path); the full harness (LLM judge, drift-guard, WAL) is reserved for nodes with no cheap oracle — mark them `--validation ai` or `--mode harness`. Heuristic surfaced in `task_initializer` `mode_gate` and `roadmapEdit list`.

---

## 11. Agent roles, model tiering & judge selection

The agent-role subsystem lives in `agents/` and `config/` (docs) plus `Scripts/judgeSelector.js` (code). It formalizes WHICH model tier each role uses and WHICH judge validates each node.

- **Model-Tier Doctrine** (root/synced `AGENTS.md`): orchestrator/chat → top-tier; planners/solvers/researchers → max; evaluators → medium-high; judges → medium (escalated by criticality); workers → cheap; glue → cheaper subagents. Hard rules: never run mechanical work on a top-tier model; never validate a critical result with a weak judge.
- **Canonical roles** (`agents/roles/*.md`): engine-agnostic `worker` (cheap), `judge` (medium), `evaluator` (medium-high), `reasoner` (max), `researcher` (max), `manager` (top). Judge/evaluator carry the isolation constraint (independent session; cross-family preferred).
- **Config** (`config/harness.config.json` + `config/README.md`): `available_models` (locally available only — agy/google, codex/openai, claude/anthropic incl. `claude-subagent`; hosted APIs are a reserved `external_api_slot`), `agent_roles` (tier + families), `judge_pool`, `criticality_judge_tier` (L0–L3), `per_role_limits`. User-tunable; per-machine override via `harness.config.local.json` (deep-merge) then env vars.
- **Universal generator** (`agents/AGENT-DEFINITION-SPEC.md`): a deterministic recipe to emit native per-IDE agent files (Claude Code frontmatter, Codex prompts, Gemini Antigravity) from the canonical roles + config. Claude Code variants are emitted in `agents/claude/` (worker→sonnet, judge/evaluator→opus-4-7 read-only, reasoner/researcher/manager→opus-4-8).
- **Judge-selection calculus** (`config/judge-selection.md`, `Scripts/judgeSelector.js`): pure `selectJudge({worker_family, artifact_kind, criticality, live_judges})` → chosen judge(s) / `oracle_only` / `UNVALIDATED`. Prefers cross-family (ranks it first) but keeps same-family isolated judges in the pool; optimizes by fit×criticality, then latency, then cost. L0→oracle only; L1→medium; L2→strong; L3→strong quorum (or dual-order if a single judge is live).
- **F5 integrity wire** (`validator.js`, `cli-judge.js`): a subjective (`ai`) node is validated by an INDEPENDENT judge selected via `judgeSelector.js` — never the worker's own session. The full live-judge pool is passed to the selector, which ranks cross-family first but accepts a same-family isolated judge (e.g. a Claude subagent judging a Claude worker) when no cross-family judge is live; the node is `UNVALIDATED` (a terminal result, distinct from FAIL, that does not advance the loop) only when NO independent judge is live at all. The judge call uses a shorter default per-call timeout (60s) with a bounded retry, and the judge context is trimmed to DoD + changed evidence (not the full transcript).

---

## 12. LangGraph StateGraph Execution Core & Strategy Subgraphs

Harness Protocol utilizes **LangGraph.js (`@langchain/langgraph`)** as its deterministic hierarchical execution runtime:
- **`TaskOrchestratorGraph`** (`Scripts/graph/taskOrchestratorGraph.js`): Top-level graph managing task-wide roadmap lifecycle, scale-gate enforcement, drift-guard synchronization, and terminal acceptance.
- **`RalphLoopSubgraph`** (`Scripts/graph/ralphLoopSubgraph.js`): Tactical execution graph managing iteration progression, memory distillation, and gated validation.
- **7 Pluggable Strategy Subgraphs** (`Scripts/graph/strategies/`):
  1. `chaining.js` — Sequential step-by-step DoD satisfaction with `op_memory.json`.
  2. `routing.js` — Domain classification (`ui`, `audio`, `logic`, etc.) and specialized worker invocation via `op_route.json`.
  3. `parallelization.js` — Independent DoD shard execution with collator aggregation (`op_collated.json`).
  4. `orchestrator.js` — Dynamic step planner and worker dependency management (`op_plan.json`).
  5. `evaluatorOptimizer.js` — Iterative generator-critic refinement loops (`op_feedback_loop.json`).
  6. `mapReduce.js` — Large dataset chunking, parallel processing, and final synthesis (`op_reduce_final.json`).
  7. `latm.js` — LLMs as Tool Makers: on-the-fly script synthesis, syntax guard validation, and sandboxed execution.
- **`harnessCheckpointer.js`**: Disk-backed persistence adapter saving thread checkpoints to `.harness/checkpoints/` and mirror-updating `.harness_state.json` and Markdown forks.
- **`syntaxGuard.js`**: Local pre-commit AST syntax validator (~5ms) intercepting broken code before any judge is invoked.
- **`contractFormalizer.js`**: Sprint Contract compiler converting informal user requirements into typed Definition of Done specs.

---

## 13. Evidence Ladder & Oracle Floor (Levers 1′–6)

Quality is guaranteed through executable truth rather than subjective diff-reading:
- **The Core Invariant (Lever 1′)**: Every node is verified by the strongest oracle its artifact admits. The deterministic floor is non-negotiable. An LLM judge covers ONLY subjective intent/design that no oracle reaches, and never substitutes for a deterministic check.
- **Artifact Classes**:
  - `code.testable` — Libraries, CLI tools, pure logic: requires `compile` + `tests` + `security`.
  - `code.behavioral` — GUI, animation loops, Unity gameplay: requires `compile` + `console_clean` + `tests` + `security`.
  - `text` — Specifications, GDDs, documentation: adversarial AI judge with weighted rubric.
- **Evidence Receipts (`evidence_receipts.json`)**: Every verification rung records an immutable receipt keyed to the active node and iteration.
- **Source Snapshots (`sourceEvidence.js`)**: Cryptographic fingerprinting of all source files, timestamps, and directory structures. Restoring or mutating source code during validation fails the check.
- **Security Floor**: Built-in deterministic scan (`securityScan.js`) detecting secret leaks (private keys, API tokens) and dangerous patterns (`eval`, disabled TLS).
- **Weighted Adversarial Rubric (`rubric.js`)**: Scores 4 dimensions: Functionality (0.30), Quality (0.25), Security (0.25), Edge Cases (0.20). Composite score must be $\ge 7.0$ and security must clear a hard floor $\ge 5.0$.
- **Mandatory Self-Review**: Before calling an AI judge on `code.*` nodes, the worker must complete `## SELF-REVIEW` in `validation_report.md` (DoD mapping, $\ge 3$ failure modes, and oracle proof).
- **Final Integration Gate**: Before `TASK_COMPLETE`, `loopAdvancer` enforces a full-suite integration run on the merged codebase (`--node __TASK__ --type oracle --rung integration`).

---

## 14. ADR 0020 & ADR 0021 Implementations

- **ADR 0020 (Total Ban on Uncontrolled Auto & Final Acceptance Stress-Gate)**:
  - Banning blind `exit code 0` completions: unit tests alone never certify full-system integrity.
  - After all tactical nodes close, `TaskOrchestratorGraph` enters `finalAcceptanceStressNode`, running end-to-end stress-tests and independent acceptance audits against `tactical_master.md`.
  - Any regression or defect triggers the **Remediation Loop**, synthesizing `FIX-*` corrective nodes.
- **ADR 0021 (Dynamic Runtime Node Decomposition & Adaptive Fracturing)**:
  - `dynamicDecompositionGateNode` inspects node complexity ($\ge 3$ independent DoD criteria, complex strategies, or unexpected defects).
  - Dynamically fractures the node into atomic sub-nodes (`NODE.1`, `NODE.2`), running independent Ralph loops for each slice.

---

## 15. Studio Runtime Hardening & Engine Verification

- **Bounded Unity CLI Runner (`unityRunner.mjs`)**: Non-interactive, single JSON request execution adapter supporting `preflight`, `compile`, `test` (EditMode/PlayMode), and WebGL `build`.
- **Strict NUnit XML Parser (`parseUnityTestResults.mjs`)**: Parses Unity Test Framework output, validating exact leaf test counts and rejecting skipped/malformed tests.
- **Playwright WebGL Smoke Gate (`webglSmoke.mjs`)**: Headless browser automation serving WebGL bundles on loopback, executing WASM/canvas, sending synthetic input, and asserting state properties (`__harnessUnityState`).
- **Headless RAF Game Loop (`headlessLoop.mjs`)**: Headless simulation runner for web/canvas games, auto-driving `requestAnimationFrame` for thousands of frames to catch NaN cascades and runtime crashes without a GUI.
- **Bounded Model Policy (`modelPolicy.js`)**: Enforces explicit JSON authorization profiles (`HARNESS_STUDIO_PROFILE`), atomic cross-process token reservation ledgers, and strict offline guarantees (`HARNESS_OFFLINE=1`).
- **Managed Background Jobs (`managedJob.mjs`)**: Lifecycle tracking, lockfiles, and output capture for external compiler and test processes.

---

## 16. Skill Distribution & Reusable Skill Distillation

- **Skill Distribution (`skillDistribution.mjs`)**: CLI utility comparing and synchronizing canonical skills (`.agents/skills/davasko-harness-dispatcher`) with authorized local/global replicas (`skill/`, `~/.agents/skills/`). Enforces plan digests, backup creation, and rollback journals (`recovery.json`).
- **Skill Distillation (`skillDistiller.js`)**: Analyzes closed L3 architectural nodes and automatically synthesizes self-contained, validated skill recipes in `.agents/skills/distilled-*/` for long-term capability transfer.

