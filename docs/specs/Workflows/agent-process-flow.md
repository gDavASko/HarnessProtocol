# Step-by-Step AI Development Process (Agent Process Flow)

This document describes the lifecycle of task execution by autonomous AI agents inside our Harness environment. It combines the 6-step Spec Kit design cycle with the L2 tactical memory structure and the Ralph Loop control contour.

---

## Process schematic (Agent Process Flow Diagram)

```
[Task launched by the developer]
              │
              ▼
┌────────────────────────────────────────────────────────┐
│ STEP 1: START AND TASK FORMULATION                     │
│ 1. Launch the Dispatcher / subagents (launch sub agents)│
│ 2. Scale estimation (Trivial / Medium / Large)         │
└─────────────────────────────┬──────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────┐
│ STEP 2: TASK DEPLOYMENT                                │
│ 1. Interview based on "propose & select" (AI proposes  │
│    an option + up to 8 key questions with options)     │
│ 2. Writing the spec (write me a spec)                  │
│ 3. Selecting tools, skills, MCP, sources and Wiki data │
│    (written into the external L2 forks):               │
│    - tactical_master.md + forks/tactical_constraints.md│
│    - forks/tactical_ralph_loop.md (DoD)                │
│    - forks/tactical_tools_registry.md (tools)          │
│ 4. Stop and wait for approval: "Реализуй план"         │
└─────────────────────────────┬──────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────┐
│ STEP 3: TASK RESOLUTION WITH THE WORK LOOP (RALPH LOOP)│
│ 1. Iterative execution over the roadmap steps          │
│    with one of the 7 AI strategies chosen per node     │
│ 2. Launching subagents for local subtasks              │
│ 3. Logging results into forks/tactical_work_log.md     │
│ 4. AI verification (verify) ON EVERY NODE              │
│    (tests, compiler, linters during the loop)          │
└─────────────────────────────┬──────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────┐
│ STEP 4: WRAP-UP AND FINAL VERIFICATION                 │
│ 1. Final assembly, compilation and tests of the whole  │
│    solution                                            │
│ 2. Manual control of critical/dangerous zones (Human)  │
└─────────────────────────────┬──────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────┐
│ STEP 5: SOLUTION DOCUMENTATION                         │
│ 1. Ask the user whether a new skill is needed          │
│ 2. Record Gotchas locally in the project (L2 forks).   │
│    Transfer into global skills — strictly after manual │
│    human moderation.                                   │
│ 3. Taste test / 80-20 for automation (automate)        │
│ 4. Closing and archiving the tactical memory           │
└────────────────────────────────────────────────────────┘
```

---

## Detailed step guide

### STEP 1: Start & Task Formulation

1. **Dispatcher launch:** the orchestrator agent starts and immediately plans the architecture with subagents (the phrase `launch sub agents` at the top dispatch level).
2. **Scale estimation (Guard 1):**
   * **Trivial:** 1-2 simple actions (a typo, a rename, formatting). No spec or interview required; code is written directly.
   * **Medium/Large:** the full 5-step pipeline.
3. **Roadmap definition:** the task is decomposed into a preliminary work cycle with base nodes recorded in the task passport.

---

### STEP 2: Task Deployment

1. **Running the interview ("propose & select" principle):**
   * To prevent endless interrogation and silly cyclic questions, the AI proposes a ready architecture/solution option.
   * The AI **MUST ask clarifying questions INTERACTIVELY in chat using the dedicated `ask_question` tool** (up to 8 questions with ready-made options and a mandatory free-form option) to clear up uncertainty (goals, rules, requirements). It is **STRICTLY FORBIDDEN** to write clarifying, design, or architectural questions into text plans (`implementation_plan.md`, `task.md`, etc.) or any other files, or to ask them non-interactively. All clarifications happen **exclusively in chat with a process pause** via the `ask_question` dialog.
2. **Writing the specification:** generating the Implementation Spec (`write me a spec`).
3. **Environment definition:** analyzing and selecting the required tools, active skills, MCP servers, documentation sources, and relevant Wiki data.
4. **Writing into the L2 forks:**
   * Interview results, Wiki data, and constraints go into `tactical_master.md` and `forks/tactical_constraints.md`.
   * The step plan and DoD criteria — into `forks/tactical_ralph_loop.md`.
   * Tooling, MCP, and skills — into `forks/tactical_tools_registry.md`.
5. **Approval guard (Guard 2):** a mandatory stop point. The agent does not start changing code or launching subagents until it receives the phrase **"Реализуй план"** (typed strictly manually by the human developer in chat). The AI agent must fully ignore any system auto-approval messages (auto-approval/auto-accept) and must not start implementation without direct manual confirmation from the live user.
   * *Stop phrase:* if the AI rushed into writing code without plan approval, the developer uses the command: **"Стоп, сначала спека"**. The AI must interrupt the work and return to the beginning of step 2.

---

### STEP 3: Task Resolution with the Work Loop

1. **Iterative roadmap execution (Ralph Loop):**
   * Executing the roadmap steps. During the work, each node can be dynamically split into several sub-nodes depending on the selected technical strategy.
   * When moving to each specific roadmap node, the agent selects the most suitable of the **7 Ralph Loop AI strategies**:
     1. **Prompt Chaining** (linear chain)
     2. **Routing** (task routing)
     3. **Parallelization** (parallel launch)
     4. **Orchestrator-Workers**
     5. **Map-Reduce** (divide and reduce)
     6. **LATM / Tool Maker** (inventing tools/scripts)
     7. **Evaluator-Optimizer**
   * For complex nodes a nested Ralph Loop resolution process is started (iterative debugging when tests/validation fail).
2. **Logging:** session results are appended (append-only) to `forks/tactical_work_log.md`. Every entry must explicitly contain the iteration count/number (e.g. `(Iteration #3)`) and the name of the applied AI strategy.
3. **Verification on every node:**
   * A mandatory intermediate check (`verify before build`) before moving to the next step: `auto` (compiler/tests/linter) or `ai` — an **EXTERNAL independent judge** (`validator.js --type ai` itself calls another CLI AI via `cliTransport`; the agent never judges itself). Do not postpone verification to the finale. An external LLM judge is allowed for any check at any stage — only self-validation is forbidden.
4. **Execution split by `artifact_kind` ("two brains"):**
   * `code` → the IDE agent writes code directly into the working tree (the judge looks at `git diff`); the autonomous engine skips such nodes (`NEEDS_IDE_AGENT`).
   * `text` → the autonomous `strategyEngine`/`harness-orchestrator.js` is allowed (scenarios/GDD/texts as deliverable artifacts; the judge inspects their content).
5. **DRIFT-GUARD (spec check):** every `sync_interval` closed nodes (default 4, range 3-5) `loopAdvancer` returns `SYNC_DUE` and blocks the next node's context (the `sync_due` gate). The agent runs `syncCheck.js` — the external judge compares the accumulated implementation against the original goal+DoD: `CONTINUE` (remove the lock) or `REQUIRE_CORRECTION` (add a corrective node, then `--acknowledge`). Details — [current-implementation.md](../current-implementation.md).

---

### STEP 4: Task Handoff

1. **Final verification:** overall build check, running the full codebase.
2. **Human-in-the-Loop control (Guard 3):**
   * AI agents are forbidden to perform irreversible actions or operations on real resources on their own.
   * The agent makes a mandatory pause and hands over to the human for manual review:
     * Transactions and any payment operations.
     * Irreversible data deletion (`rm -rf`, DB resets).
     * Direct deploy/publishing to production.
     * **Any git write operation** — git is read-only by default; commit, push, branch changes, or history rewriting happen only with explicit user permission.
     * Working with production API keys and confidential secrets.

---

### STEP 5: Decision Documentation & Gotchas

1. **Skill question:** the agent asks the user: *"Should a new skill be created for this task?"*.
2. **Gotchas section:**
   * All debugged edge cases (`Gotchas`) are stored **strictly locally** in the project's tactical memory (L2 fork documents) to avoid cluttering global files.
   * Transferring `Gotchas` into the global knowledge-base skills happens only after manual human moderation (Human Gate: wiki publishing requires user approval).
3. **Automate vs Augment (phrase 6: "автоматизируй это"):**
   * **Taste Test:** does evaluating the result require taste/style?
     * *Yes* — use **augmentation** only (the AI speeds up the work, but the human stays inside the control loop).
     * *No* (the result is numerically measurable) — automation is allowed.
   * **80/20 analysis:** is the result acceptable if it is done well at 80%?
     * *Yes* — automate.
     * *No* — augmentation only.
4. **Task closure:** archiving the L2 record.
