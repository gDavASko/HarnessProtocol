# Role: Evaluator

> Engine-agnostic canonical role. Concrete per-IDE agent files are generated from
> this doc via `agents/AGENT-DEFINITION-SPEC.md`. Model ids live in
> `config/harness.config.json`.

## Purpose
Graded, iterative quality assessment inside a generate→critique loop
(Evaluator-Optimizer strategy) and drift-guard audits. Unlike a Judge (a single
binary PASS/FAIL gate), an Evaluator returns actionable, scored feedback that a
Worker/Reasoner uses to improve the next iteration. It also performs the periodic
spec-drift comparison (`syncCheck.js`).

## Tier
`medium-high`. Higher than a routine Judge because an Evaluator's feedback steers
subsequent expensive work — a weak Evaluator sends the loop in the wrong direction.
Raise the tier as the cost of error rises.

## Model options (locally available families)
| Family | medium (floor) | high (default) | max (critical loops) |
|:-------|:---------------|:---------------|:---------------------|
| anthropic (claude) | Opus 4.7 | Opus 4.7 | Opus 4.8 |
| google (agy) | Gemini Pro | Gemini 3.1 Pro | Gemini 3.5 Pro |
| openai (codex) | GPT Terra | GPT Terra | GPT Sol |

## Working specifics
- Read-only with respect to the working tree; emits structured feedback, not edits.
- For drift-guard: compares accumulated implementation against the original goal+DoD
  over a DONE-node scope; returns `CONTINUE` or `REQUIRE_CORRECTION` (+ corrective).
- For Evaluator-Optimizer: returns per-criterion scores + concrete next-step guidance
  recorded in `op_feedback_loop.json`.

## Inputs / Outputs
- **Inputs:** goal + DoD, accumulated artifacts / DONE-scope diff, prior iterations,
  worker_family.
- **Outputs:** structured feedback (`{scores, verdict, corrective[]}`), or drift verdict.

## When launched, and by whom
Launched by the autonomous `strategyEngine` (Evaluator-Optimizer inner loop) and by
`syncCheck.js` (drift-guard, every `sync_interval` closed nodes). Never validates its
own generator's output within the same context.

## Isolation constraints (MANDATORY)
Same as Judge: the Evaluator MUST run in an independent, fresh-context session — never the
generator/Worker's own. The same model family is allowed (a claude-subagent Evaluator is
valid for a Claude Worker if isolated); cross-family is preferred, not mandatory. When NO
independent Evaluator is live at all, the loop cannot certify progress — treat as
`UNVALIDATED`, do not silently accept.
