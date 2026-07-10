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
| `validator.js` | Node validation: `auto` (commands), `ai` (external judge), `human` (approve/reject). |
| `loopAdvancer.js` | Loop advancement: SUCCESS/FAIL, RETRY, CRITICAL_FAIL, TASK_COMPLETE, **SYNC_DUE** (drift-guard). |
| `syncCheck.js` | Drift-guard: checks the accumulated implementation against the original spec via the external judge. |
| `cliTransport.js` | Reliable invocation of external CLI AIs (external judge). Content never in argv — file/stdin only. |
| `aiProbe.js` | Preflight availability probe of the CLI judges. Runs in parallel at cycle start (`contextAssembler --mode init`), caches to `.harness/ai_probe.json` (TTL). All judge consumers filter the chain by the probe. |
| `cli-judge.js` | Manual external judge over an arbitrary file. |
| `measureTokens.js` | Measures the token savings of contextAssembler vs naive L2 reading. |
| `reindexTactical.js` | Auto-builds the navigation matrix in the master document. |

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
