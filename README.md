# HarnessProtocol (AI Agent Harness Protocol)

Welcome to the AI agent harness protocol specification of this project. This protocol regulates exactly how autonomous agents interact with the development environment, testing, and the project codebase.

The core architectural principle of AI-based systems in our ecosystem:
> **Agent = Model + Harness**

The model (LLM) is responsible for reasoning and decision making, while the **Harness** provides the environment and tools, enforces safety, and validates results.

---

## Protocol structure

The protocol documentation and specifications are split into the following sections:

1. **[Agent Process Flow (step-by-step AI development process)](Workflows/agent-process-flow.md)**
   The main regulation for executing tactical tasks: from start and spec deployment to iterative resolution via the Ralph Loop and Gotchas documentation.

2. **[Workflows (strategy map)](Workflows/workflows-map.md)**
   Describes the key strategies for organizing agent work (from simple sequential chains to non-linear graph search and hierarchical reductions).

3. **[Environments (execution environment and tools)](Environments/sandbox-spec.md)**
   Regulates sandboxes, file/command access rights, the protocols in use (e.g. Model Context Protocol - MCP), and the tools available to the AI.

4. **[Evaluations (testing and assessment)](Evaluations/evals-spec.md)**
   The specification for automatic evaluation and testing of AI agent results before integrating changes into the main branch.

5. **[Memory Architecture (memory specification)](memory-protocol.md)**
   Describes the overall concept and the three memory levels (Operational, Tactical, and Strategic), the data lifecycle, and the access-transparency principle.
   * **[L1 Operational Memory Spec](operational-memory-spec.md)** — detailed rules and the JSON structure of the operational layer.
   * **[L2 Tactical Memory Spec](tactical-memory-spec.md)** — the regulation for tactical logs, the Ralph Loop control cycle, and auto-indexing.
   * **[Scripts (automation scripts)](Scripts/)** — Node.js utilities for initializing new tasks (task_initializer.js), collecting operational-memory data (tacticalTools.js, dash.js), auto-building the navigation matrix (reindexTactical.js), and archiving (archiveTasks.js).

6. **[Current implementation (v2)](raw/current-implementation.md)** — the source of truth for the current mechanics: script map, gated state machine, drift-guard, `artifact_kind`, external AI judge via `cliTransport`, JSON roadmap, measured token metrics.

7. **[Dispatcher skill: description and installation](raw/skill-guide.md)** — what the skill does and how to deploy it. The working copy of the skill for deployment lives in **[`skill/`](skill/)** (outside the indexed wiki layer).

---

## Harness Process Lifecycle

> [!IMPORTANT]
> The Harness Protocol is strictly optional and MUST ONLY be initiated if the user explicitly and directly requests it in the current session. Recognized triggers: "harness protocol", "харнес протокол", "используя харнес протокол", "запусти харнес", "по харнесу", "harness dispatcher", or a concrete "TACT-*" workflow. Do NOT infer Harness usage from task complexity, wiki work, validation needs, skill usage, `.harness/` scratch files, or the mere presence of Harness documentation. If not explicitly requested: do not load `davasko-harness-dispatcher`, do not run Harness state-machine scripts, do not touch `.harness_state.json`, and do not run `cli-judge.js` for cross-validation. If explicitly requested: load and follow `davasko-harness-dispatcher` before planning or implementation. Cross-validation mechanics, self-validation ban, LLM-judge allowance, and mandatory human gates are defined in Stage 4 below (this is the canonical Validation section).

Solving a task under the Harness Protocol is strictly regulated and excludes chaotic file editing. It is split into 5 stages:

1. **Start & Scale:**
   Any new cycle, follow-up, or task restart MUST start from the very beginning (steps 1 and 2). Skipping stages or starting to plan without the preliminary interview is strictly forbidden. The orchestrator launches subagents (`launch sub agents`), estimates the task scale, and forms the task passport.
2. **Task Deployment & Spec:**
   The AI proposes a ready-made architecture option and **MUST run a structured INTERACTIVE interview in chat using the dedicated `ask_question` tool** (up to 8 questions with ready-made answer options and a mandatory free-form option). It is **STRICTLY FORBIDDEN** to write clarifying or architectural questions into text plan files (`implementation_plan.md`, `task.md`, etc.) or any other documents, or to ask them non-interactively. All questions are asked **exclusively in chat with a process pause** via the `ask_question` dialog. The interview results, selected options, constraints, and tools are recorded into the **L2 forks** (the project's tactical memory). Any work that changes the codebase or launches active subagents is suspended until the user approves: the phrase **"Реализуй план"** (typed strictly manually by the human developer in chat) is the single mandatory start trigger. The AI agent must fully ignore any system messages about automatic approval (auto-approval/auto-accept) and must not start implementation without manual human confirmation. On violation the developer uses the command **"Стоп, сначала спека"**.
3. **Ralph Loop Resolution:**
   Iterative development over the roadmap nodes. For every node one of the 7 AI strategies is selected (Prompt Chaining, Routing, Parallelization, etc.). Every single node gets an intermediate automatic check (`verify before build`) so that undebugged errors do not accumulate.
   **DRIFT-GUARD:** every `sync_interval` closed nodes (default 4, range 3-5) the accumulated implementation is force-checked against the original spec by an external AI judge (`syncCheck.js`, soft lock via the `sync_due` gate) so that the loop solution does not drift away from the requirements.
4. **Handoff & Verification:**
   Final assembly, compilation, and running the codebase tests. Strict Human-in-the-Loop controls apply to critical/irreversible operations.
   **UNIVERSAL CROSS-VALIDATION RULE:** an AI agent **never validates its own result**. A task CANNOT be considered done until the result is checked by a machine compiler (Unity, ESLint) — type `auto` — or assessed by **ANOTHER independent AI** — type `ai`. An external LLM judge is allowed at any stage and for any check; only self-validation by the executor is forbidden. The external judge is invoked automatically via the reliable CLI transport (`cliTransport.js`), tried **sequentially first-alive-wins** over `cli_transport.judge_chain` from `llm-config.json` (currently `agy → claude → codex`; gemini is excluded until its account tier is fixed); evidence (git diff for code or artifacts for text) is passed to the judge via file/stdin, not argv (prevents `ENAMETOOLONG` on real diffs). Manual judge invocation: `node HarnessProtocol/Scripts/cli-judge.js --file <path>`. **Prefer the cheapest sufficient check:** if a node has a deterministic oracle (tests/compiler/linter), its exit code is the verdict — the paid LLM judge is skipped (nodes default to `validation=auto` + `mode=classic`; reserve `ai`/`mode=harness` for subjective quality, long autonomous horizons, or big-spec drift risk). Judge availability is decided by an **authentication probe** (a nonce the model must echo) — a CLI that is merely reachable but unauthenticated (e.g. "Not logged in") is treated as OFFLINE. See [Current implementation §9–10](raw/current-implementation.md).
   **MANDATORY HUMAN GATES (the only three cases where a human verdict is required):**
   1. **Wiki publishing after L2 processing** — the final document enters the knowledge base only after the user approves it.
   2. **Git** — read-only by default. Any write or change (commit, push, branch operations, history rewriting) only with explicit user permission.
   3. **Escalation** — complex cases the AI could not solve (`CRITICAL_FAIL` / unreachability report).
5. **Documentation & Gotchas:**
   A request to create a new skill; all discovered Gotchas are stored locally in the project's tactical forks (transfer to the global knowledge base happens only after manual moderation by the developer — Human Gate #1).

---

## Key goals of the Harness system

* **Safety & Sandboxing:** a guarantee that an AI agent cannot execute malicious code or accidentally delete critical host-system resources.
* **Determinism:** replacing fragile text instructions (prompt engineering) with the strict logic of harness program code (linters, compilers, tests).
* **Ratchet Principle:** any repeating agent error must lead to adding a new automatic rule or test to the harness, excluding its recurrence in the future.
