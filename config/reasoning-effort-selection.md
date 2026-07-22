# Model & Reasoning-Effort Selection Rule

Canonical rule for choosing **which model** and **how hard it reasons** for any
delegated unit of work (orchestrator turn, subagent, judge, worker). This is the
single source of truth; every model-selecting skill and system carries a
self-contained copy of this file and links to its **local** copy, never to a
shared external path.

> Derived from: Sebastian Raschka, "Controlling Reasoning Effort in LLMs"
> (magazine.sebastianraschka.com/p/controlling-reasoning-effort-in-llms).

---

## 1. Two orthogonal axes — always set both, explicitly

Model selection is **two independent dials**, not one. Set each on purpose for
every delegated task; never let one default silently.

| Axis | Question | Governed by |
|:-----|:---------|:------------|
| **Capability tier** | *Which* model runs the task? (`cheap → medium → high → max → top`) | Model-Tier Doctrine + `HarnessProtocol/config/harness.config.json` |
| **Reasoning effort** | *How hard* does that model think before answering? (`off → low → medium → high`) | This rule |

Capability tier and reasoning effort are decoupled: a top-tier model can run at
low effort, and a mid-tier model can run at high effort. Choosing well means
picking the cheapest *(tier × effort)* combination that clears the task's cost of
error.

---

## 2. Core principles (from the article)

1. **Effort is a separate control from capability.** Treat "which model" and "how
   much it thinks" as two decisions. The article shows effort implemented via
   system-prompt conditioning, SFT mode training, RL token-length penalties, and
   hard inference-time budgets — all independent of model size.
2. **Diminishing returns — do not default to maximum.** Higher effort raises
   accuracy but also cost and latency, with sharply diminishing returns at the
   top. Reserve high effort for high cost-of-error work.
3. **Small-model-high-effort ≈ big-model-low-effort.** A smaller model at higher
   reasoning effort can match a larger model at lower effort. When it is cheaper
   and clears the bar, prefer it.
4. **No reliable auto-selection — specify effort explicitly.** Automatic effort
   selection remains aspirational; models do not reliably infer the right depth.
   Every task class must have an explicitly assigned effort level.
5. **Provide a hard "reasoning off" for mechanical work.** Trivial/predetermined
   work should run with reasoning disabled (empty reasoning), paired with graded
   effort for everything else (toggle = hard switch + soft preference).
6. **Budget as a fail-safe; degrade gracefully.** Apply a hard token/thinking
   budget cap as an inference-time safety net, and ensure the task tolerates a
   truncated reasoning trace without breaking (robustness to externally-imposed
   limits).

---

## 3. Selection procedure

For every delegated unit of work:

1. **Classify** the task by criticality / cost of error (`L0–L3`) and role
   (worker, judge, evaluator, reasoner, researcher, manager, orchestrator).
2. **Pick the capability tier** from the Model-Tier Doctrine (`harness.config.json`
   `agent_roles[*].default_tier`). Never run mechanical work on a top tier;
   never validate a critical result with a weak model.
3. **Pick the reasoning effort** from the table in §4 (the role/criticality → effort
   mapping).
4. **Try the cheaper swap.** Before committing to a big model, check whether a
   smaller tier at one step higher effort clears the same bar for less. Prefer it
   when it does (principle 3).
5. **Cap and protect.** Attach a hard reasoning/token budget as a fail-safe and
   confirm the task degrades gracefully if the trace is truncated (principle 6).

---

## 4. Role / criticality → reasoning-effort mapping

`off` = reasoning disabled (empty thinking). `low/medium/high` = graded effort.

| Role / criticality | Capability tier | Reasoning effort | Rationale |
|:-------------------|:----------------|:-----------------|:----------|
| **L0** trivial / predetermined / mechanical worker / boilerplate / formatting | cheap | **off** (or minimal) | Deterministic; thinking is wasted cost. |
| **L1** standard change / single judge | cheap–medium | **low** | Routine; short reasoning suffices. |
| **L2** important change / evaluator / strong judge | medium–high | **medium** | Real cost of error; needs deliberation. |
| **L3** critical / architecture / algorithm design / reasoner / quorum judge | max | **high** | Highest cost of error; spend depth here. |
| **Orchestrator / manager** (planning, control) | top | **medium** default, **high** when decomposing a hard problem | Steady coordination; escalate on genuinely hard planning. |
| **Researcher** (investigation before implementation) | high–max | **high** | Open-ended search rewards depth. |

Two hard rules carry over from the Model-Tier Doctrine and extend to effort:
1. **NEVER** run mechanical work at high effort on a top-tier model.
2. **NEVER** validate a critical (L3) result with a weak model at low effort.

---

## 5. How to actually set the effort

Pick whichever control the runtime exposes, in this order of preference:

1. **Native effort / thinking-budget dial** (preferred when available). In this
   ecosystem the IDE subagents already encode effort by design:
   - `deep-reasoner` (Opus 4.8) → **high/max** effort — hardest problems.
   - `reasoning-architect` (Opus 4.7) → **medium** effort — standard design, review.
   - `fast-worker` (Sonnet 5) → **low** effort — mechanical execution.
2. **System-prompt conditioning** when there is no native dial: prepend
   `Reasoning effort: low | medium | high` (or an explicit "answer directly, no
   reasoning" for `off`) to the task prompt.
3. **Hard token / thinking budget cap** as the inference-time fail-safe, applied
   on top of (1) or (2). Keep per-role budgets in `harness.config.json`
   (`per_role_limits[*].budget_tokens`) aligned with the effort chosen here.

---

## 6. Where this rule is enforced

- **Model-Tier Doctrine** — `AGENTS.md` (`Reasoning-Effort Doctrine` subsection).
- **Harness Protocol** — `HarnessProtocol/config/reasoning-effort-selection.md`
  (copy), `harness.config.json` (`agent_roles[*].reasoning_effort`), cross-linked
  from `config/judge-selection.md`.
- **Skills that select models** each carry a self-contained copy under their own
  `references/` and describe the principle in `SKILL.md`:
  `kbpro-subagent-team`, `kbpro-mr-reviewer`, `davasko-harness-dispatcher`.

> Concrete model ids stay machine-owned in `harness.config.json`. This rule
> governs the *decision procedure* (tier × effort), not the id mapping.
