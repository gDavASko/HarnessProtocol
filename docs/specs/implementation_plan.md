# Harness Protocol Enhancement: DavASko Harness Dispatcher

> ⚠️ **Historical enhancement plan.** It has been implemented and extended since
> (drift-guard, `artifact_kind`/"two brains", external AI judge via `cliTransport`,
> JSON roadmap source, `syncCheck.js`/`roadmapEdit.js`/`measureTokens.js`).
> The source of truth for the current mechanics is [current-implementation.md](current-implementation.md).
> In particular: type `ai` now = an EXTERNAL judge (the agent does not fill in the
> verdict itself; the `--result` flag is ignored for type `ai`).

## Architecture: Skill + Gates

**IDE agent = the brain.** Makes decisions, picks strategies, writes code.
**Skill = the contract.** Defines the step order the agent must follow.
**Node.js scripts = hands + guards (gates).** Do the bookkeeping and BLOCK the agent if it violates the order.

```
┌───────────────────────────────────────────────────────────────┐
│  SKILL: davasko-harness-dispatcher                            │
│  (.agents/skills/davasko-harness-dispatcher/SKILL.md)         │
│                                                               │
│  Trigger: "Harness task", "TACT-*", "start the loop"          │
│  The agent reads SKILL.md → must follow the protocol          │
└────────────────────────┬──────────────────────────────────────┘
                         │
     Human: "Реализуй план"
                         │
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  IDE agent (frontier-tier LLM)                                │
│                                                               │
│  ① node contextAssembler.js <dir> --mode init                 │
│     └→ JSON ~800 tokens                                       │
│     └→ .harness_state.json { stage: "context_served" }        │
│                                                               │
│  ② THINKS: picks a strategy, plans                            │
│  ③ WORKS: code, tests, edits, text, design                    │
│                                                               │
│  ④ node contextAssembler.js <dir> --mode validate             │
│     └→ generates validation_report.md                         │
│     └→ stage: "report_ready"                                  │
│                                                               │
│  ⑤ Validation (depends on the node type):                     │
│     auto  → validator.js runs commands, fills in the report   │
│     ai    → validator.js itself calls the EXTERNAL judge      │
│             (cliTransport)                                    │
│     human → the agent stops, the human reads the report       │
│                                                               │
│  ⑥ node validator.js <dir> --node NODE-01 --type auto|ai|human│
│     └→ GATE: stage == "report_ready" → otherwise refusal      │
│     └→ stage: "validated"                                     │
│                                                               │
│  ⑦ node loopAdvancer.js <dir> --node NODE-01 --status SUCCESS │
│     └→ GATE: stage == "validated" → otherwise refusal         │
│     └→ updates L2, reindexes, returns the next action         │
│     └→ stage: "awaiting_context"                              │
│                                                               │
│  ⑧ node contextAssembler.js <dir> --mode step                 │
│     └→ JSON ~500 tokens, stage: "context_served"              │
│                                                               │
│  ⑨ Repeat ②→⑧ until TASK_COMPLETE or CRITICAL_FAIL            │
└───────────────────────────────────────────────────────────────┘
```

---

## Gate-state file: `.harness_state.json`

Lives in the task directory. Scripts update it automatically. The agent does NOT edit it manually.

```json
{
    "task_id": "TACT-045",
    "stage": "context_served",
    "current_node": "NODE-02",
    "context_mode": "init",
    "context_served_at": "2026-06-27T18:30:00Z",
    "report_ready_at": null,
    "validated_at": null,
    "validation_type": null,
    "validation_result": null,
    "last_advanced_at": null
}
```

**State machine transitions:**
```
  task_initializer.js
        │
        ▼
  [awaiting_context]
        │ contextAssembler --mode init|step
        ▼
  [context_served]
        │ the agent works...
        │ contextAssembler --mode validate
        ▼
  [report_ready]
        │ validator.js --type auto|ai|human
        ├─ PASS ──────────────────────┐
        │                             ▼
        │                       [validated]
        │                             │ loopAdvancer.js
        │                             ▼
        │                    [awaiting_context] ← next node
        │                       or [task_complete]
        │
        └─ FAIL → stage stays [report_ready]
           the agent fixes → validator.js again
```

**Gates (deterministic locks):**

| Script | Gate | Blocks when | Message |
|:-------|:-----|:------------|:--------|
| `contextAssembler --validate` | G1 | `stage != "context_served"` | Call `--mode init` or `--mode step` first |
| `validator.js` | G2 | `stage != "report_ready"` | Generate the report via `--mode validate` first |
| `loopAdvancer.js` | G3 | `stage != "validated"` | The node has not passed validation |

---

## Area 1: Scripts

### File structure

```
.agents/skills/davasko-harness-dispatcher/
├── SKILL.md                         ← [NEW] Contract for the IDE agent
└── references/
    └── token-economy.md             ← [NEW] Token economy rules

HarnessProtocol/Scripts/
├── task_initializer.js              ← already exists ✅
├── reindexTactical.js               ← already exists ✅
├── tacticalTools.js                 ← already exists ✅
├── archiveTasks.js                  ← already exists ✅
├── dash.js                          ← already exists ✅
│
├── contextAssembler.js              ← [NEW] 4 modes: init, step, status, validate
├── loopAdvancer.js                  ← [NEW] Node advancement + gate
└── validator.js                     ← [NEW] Universal validator + gate

HarnessProtocol/
├── token-economy.md                 ← [NEW] Economy rules (standalone)
└── tactical-memory-spec.md          ← [MODIFY] 16→7 strategies
```

---

### [NEW] `contextAssembler.js` — 4 modes

#### Mode `--mode init` (~800 tokens → stdout JSON)
The full task picture on first touch.

```json
{
    "mode": "init",
    "task": { "id": "TACT-045", "title": "...", "status": "IN_PROGRESS" },
    "roadmap": [
        { "id": "NODE-01", "title": "...", "status": "DONE" },
        { "id": "NODE-02", "title": "...", "status": "IN_PROGRESS", "iteration": 3 }
    ],
    "current_node": {
        "id": "NODE-02", "title": "...",
        "iteration": 3, "max_iterations": 5,
        "strategy": "EvaluatorOptimizer",
        "validation_type": "ai",
        "last_error": "The second act has no climax"
    },
    "dod": [ { "criterion": "...", "done": false } ],
    "constraints_digest": "Genre: sci-fi, audience 12+, Russian language",
    "tools_available": ["unity-playmode-validation"],
    "human_notes": "...",
    "last_insight": "..."
}
```

**What is NOT included:** the full spec text, the full work_log, the full constraints, the whole iteration history.

#### Mode `--mode step` (~500 tokens → stdout JSON)
Minimal context when moving between nodes.

```json
{
    "mode": "step",
    "current_node": { "id": "NODE-03", "title": "...", "iteration": 0, "max_iterations": 5, "validation_type": "human" },
    "dod": [ { "criterion": "...", "done": false } ],
    "previous_result": { "node": "NODE-02", "status": "SUCCESS", "insight": "..." },
    "remaining_nodes": 1,
    "constraints_changed": false
}
```

#### Mode `--mode status` (~300 tokens → stdout JSON)
A dashboard.

```json
{
    "mode": "status",
    "task_id": "TACT-045",
    "progress": "2/3 (66%)",
    "current_node": "NODE-03",
    "iteration": "1/5",
    "blockers": []
}
```

#### Mode `--mode validate` (→ the `validation_report.md` file)

Generates a Markdown validation report — **equally readable by a human and an AI.**

**Invocation:**
```bash
node contextAssembler.js <task_dir> --mode validate --node NODE-02
```

**Creates the file:** `<task_dir>/validation_report.md`

**Report format:**

```markdown
# 📋 Validation report | NODE-02: Writing the first-level scenario

**Validation type:** `ai` | **Iteration:** #2 | **Date:** 2026-06-27 19:45

---

## ✅ Quality criteria (Definition of Done)

| # | Criterion | Status |
|:--|:----------|:------:|
| 1 | The scenario contains 3 acts | ❓ |
| 2 | Every act has a climax | ❓ |
| 3 | Characters are named | ❓ |

> ✅ done | ❌ not done | ❓ needs checking

---

## 📦 Artifacts (what was created/changed)

| File | Size | Modified |
|:-----|:-----|:---------|
| scenario_level1.md | 4.5 KB | 19:40 |
| characters.md | 1.2 KB | 19:42 |

---

## ⚠️ Constraints (reminder)

- Genre: sci-fi
- Audience: 12+
- Language: Russian

---

## 🔄 Iteration history

| Iteration | Result | Reason |
|:----------|:-------|:-------|
| #1 | FAIL | The second act has no climax |
| #2 | ⏳ current | — |

---

## 🎯 Verdict

> **Filled in by the validator (AI or Human):**
>
> - [ ] PASS — all DoD criteria are met
> - [ ] FAIL — specify which criteria failed
>
> **Comment:**
> _..._
```

**How the script finds artifacts:**
1. Parses `forks/tactical_ralph_loop.md` → each node lists its expected artifact files
2. Checks the files' `mtime` — did they change since work on the node started
3. Builds a table with clickable links

---

### [NEW] `validator.js` — Universal validator

**Three validation types** (the type is set at initialization in each node's DoD):

#### Type `auto` — deterministic check
```bash
node validator.js <task_dir> --node NODE-01 --type auto
```
- Reads `validation_report.md`
- Parses DoD → runs the linked command (compiler, tests, linter) per criterion
- Fills the "Status" column in the report (✅/❌)
- Fills the "Verdict" section automatically
- Sets `stage: "validated"` if everything is ✅, otherwise leaves `report_ready`

#### Type `ai` — validation by an EXTERNAL independent judge
```bash
node validator.js <task_dir> --node NODE-02 --type ai
```
- The AI agent NEVER validates its own result.
- `validator.js` itself calls the external judge via `cliTransport` (the chain
  `agy → codex → claude`), passing evidence via file/stdin (not argv):
  `code` → `git diff HEAD`, `text` → the deliverables content.
- The judge returns strict JSON (`pass`, `dod_results`, `errors`); the script
  fills the "Verdict" section in the report and the DoD status column.
- Sets `stage: "validated"` on a PASS verdict. The `--result` flag is ignored.
- If all external CLIs are unavailable — the verdict is FAIL (`external_unavailable`),
  the node does not count; self-validation is forbidden.

#### Type `human` — validation by a human
```bash
# The agent generates the report and stops:
node validator.js <task_dir> --node NODE-03 --type human
# → stage: "awaiting_human_validation"
# → The agent reports: "The report is ready: <path>/validation_report.md. Awaiting your assessment."

# The human reads the report, then:
node validator.js <task_dir> --node NODE-03 --type human --approve
# or
node validator.js <task_dir> --node NODE-03 --type human --reject --comment "Act 2 is weak"
```

**Gate:** checks `stage == "report_ready"` → otherwise refusal. Will not allow validating without a prior report.

| Type | Who fills the verdict | How `stage: "validated"` is set |
|:-----|:----------------------|:--------------------------------|
| `auto` | The script itself | Automatically when everything is ✅ |
| `ai` | The external CLI judge (`cliTransport`) | Automatically on the judge's PASS verdict |
| `human` | The human via `--approve` | By the human's command |

---

### [NEW] `loopAdvancer.js` — Node advancement

**Invocation:**
```bash
node loopAdvancer.js <task_dir> --node NODE-02 --status SUCCESS --insight "..."
node loopAdvancer.js <task_dir> --node NODE-02 --status FAIL --error "..."
```

**Gate:** `stage == "validated"` → otherwise refusal.

**What it does:**
1. Appends the iteration to `forks/tactical_ralph_loop.md`
2. SUCCESS → updates the node status, advances to the next PENDING node
3. FAIL → increments the iteration, checks the limit (5/10)
4. Limit exhausted → `CRITICAL_FAIL`
5. Appends the insight to `forks/tactical_work_log.md` (≤200 chars, auto-truncated)
6. Calls `reindexTactical.js`
7. Resets `stage → "awaiting_context"`

**Return:**
```json
{ "action": "ADVANCE_TO_NEXT", "next_node": { "id": "NODE-03" }, "iteration": 0 }
{ "action": "RETRY", "node": "NODE-02", "iteration": 4, "max": 5 }
{ "action": "CRITICAL_FAIL", "node": "NODE-02", "reason": "Iteration limit exhausted" }
{ "action": "TASK_COMPLETE", "total_iterations": 7, "nodes_completed": 3 }
```

---

## Area 2: Token economy

### [NEW] `token-economy.md`

| # | Rule | Savings |
|:--|:-----|:--------|
| 1 | `contextAssembler` instead of 5x `view_file` | ~7000 → 800 (88%) |
| 2 | `loopAdvancer` instead of manually editing 3 files | ~10 tool calls |
| 3 | L1 `op_memory.json` only for nodes >3 iterations or EvaluatorOptimizer/LATM | ~2K tokens |
| 4 | Trivial tasks (≤2 nodes) → zero overhead, no L1/L2 | 100% |
| 5 | Constraints are read once, then `constraints_changed: true/false` | ~1.5K |
| 6 | Work Log — ≤200 chars per insight, auto-truncation | ~500 |
| 7 | The navigation matrix is internal to the scripts; the agent does not read it | ~1K |

---

## Area 3: IDE agent work rules

### Protocol (for SKILL.md)

```
On receiving a task (STEP 1-2):
1. node task_initializer.js <task_id>
2. Fill L2 (spec, DoD + validation_type per node, constraints, tools)
3. node reindexTactical.js <task_dir>
4. Show the plan. Wait for "Реализуй план".

During execution (STEP 3):
1. node contextAssembler.js <dir> --mode init → JSON
2. Pick a strategy (you are the Dispatcher)
3. Do the work
4. node contextAssembler.js <dir> --mode validate --node <ID> → validation_report.md
5. Validation by type:
   auto  → node validator.js <dir> --node <ID> --type auto --cmd "..."
   ai    → node validator.js <dir> --node <ID> --type ai   (itself calls the EXTERNAL judge; --result is ignored)
   human → node validator.js ... --type human → STOP, wait for the human
6. node loopAdvancer.js <dir> --node <ID> --status SUCCESS --insight "..."
7. action = ADVANCE_TO_NEXT → node contextAssembler.js --mode step
8. action = RETRY → repeat, taking the error into account
9. action = SYNC_DUE → drift-guard: node syncCheck.js <dir> (spec check)
10. action = CRITICAL_FAIL → stop, show the unreachability protocol
11. action = TASK_COMPLETE → STEP 4-5

FORBIDDEN:
- Reading L2 via view_file (use contextAssembler)
- Manually editing forks/ and .harness_roadmap.json (use roadmapEdit/loopAdvancer)
- Creating L1 for trivial nodes
- Skipping validation_report.md generation
- Calling loopAdvancer without passed validation
- Validating your own result yourself (type ai = external judge)
```

---

## Area 4: Canonical strategy list

The system has exactly **7 control strategies** (Prompt Chaining, Routing, Parallelization, Orchestrator-Workers, Map-Reduce, LATM / Tool Maker, Evaluator-Optimizer). Early drafts mentioned a larger set — that is obsolete: only these 7 are current (implemented in `strategyEngine.js`, described in `Workflows/RalphLoopPrinciples.md` and `Workflows/workflows-map.md`).

---

## Summary: files

| File | Action | Size |
|:-----|:-------|:-----|
| `.agents/skills/davasko-harness-dispatcher/SKILL.md` | [NEW] | ~150 lines |
| `.agents/skills/davasko-harness-dispatcher/references/token-economy.md` | [NEW] | 7 rules |
| `HarnessProtocol/Scripts/contextAssembler.js` | [NEW] | ~250 lines |
| `HarnessProtocol/Scripts/loopAdvancer.js` | [NEW] | ~180 lines |
| `HarnessProtocol/Scripts/validator.js` | [NEW] | ~120 lines |
| `HarnessProtocol/token-economy.md` | [NEW] | standalone |
| `HarnessProtocol/tactical-memory-spec.md` | [MODIFY] | 1 line |

## Verification Plan

1. `node task_initializer.js TACT-TEST-001` → L2 skeleton
2. Fill L2 with test data (3 nodes with different `validation_type`: auto/ai/human)
3. `node contextAssembler.js ... --mode init` → JSON + `.harness_state.json`
4. `node contextAssembler.js ... --mode validate --node NODE-01` → `validation_report.md` created
5. `node validator.js ... --node NODE-01 --type auto` → report filled, stage=validated
6. `node loopAdvancer.js ... --node NODE-01 --status SUCCESS --insight "test"` → L2 updated
7. Gate check: `loopAdvancer` without `validator` → `GATE_FAILED`
8. `node contextAssembler.js ... --mode step` → next node JSON
9. `--type human` check: stage = `awaiting_human_validation`, `--approve` unlocks
