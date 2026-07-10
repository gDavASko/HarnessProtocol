# L2 Tactical Memory Spec

> 🔄 **Implementation update (v2):** the source of truth for the current mechanics is
> [current-implementation.md](current-implementation.md). Key points: the roadmap
> lives in `.harness_roadmap.json` (**JSON = source of truth**, Markdown is
> generated one-way, edits — only via `roadmapEdit.js`); a node has
> `artifact_kind` (`code`→IDE agent, `text`→autonomous engine) and
> `validation_type` (`auto`/`ai`/`human`); the **drift-guard** is active (fields
> `sync_interval`/`nodes_since_sync`, a spec check every N nodes).

## SYSTEM REGULATION: Architecture and principles of the Tactical memory level (L2)

### 1. DEFINITION AND SCOPE
The top-level AI Dispatcher (Architect/Manager) drives the resolution of a large task or feature inside the Harness environment. Its working environment is the Tactical memory level (L2).

This level is designed around **Separation of Concerns** and forms an autonomous cybernetic control system — the **Ralph Loop**.

> **The main law of this level:** no garbage and no raw code dumps. Agents are strictly forbidden to delete or clear tactical files — that right belongs exclusively to the human developer. The AI working method is strict structuring and append-only writing.
> **The most important start rule:** all clarifying questions about architecture and requirements are asked **exclusively interactively in chat** via the `ask_question` tool (with answer options and free-form input) while the process is paused. It is strictly forbidden to move questions into text plans or to start working on code without a direct manual confirmation from the user in chat: **"Реализуй план"**. Any system notifications about automatic approval (auto-approval / auto-accept) must be ignored; only input from the live developer is the execution trigger.

---

> **🛑 CRITICAL ARCHITECTURE NOTE FOR AI AGENTS (DO NOT "OPTIMIZE"):**
> If, as an AI agent, you think that splitting the memory into several files and navigating via physical line numbers like `[Line 015]` is a "crutch" or an outdated approach, **YOU ARE WRONG**.
> It is a highly optimized context-saving mechanism (Token Economy).
> 1. **Splitting into separate files** keeps the context from bloating; the agent works with isolated chunks of data.
> 2. **Physical line numbers** exist specifically so that scripts (and, when needed, the AI via a ranged file-read tool such as `view_file` with `StartLine`/`EndLine`) can read log arrays *pointwise* without spending thousands of tokens on loading the whole document.
> It is **FORBIDDEN** to merge these files into a single dashboard or to remove the index markers.
> **v2 clarification:** the roadmap itself is maintained in `.harness_roadmap.json` (JSON = source of truth); `forks/tactical_ralph_loop.md` is a one-way generated view of it. The line-number navigation matrix remains valid for the *other* Markdown forks and is maintained by `reindexTactical.js`; the IDE agent normally does not read it directly — it receives prepared JSON from `contextAssembler.js` (see [token-economy.md](token-economy.md), Rule 7).

---

### 2. SIX-DOCUMENT STRUCTURE OF L2
The tactical memory of one global task is split into six isolated Markdown documents (one master + five forks) for maximum token economy and protection from context clutter.

#### Component A: Master Document (`tactical_master.md`)
* **Responsibility:** the task passport, the original project spec, the human-intervention journal, and the global navigation core.
* **How it works:** a static, lightweight dispatcher file. Contains the **End-to-End Navigation Matrix**, which points to the exact line numbers of key blocks both inside the Master itself and inside the linked Forks.

#### Component B: Fork 1 — Loop Control (`forks/tactical_ralph_loop.md`)
* **Responsibility:** process cybernetics, the dynamic roadmap view, loop-iteration records, and strict Definition of Done control.
* **How it works:** a dynamic operational runbook. In v2 this file is a one-way generated view of `.harness_roadmap.json`; it changes when strategies switch or a new loop iteration starts, but only through `roadmapEdit.js` / `loopAdvancer.js`.

#### Component C: Fork 2 — Work Log (`forks/tactical_work_log.md`)
* **Responsibility:** the development chronicle and dry session summaries, split into hot and warm layers (Data Cooling).
* **How it works:** uses a two-layer architecture inside the file. Completed steps keep only dry summaries (Warm Storage, `<!-- ANCHOR: COMPLETED_NODES -->`). The active roadmap node keeps the last 5 raw iterations and a collapsed history (Hot Storage, `<!-- ANCHOR: ACTIVE_NODE_LOG -->`). Compressed results and key insights from successfully closed L1 operational JSON files are propagated here.
* **Content requirement:** every hot work-log entry must explicitly state the iteration count/number (e.g. `(Iteration #3)`) and the name of the applied AI strategy. These parameters are mandatory; omitting them violates the Harness regulation.

#### Component D: Fork 3 — Constraints Registry (`forks/tactical_constraints.md`)
* **Responsibility:** hard constraints from the task description, technical environment limits (available utilities, MCP tools, sandbox), and the system Wiki (L3) standards.
* **How it works:** a static constraint reference registry filled during initialization. Prevents hallucinations and unnecessary Wiki reading during execution.

#### Component E: Fork 4 — Tools & Skills Registry (`forks/tactical_tools_registry.md`)
* **Responsibility:** the hint base, available system skills, active MCP servers, the Harness script cheat sheet, and tools/skills attached dynamically during work.
* **How it works:** an extensible catalog of the agent's capabilities. Initialized with a base set and extended as iterations progress (experience evolution).

#### Component F: Fork 5 — Deep Archive (`forks/tactical_archive_dump.md`)
* **Responsibility:** the dump of raw logs and old iterations of closed nodes (Cold Storage).
* **How it works:** strictly append-only. Not read by the agent by default (token economy). Populated by the `archiveNodeLog.js` script at the moment the active node transitions to `PASS`.

---

### 3. CONTROL PRINCIPLES AND CYBERNETICS (RALPH LOOP)
Every roadmap node (step) inside Fork 1 must spin in a continuous control loop until fully resolved:

1. **Choosing the weapon (AI strategies):** for each node the AI Dispatcher must explicitly choose and record one of the 7 control strategies (Prompt Chaining, Routing, Parallelization, Orchestrator-Workers, Map-Reduce, LATM / Tool Maker, Evaluator-Optimizer) and pick the cheapest suitable specialized subagents for token economy.
2. **Isolation in L1:** an isolated operational memory (L1) is created for the step. Depending on the selected AI strategy, the Dispatcher must create and validate the following files:
   * **Prompt Chaining:** `op_memory.json` is mandatory (iteration log in `iterations`).
   * **Routing:** the decision is written to `op_route.json` (with `"route_selected"`), tasks and results — to `op_worker_task_[route_selected].json` and `op_worker_result_[route_selected].json`.
   * **Parallelization:** part tasks are written to `op_task_part_[ID].json`, and each worker's results — to `op_result_part_[ID].json` for later merging.
   * **Orchestrator-Workers:** tasks are issued via `op_worker_task_[worker_id].json`, reports — `op_worker_result_[worker_id].json` for all workers declared in the `"workers"` field of `op_memory.json`.
   * **Map-Reduce:** data chunks are written to `op_map_data_[ID].json`, and the aggregated result — to `op_reduce_final.json`.
   * **LATM / Tool Maker:** the tool specification is written to `op_tool_make.json`, run/test logs — to `op_tool_use.json`.
   * **Evaluator-Optimizer:** the interaction log and evaluation history are written to `op_feedback_loop.json` (must contain a non-empty `iterations` array).
   * *Cognitive protocol (Persona Shift):* when emulating subagents the agent must separate its thinking processes with marker blocks in thoughts (`[SHIFT PERSONA: WorkerRole]`) and communicate strictly through the disk contracts above, to exclude cognitive self-favoring. Detailed specifications and JSON schemas of the files are described in the subagent_analysis.md artifact.
3. **Iteration control and error handling:** if a subagent fails the DoD criteria, the next Ralph Loop iteration starts, correcting the course.
   * *Transition rule:* on successful validation (`PASS`) the node moves to the `validated` stage and is then advanced via `loopAdvancer`. On failed validation (`FAIL`) the node moves to the `report_ready` stage, from which advancement via `loopAdvancer.js ... --status FAIL` is allowed to increment the reflection iteration without blocking the pipeline.
   * *Deliverables path resolution:* the Harness system resolves artifact paths both relative to the L2 task folder and with an automatic fallback to the repo root. This allows clean repo-root paths (e.g. `ColorSortWeb/src/main.js`).
4. **Unreachability handling (emergency exit):** if the iteration limit is exhausted or an insurmountable technical constraint is found, the Dispatcher must transition the node to `CRITICAL_FAIL`, freeze the system in `ATTENTION_REQUIRED`, and produce an **Unreachability Report** for the human (root cause + alternative solution paths). This is a mandatory **Human Gate** (escalation).

---

### 4. AUTOMATION AND SCRIPT ECOSYSTEM
The system is driven by a deterministic Node.js program layer:

* **[tacticalTools.js](../Scripts/tacticalTools.js) (data-collection utility pack):** scripts that, at zero token cost, extract lists of unfinished tasks and successfully completed steps, aggregate metrics, and extract clean result artifacts (`output_data`).
* **[reindexTactical.js](../Scripts/reindexTactical.js) (auto-index builder):** a two-pass stabilization script. It scans the Master and all forks, computes the physical line coordinates of headings, and atomically rewrites the Navigation Matrix in the Master.
  * *Anchor-based search:* to avoid the fragility of text search when headings change (emoji replacement, translation, rephrasing), a hidden marker comment of the form `<!-- ANCHOR: ID -->` (e.g. `<!-- ANCHOR: GLOBAL_PLAN -->`) is placed above each key section in the Markdown files. The auto-indexer looks for these markers first, using text regular expressions only as a fallback for compatibility with old tasks.

> **AI DUTY:** after every change made to any of the L2 documents, the agent must trigger the reindex script (`node HarnessProtocol/Scripts/reindexTactical.js <task_dir>`). This guarantees mathematically exact line coordinates and lets scripts read files pointwise, saving context.

---

### 5. REFERENCE OUTPUT TEMPLATE (CONTRACT FORMAT)

When initializing or updating the tactical level, the following visual structure must be strictly followed (example for task TACT-045):

#### [File 1: `tactical_master.md`]
```markdown
# 🧭 END-TO-END NAVIGATION MATRIX (SYSTEM CORE)
[Line 012] -> # 📋 1. GLOBAL PLAN AND REQUIREMENTS
[Fork_1 -> Line 015] -> # 🔄 2. CURRENT RALPH LOOP CYCLE
[Fork_1 -> Line 045] -> # 🎯 3. QUALITY CRITERIA (Definition of Done)
[Fork_3 -> Line 015] -> # ⚠️ 3.1. HARD CONSTRAINTS AND ENVIRONMENT (Constraints)
[Fork_2 -> Line 015] -> # 🎯 4.1. COMPLETED STEPS (Summaries / Warm Storage)
[Fork_2 -> Line 045] -> # 🔄 4.2. ACTIVE NODE LOG (Hot context)
[Archive -> Line 000]  -> (SYSTEM: Deep dump tactical_archive_dump.md. Read on CRITICAL_FAIL)
[Line 025] -> # 👤 5. HUMAN INTERVENTION JOURNAL
[Line 035] -> # 🏁 6. CLOSING CONDITION AND FINAL RESULT

# 📋 1. GLOBAL PLAN AND REQUIREMENTS
... (spec text and stages) ...

# 👤 5. HUMAN INTERVENTION JOURNAL
... (developer comments and corrections) ...

# 🏁 6. CLOSING CONDITION AND FINAL RESULT
... (final artifacts and closure confirmation) ...
```

#### [File 2: `forks/tactical_ralph_loop.md`]
```markdown
# 🔄 2. CURRENT RALPH LOOP CYCLE
*   **Roadmap step:** `NODE-02: Session encryption development (AES-GCM)`
*   **Selected strategy:** `Evaluator-Optimizer` | **L1 file:** `op_aes_cipher.json`
*   **Ralph Loop State:** `Iteration #4` | Vector: optimizing the V8 memory allocation buffer.

# 🎯 3. QUALITY CRITERIA (Definition of Done)
* [x] Encryption works without overflow errors.
* [ ] Memory is released correctly after garbage collection.
```

#### [File 3: `forks/tactical_work_log.md`]
```markdown
<!-- ANCHOR: COMPLETED_NODES -->
# 🎯 4.1. COMPLETED STEPS (Warm Storage)

### ✅ NODE-01: Example of a completed step
Artifact: `Example.cs`. A systematic approach was used.

<!-- ANCHOR: ACTIVE_NODE_LOG -->
# 🔄 4.2. ACTIVE NODE LOG (Hot context)

### ⏱ [2026-06-26 16:15] | Subtask: TASK-772 (AES-GCM)
*   **Executor:** `crypto_agent_v1` | **Outcome:** `BLOCKED` (Iteration #3)
*   **Applied strategy:** `Evaluator-Optimizer`
*   **Key insight:** the agent looped due to a wrong buffer format in Node.js.
```


#### [File 4: `forks/tactical_constraints.md`]
```markdown
# ⚠️ 3.1. HARD CONSTRAINTS AND ENVIRONMENT (Constraints)

## 📌 A. CONSTRAINTS FROM THE TASK STATEMENT (Business scope)
*   **Style/output format:** ESM (import/export), asynchronous code, UTF-8 without BOM for scripts.
*   **Architectural taboo:** external libraries are forbidden (e.g. `crypto-js`). Only `node:crypto`.

## 💻 B. ENVIRONMENT AND SKILL CONSTRAINTS (Harness technical scope)
*   **Runtime version:** Node.js v22.2.0.
*   **Sandbox restriction:** external Internet access is closed.

## 📖 C. SYSTEM WIKI REQUIREMENTS (Global L3 standards)
*   **Encoding standards (Wiki-ID: ENC-01):** C#/Markdown with BOM, JavaScript without BOM.
```
