# Reasoning-Effort Selection (Harness copy)

Self-contained copy of the canonical **Model & Reasoning-Effort Selection Rule**
for the Harness Protocol. Companion to [judge-selection.md](judge-selection.md):
that file decides *which judge* validates a node; this file decides *how hard each
agent thinks*. Tier→model ids stay in [harness.config.json](../../config/harness.config.json).

> Derived from: Sebastian Raschka, "Controlling Reasoning Effort in LLMs".
> Master copy: `llm-wiki/raw/model-and-reasoning-effort-selection.md`.

---

## Two orthogonal axes — set both, explicitly

| Axis | Question | Governed by |
|:-----|:---------|:------------|
| **Capability tier** | *Which* model? (`cheap → medium → high → max → top`) | `harness.config.json` `agent_roles[*].default_tier` |
| **Reasoning effort** | *How hard* it thinks? (`off → low → medium → high`) | `harness.config.json` `agent_roles[*].reasoning_effort` + this file |

The two dials are decoupled. Pick the cheapest *(tier × effort)* combination that
clears the node's cost of error.

## Core principles

1. Effort is a separate control from capability — decide both.
2. Diminishing returns: do not default to maximum effort.
3. A smaller model at higher effort can match a larger model at lower effort;
   prefer the cheaper combination when it clears the bar.
4. No reliable auto-selection: assign effort explicitly per role/criticality.
5. Mechanical / L0 work runs with reasoning **off**.
6. Hard token budget (`per_role_limits[*].budget_tokens`) is the fail-safe;
   nodes must tolerate a truncated reasoning trace.

## Role / criticality → effort (harness roles)

| Role / criticality | default_tier | reasoning_effort |
|:-------------------|:-------------|:-----------------|
| worker (L0 mechanical / boilerplate) | cheap | **off / low** |
| judge (L1 standard) | medium | **medium** |
| evaluator (L2 important) | high | **high** |
| reasoner (L3 critical / architecture) | max | **high** |
| researcher (investigation) | max | **high** |
| manager / orchestrator (planning, control) | top | **medium** (→ high when decomposing a hard problem) |

Hard rules (extend the Model-Tier Doctrine to the effort axis):
1. NEVER run mechanical work at high effort on a top-tier model.
2. NEVER validate a critical (L3) result with a weak model at low effort.

## Selection procedure

1. Classify the node by criticality (`L0–L3`) and role.
2. Pick `default_tier` from `harness.config.json`.
3. Pick `reasoning_effort` from the table above.
4. Try the cheaper swap (smaller tier + one step higher effort) before committing.
5. Attach the per-role token budget as a fail-safe; confirm graceful truncation.

## How to set effort

1. Native effort dial where the runtime exposes it (IDE subagents: `deep-reasoner`
   = high, `reasoning-architect` = medium, `fast-worker` = low).
2. Otherwise system-prompt conditioning: prepend `Reasoning effort: low | medium |
   high` (or "answer directly, no reasoning" for `off`).
3. Hard `budget_tokens` cap on top, as the inference-time fail-safe.
