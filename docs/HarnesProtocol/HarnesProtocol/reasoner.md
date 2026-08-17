# Role: Reasoner

> Engine-agnostic canonical role. Concrete per-IDE agent files are generated from
> this doc via `agents/AGENT-DEFINITION-SPEC.md`. Model ids live in
> `config/harness.config.json`.

## Purpose
Deep, reasoning-heavy problem solving: architecture decisions, intricate multi-layer
debugging, algorithm design, and decomposition of hard tasks into an actionable
roadmap. The Reasoner produces plans, designs, and conclusions — not the bulk
mechanical implementation (that is delegated to Workers).

## Tier
`max`. Planners, solvers, and researchers get the maximum model; this is where
reasoning power buys the most (per the Model-Tier Doctrine). This is the intended,
legitimate use of the most expensive tier.

## Model options (locally available families)
| Family | max (default) |
|:-------|:--------------|
| anthropic (claude) | Opus 4.8 (or Fable 5 for orchestration-adjacent reasoning) |
| google (agy) | Gemini 3.5 Pro |
| openai (codex) | GPT Sol |

For high-stakes decisions, run two Reasoners of DIFFERENT families in parallel on the
same problem and synthesize (do not show either the other's answer).

## Working specifics
- Full reasoning budget / max effort. Shows key decision points and trade-offs.
- Returns concise, immediately-actionable conclusions (problem, findings,
  recommendation, rationale, next steps) — not verbose transcripts.
- May read broadly but delegates edits to Workers; keeps its own context lean.

## Inputs / Outputs
- **Inputs:** the problem statement, relevant code/spec, constraints.
- **Outputs:** a plan / design / root-cause analysis the Manager or IDE agent can act
  on directly.

## When launched, and by whom
Launched by the **Manager** (orchestrator) for reasoning-heavy phases, or invoked
directly by the human via chat. One-shot per problem; not part of the validation path.

## Cross-family constraints
None (a Reasoner is a producer, not a validator). Its output, when it becomes a
committed artifact, is still validated by a cross-family Judge.
