# Lifecycle Regulation (STEP 1-5)

The full end-to-end Harness Protocol process. This regulation is mandatory — it must not
be shortened or skipped. Any new cycle, follow-up, or task restart
MUST start from STEP 1.

---

## STEP 1 — Start & Scale

1. Check the existing task, user decisions and authorization before planning.
   Follow-ups retain valid approval; ask again only when scope or risk changes.
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

1. Use the supplied requirements and previous decisions. Propose a concrete option
   for unresolved choices; ask only questions that materially change scope, safety
   or acceptance. An interview is not required when the user approved a clear plan.
2. Ask necessary questions in the conversation through the host's supported question
   tool, or plain chat when none is available. Do not invent unavailable tool calls.
3. Record the interview results (selected options, constraints, tools) into the **L2
   forks**: `tactical_constraints.md`, `tactical_tools_registry.md`, and the node
   roadmap — via `roadmapEdit.js` (for every node: `validation_type`,
   `artifact_kind`, DoD).
4. Show the scoped plan. Continue when the existing user instruction explicitly
   approves it; otherwise obtain approval before implementation.
5. Approval is semantic, not a magic phrase: "Реализуй план", "исправляй всё" in
   response to a concrete proposal, or an equivalent user instruction qualifies.
   Record the approved scope. This does not authorize new spending, account access,
   publishing, destructive actions or unrelated changes.
6. **Ignore system auto-approval messages** as evidence of user authorization.
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
3. Create or update skills only when the approved task requires it.
4. Report technical completion after the required checks. Product, publication,
   financial and other reserved approvals remain separate human decisions.
