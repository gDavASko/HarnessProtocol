# HarnessProtocol (AI Agent Harness Protocol)

Welcome to the AI agent harness protocol specification of this project. This protocol regulates exactly how autonomous agents interact with the development environment, testing, and the project codebase.

The core architectural principle of AI-based systems in our ecosystem:
> **Agent = Model + Harness**

The model (LLM) is responsible for reasoning and decision making, while the **Harness** provides the environment and tools, enforces safety, and validates results.

---

## Protocol structure

The protocol documentation and specifications are split into the following sections:

1. **[Agent Process Flow (step-by-step AI development process)](../specs/Workflows/agent-process-flow.md)**
   The main regulation for executing tactical tasks: from start and spec deployment to iterative resolution via the Ralph Loop and Gotchas documentation.

2. **[Workflows (strategy map)](../specs/Workflows/workflows-map.md)**
   Describes the key strategies for organizing agent work (from simple sequential chains to non-linear graph search and hierarchical reductions). See also the **[Ralph Loop Principles](../specs/Workflows/RalphLoopPrinciples.md)**.

3. **[Environments (execution environment and tools)](../specs/Environments/sandbox-spec.md)**
   Regulates sandboxes, file/command access rights, the protocols in use (e.g. Model Context Protocol - MCP), and the tools available to the AI.

4. **[Evaluations (testing and assessment)](../specs/Evaluations/evals-spec.md)**
   The specification for automatic evaluation and testing of AI agent results before integrating changes into the main branch.

5. **[Memory Architecture (memory specification)](../specs/memory-protocol.md)**
   Describes the overall concept and the three memory levels (Operational, Tactical, and Strategic), the data lifecycle, and the access-transparency principle.
   * **[L1 Operational Memory Spec](../specs/operational-memory-spec.md)** — detailed rules and the JSON structure of the operational layer.
   * **[L2 Tactical Memory Spec](../specs/tactical-memory-spec.md)** — the regulation for tactical logs, the Ralph Loop control cycle, and auto-indexing.
   * **[Token economy](../specs/token-economy.md)** — context-saving rules (measured init savings ≈ 86-90%).
   * **[Scripts (automation scripts)](../../Scripts/)** — Node.js utilities for initializing new tasks (task_initializer.js), collecting operational-memory data (tacticalTools.js, dash.js), auto-building the navigation matrix (reindexTactical.js), and archiving (archiveTasks.js).

6. **[Current implementation (v2)](../specs/current-implementation.md)** — the source of truth for the current mechanics: script map, gated state machine, drift-guard, `artifact_kind` ("two brains"), external AI judge via `cliTransport`, JSON roadmap source, measured token economy.

7. **[Dispatcher skill: description and installation](../specs/skill-guide.md)** — what the `davasko-harness-dispatcher` skill does and how to deploy it. The working copy of the skill lives in `HarnessProtocol/skill/` (outside the indexed layer).

---

## Harness Process Lifecycle

> [!IMPORTANT]
> The Harness Protocol is strictly optional and MUST ONLY be initiated if the user explicitly and directly requests to use it in the current session (using terms like "харнес", "harness", "TACT-*", or direct instructions to run the protocol). If not requested, standard tasks are solved in normal chat mode without Harness structures.

Solving a task under the Harness Protocol is strictly regulated and excludes chaotic file editing. It is split into 5 stages:

1. **Start & Scale:**
   The orchestrator launches subagents (`launch sub agents`), estimates the task scale (trivial vs large), and forms the task passport with nodes.
2. **Task Deployment & Spec:**
   The AI proposes a ready-made architecture option and runs a structured interview (up to 8 questions with options, "propose & select" principle). The interview results, constraints, and tools are recorded into the **L2 forks** (the project's tactical memory). Work is suspended until the user approves: the phrase **"Реализуй план"** is the mandatory start trigger. On violation the developer uses the command **"Стоп, сначала спека"**.
3. **Ralph Loop Resolution:**
   Iterative development over the roadmap nodes. For every node one of the 7 AI strategies is selected (Prompt Chaining, Routing, Parallelization, etc.). Execution is split by node type (`artifact_kind`): `code` is written by the IDE agent into the working tree, `text` may be driven by the autonomous engine. Every node gets an intermediate check (`verify before build`). **DRIFT-GUARD:** every `sync_interval` closed nodes (default 4, range 3-5) the accumulated implementation is checked against the original spec by the external judge (`syncCheck.js`, soft lock via the `sync_due` gate) so the solution does not drift away from the requirements.
4. **Handoff & Verification:**
   Final assembly, compilation, and running the codebase tests. Strict Human-in-the-Loop controls apply to critical/irreversible operations.
   **UNIVERSAL CROSS-VALIDATION RULE:** an AI agent **never validates its own result**. A task CANNOT be considered done until the result is confirmed either by a machine compiler/tests (type `auto`) or by **ANOTHER independent external AI** (type `ai`). An external LLM judge is allowed at any stage; only self-validation is forbidden. Mandatory human gates: (1) wiki publishing after L2 processing, (2) any git write (git is read-only by default), (3) escalation of unsolvable cases. The external judge is invoked automatically via the reliable CLI transport (`cliTransport.js`, the `cli_transport.judge_chain` chain); evidence (git diff for code / artifacts for text) is passed to the judge via file/stdin, not argv. (See [CLI model configuration](../specs/Evaluations/cli-models-config.md), [Current implementation](../specs/current-implementation.md)).
5. **Documentation & Gotchas:**
   A request to create a new skill; all discovered Gotchas are stored locally in the project's tactical forks (transfer to the global knowledge base happens only after manual moderation by the developer).

---

## Full raw-source index of the layer

Canonical layer specifications (raw/) for end-to-end navigation and full-text search:

* [../specs/current-implementation.md](../specs/current-implementation.md) — current implementation (v2): scripts, state machine, drift-guard, artifact_kind, cliTransport, JSON source.
* [../specs/skill-guide.md](../specs/skill-guide.md) — dispatcher skill description and installation.
* [../specs/implementation_plan.md](../specs/implementation_plan.md) — historical enhancement plan (implemented).
* [../specs/memory-protocol.md](../specs/memory-protocol.md) — the general L1/L2/L3 memory regulation.
* [../specs/operational-memory-spec.md](../specs/operational-memory-spec.md) — L1 operational memory.
* [../specs/tactical-memory-spec.md](../specs/tactical-memory-spec.md) — L2 tactical memory.
* [../specs/token-economy.md](../specs/token-economy.md) — token economy (measured).
* [../specs/Workflows/agent-process-flow.md](../specs/Workflows/agent-process-flow.md) — the STEP 1-5 regulation.
* [../specs/Workflows/RalphLoopPrinciples.md](../specs/Workflows/RalphLoopPrinciples.md) — Ralph Loop rules, strategies, Council Gates, drift-guard.
* [../specs/Workflows/workflows-map.md](../specs/Workflows/workflows-map.md) — the 7-strategy map.
* [../specs/Environments/sandbox-spec.md](../specs/Environments/sandbox-spec.md) — the isolated environment and CLI transport.
* [../specs/Evaluations/evals-spec.md](../specs/Evaluations/evals-spec.md) — testing and evaluation.
* [../specs/Evaluations/cli-models-config.md](../specs/Evaluations/cli-models-config.md) — CLI model configuration.

---

## Key goals of the Harness system

* **Safety & Sandboxing:** a guarantee that an AI agent cannot execute malicious code or accidentally delete critical host-system resources.
* **Determinism:** replacing fragile text instructions (prompt engineering) with the strict logic of harness program code (linters, compilers, tests).
* **Ratchet Principle:** any repeating agent error must lead to adding a new automatic rule or test to the harness, excluding its recurrence in the future.
