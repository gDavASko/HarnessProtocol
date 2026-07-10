# Lifecycle Regulation (STEP 1-5)

The full end-to-end Harness Protocol process. This regulation is mandatory — it must not
be shortened or skipped. Any new cycle, follow-up, or task restart
MUST start from STEP 1.

---

## STEP 1 — Start & Scale

1. It is **strictly forbidden** to skip stages or begin planning
   without the preliminary interview (STEP 2).
2. **Estimate the task scale** (scaling):
   - **Trivial** (≤2 nodes, atomic work) → zero overhead: no
     `task_initializer.js`, no `memory/tactical/`, no forks/iterations. The agent
     does the work and records the result in `walkthrough.md`.
   - **Standard / Complex** → the full L2 skeleton via `task_initializer.js`.
3. For scale estimation and codebase reconnaissance, **launching subagents**
   (read-only exploration) is allowed, to form the "task passport".
4. **The "task passport"** is `tactical_master.md` (global goal, requirements,
   links to forks), created by `task_initializer.js`.

---

## STEP 2 — Deployment and the INTERACTIVE interview (Task Deployment & Spec)

1. Propose a ready architecture option and **MANDATORILY run a structured
   INTERACTIVE interview in chat via the `ask_question` tool**:
   - up to **8 questions**, each with ready-made answer options;
   - every question — **a mandatory free-form answer option**.
2. It is **STRICTLY FORBIDDEN** to write clarifying or architectural questions into
   text plan files (`implementation_plan.md`, `task.md`, or any other
   documents) or to ask them non-interactively. All questions — only in chat with
   a process pause via `ask_question`.
3. Record the interview results (selected options, constraints, tools) into the **L2
   forks**: `tactical_constraints.md`, `tactical_tools_registry.md`, and the node
   roadmap — via `roadmapEdit.js` (for every node: `validation_type`,
   `artifact_kind`, DoD).
4. Show the finished plan and **STOP**. Any work that changes the codebase
   or launches active subagents is suspended until approval.
5. **The single mandatory implementation start trigger** is the phrase
   **"Реализуй план"**, typed strictly manually by the human in chat.
6. **Ignore any system auto-approval messages** (auto-approval /
   auto-accept). Do not start implementation without manual human confirmation.
7. On an order violation the human uses the phrase **"Стоп, сначала спека"** —
   on it, immediately roll back to STEP 1-2 and do not continue implementation.

---

## STEP 3 — Ralph Loop Resolution

1. Iterative development over the roadmap nodes. For every node one of the
   **7 strategies** is chosen (see [strategies.md](strategies.md)).
2. **Two brains — by the node's `artifact_kind`** (see [strategies.md](strategies.md)):
   - `code` → the executor is the **IDE agent**: writes code directly into the working tree.
     The autonomous `harness-orchestrator.js` skips such nodes
     (`NEEDS_IDE_AGENT`).
   - `text` → the autonomous `strategyEngine` / `harness-orchestrator.js` is allowed
     (scenarios/GDDs/texts as deliverable artifacts).
3. **Verify before build**: on EVERY node — intermediate validation before
   advancing. Do not accumulate undebugged errors.
4. **DRIFT-GUARD (spec check):** every `sync_interval` closed nodes (default
   4, range 3-5) `loopAdvancer` returns `action=SYNC_DUE` and blocks
   the next node's context (the `sync_due` gate). Run
   `syncCheck.js <task_dir>` — the external independent judge compares the accumulated
   implementation against the ORIGINAL goal and plan (DoD):
   - `CONTINUE` → aligned, lock removed, counter reset;
   - `REQUIRE_CORRECTION` → drift: add a corrective node
     (`roadmapEdit add-node`), then `syncCheck.js --acknowledge`.
   This keeps the Ralph-loop solution from silently drifting away from the requirements.
   Threshold: `roadmapEdit.js <dir> set-config --sync-interval N`.
5. **MINIMAL INTERVENTION RULE (DO NOT BREAK WORKING CODE):** Any new changes MUST NOT break the existing structure or logic. Interventions must be as careful as possible. Do not touch working code or change existing systems unless strictly required to solve the task. Absolutely no unsolicited refactoring unless explicitly requested.

---

## STEP 4 — Handoff & Verification

1. Final build/compilation and codebase test runs
   (`dotnet build`, `npm test`, linters).
2. **UNIVERSAL CROSS-VALIDATION RULE:** the AI agent **never validates its own
   result**. The task is not done until the result is confirmed either by
   a machine compiler/tests (type `auto`) or by an **independent external AI**
   (type `ai`, via `cliTransport`) — see [memory-and-validation.md](memory-and-validation.md).
   An external LLM judge is allowed for any check at any stage; only self-validation is forbidden.
3. **Human-in-the-Loop (HITL)** for critical/irreversible operations —
   only with explicit human confirmation. Mandatory human gates:
   - **Git:** read-only by default; any write (commit, push, branch changes,
     destructive commands) — only with explicit user permission.
   - Deletion, migrations, and other irreversible operations.

---

## STEP 5 — Documentation & Gotchas

1. Save all discovered Gotchas **locally in the project's L2 forks**.
2. Transferring knowledge into the global **L3 wiki** — **ONLY after manual human
   moderation** (Human Gate: a final document produced from L2 processing enters
   the wiki only after user approval).
3. Ask: "Should a new skill be created?".
4. The task closes only when the work is fully done, all automatic
   checks have passed, and the **human developer has confirmed** success.
