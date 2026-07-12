# Agent-Definition Generator Spec

A lightweight, near-automatic recipe that turns the **canonical, engine-agnostic
roles** in `roles/*.md` + the tier→model mapping in `../config/harness.config.json`
into **native per-environment agent files**, so different people on different IDEs
configure the *same* six roles the way their tool expects. One source of truth, many
adapters.

> **Golden rule:** the role's purpose/tier/constraints come from `roles/<role>.md`;
> the concrete model id comes from `harness.config.json`. The generator only
> *translates* — it never invents new behavior or new model ids.

---

## Inputs
1. `roles/{worker,judge,evaluator,reasoner,researcher,manager}.md` — canonical roles.
2. `../config/harness.config.json` — `agent_roles` (default tier + families + flags)
   and `available_models` (tier → concrete model id per family).
3. Target adapter (below).

## Role → tier → concrete model id (per vendor)
Derived from `harness.config.json`; shown here for humans. First id is the preferred
model for that tier.

| Role | Tier | anthropic (claude / claude-subagent) | google (agy) | openai (codex) |
|:-----|:-----|:-------------------------------------|:-------------|:---------------|
| worker | cheap | Sonnet 4.6 / Haiku 4.5 · `sonnet` | Gemini 3.5 Flash | GPT-5.6 Luna |
| judge | medium | Opus 4.7 · `opus-4-7` | Gemini 3.1 Pro | GPT-5.6 Terra |
| evaluator | high | Opus 4.7 · `opus-4-7` | Gemini 3.1 Pro | GPT-5.6 Terra |
| reasoner | max | Opus 4.8 · `opus-4-8` | Gemini 3.5 Pro | GPT-5.6 Sol |
| researcher | max | Opus 4.8 · `opus-4-8` | Gemini 3.5 Pro | GPT-5.6 Sol |
| manager | top | Fable 5 / Opus 4.8 · `opus-4-8` | Gemini 3.5 Pro | GPT-5.6 Sol |

Tool scoping (all adapters): **worker** = read+write+run; **judge/evaluator** =
READ-ONLY (Read, Grep, Glob); **reasoner** = read + run (no edits); **researcher** =
read + web; **manager** = full (may launch sub-agents).

---

## Target adapters

### Claude Code (`.claude/agents/<name>.md`)
YAML frontmatter + Markdown system prompt:
```
---
name: harness-<role>
description: <one-line trigger, from role Purpose>
model: <sonnet | opus-4-7 | opus-4-8>
tools: <comma-separated scoped tool list>
---
<thin system prompt: point at roles/<role>.md, restate tier + hard constraints>
```
Emitted reference copies live in `claude/` (this deliverable). To install, copy the
role files you need into the project (or user) `.claude/agents/` directory.

### Codex (`AGENTS.md` role sections / `~/.codex/prompts/<name>.md`)
Codex has no per-agent model frontmatter file the way Claude Code does; encode the
role as a **prompt file** (`prompts/harness-<role>.md`) whose header states the role,
the tier, and the model to pass via `codex exec -m "<model id>"`. Read-only roles are
launched with `-s read-only`; workers with the normal sandbox. The model id comes from
the `codex` column above.

### Gemini Antigravity (agent/workflow config)
Encode each role as an Antigravity agent entry: `name`, `description`, `model`
(the `agy` column above, e.g. `Gemini 3.5 Pro`), and a tool policy (`--sandbox` /
read-only for judge & evaluator). Where Antigravity uses a workflow file, one role =
one workflow step with the role doc pasted as the system instruction.

---

## How to regenerate (recipe)
1. Read `../config/harness.config.json`; for each role take `default_tier` and, per
   target family, `available_models[<family>].variants[<tier>][0]` = the model id.
2. Read `roles/<role>.md`; take Purpose (→ description), tier, and the cross-family /
   read-only constraints.
3. Emit one native file per role using the adapter template above; set `tools`/sandbox
   from the tool-scoping line.
4. Keep the body THIN — do not copy the whole role doc; link to it and restate only
   the tier and the hard constraints.
5. On any model/tier change, edit **only** `harness.config.json` and re-run this
   recipe; never hand-edit model ids across the emitted files.

Emitting is deterministic: same config + same roles ⇒ same files. An AI running this
recipe needs no additional judgement beyond the two lookups in steps 1–2.
