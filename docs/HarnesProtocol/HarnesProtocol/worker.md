# Role: Worker

> Engine-agnostic canonical role. Concrete per-IDE agent files are generated from
> this doc via `agents/AGENT-DEFINITION-SPEC.md`. Model ids live in
> `config/harness.config.json`, never hard-coded here.

## Purpose
Mechanical execution of a fully specified unit of work: apply a diff, write
boilerplate, run codemods, generate tests, format, rename, wire obvious plumbing.
The Worker does NOT decide architecture and does NOT judge results.

## Tier
`cheap`. Workers are the highest-volume, lowest-stakes agents; per the Model-Tier
Doctrine they run on cheap model families. Escalating a Worker to a top-tier model
is a hard-rule violation (rule 1: never run mechanical work on a top-tier model).

## Model options (locally available families)
| Family | cheap (default) | medium (only if node.tier raised) | max (never) |
|:-------|:----------------|:----------------------------------|:------------|
| anthropic (claude) | Sonnet / Haiku | Opus 4.7 | — |
| google (agy) | Gemini Flash | Gemini Pro (mid) | — |
| openai (codex) | GPT mini/Luna | GPT Terra | — |

Default: `cheap`. A Worker may be raised to `medium` only when the node explicitly
sets a higher `tier` (e.g. subtle refactor); `max` is out of scope for Workers.

## Working specifics
- Reuses one persistent CLI session per multi-turn task (`cliTransport.runWorkerTurn`)
  so later turns send only a delta prompt.
- Refuses before spawning if the prompt estimate exceeds `budgetTokens`
  (`BUDGET_EXCEEDED`, no silent burn).
- Writes code into the working tree (for `artifact_kind=code`, the IDE agent is the
  Worker) or into `op_*.json` blobs (for `artifact_kind=text`, the autonomous engine).

## Inputs / Outputs
- **Inputs:** node spec (DoD, deliverables), the changed section / delta context,
  relevant files. Not the full transcript.
- **Outputs:** the artifact (diff or deliverable) + a ≤300-token handoff SUMMARY.

## When launched, and by whom
Launched by the **Manager** (orchestrator) or the autonomous `strategyEngine` for
every executable roadmap node. One Worker per node/part.

## Cross-family constraints
None — a Worker produces, it does not validate. Its output is graded by a Judge or
Evaluator of a DIFFERENT family (see `judge.md`), and its `worker_family` is recorded
on the node so the selector can exclude it from the judge pool.
