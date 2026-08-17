# Harness Protocol Dispatcher Skill: description and installation

> This page describes the `davasko-harness-dispatcher` skill — what it does and how
> to deploy it. **The skill itself is not stored in the wiki**: its working copy lives
> outside the indexed layer, in `HarnessProtocol/skill/` (see "Installation").

---

## What it is

`davasko-harness-dispatcher` is a skill-contract for the IDE agent that orchestrates
task execution under the Harness Protocol: the Ralph Loop, L1/L2/L3 memory, selection
from 7 strategies, validation (auto/ai/human) via a gated state machine, and the drift-guard.
The skill is the "brain" (makes decisions); the Node.js scripts from `HarnessProtocol/Scripts/`
are the "hands and gates" (iteration bookkeeping, validation, blocking wrong-order actions).

## What it can do

- Runs the full STEP 1-5 regulation (scaling → interactive interview
  via `ask_question` → "Реализуй план" → Ralph Loop → verification → Gotchas).
- Maintains the roadmap via `roadmapEdit.js` (JSON is the source of truth).
- Saves context via `contextAssembler` (measured savings init ≈ 86-90%).
- Validates every node; type `ai` — always via an EXTERNAL independent judge
  (the agent never judges itself).
- Splits execution by `artifact_kind`: `code` is written by the IDE agent, `text` may
  be driven by the autonomous engine.
- Every `sync_interval` nodes runs the **drift-guard** — a check against the original spec.

## Triggers

Requests for complex/multi-step work: "complex task", "design and
implement", "develop a feature", "refactoring", "migration", "write a GDD/scenario/spec",
"decompose the task", "implement step by step", plus explicit ones: "Harness task",
"TACT-*", "start the loop", "tactical task", "harness dispatcher".
Trivial tasks (≤2 nodes) are handled with zero overhead.

## Installation (deployment into a new environment)

The working copy of the skill lives in `HarnessProtocol/skill/davasko-harness-dispatcher/`.
Copy it into your agent's skills directory:

```bash
# .agents/skills:
cp -r HarnessProtocol/skill/davasko-harness-dispatcher <repo>/.agents/skills/
# .claude/skills:
cp -r HarnessProtocol/skill/davasko-harness-dispatcher <repo>/.claude/skills/
```

Requires the `HarnessProtocol/` folder (scripts) and Node.js (ESM).
Mechanics details — in [current-implementation.md](current-implementation.md).

## Skill structure (multi-layer)

- `SKILL.md` — the contract: role, Human Gate, state machine, STEP 1-5, prohibitions, triggers.
- `references/process-flow.md` — the STEP 1-5 regulation (incl. drift-guard).
- `references/memory-and-validation.md` — L1/L2/L3, validation, cliTransport.
- `references/strategies.md` — the 7 strategies, "two brains".
- `references/token-economy.md` — token economy rules.
