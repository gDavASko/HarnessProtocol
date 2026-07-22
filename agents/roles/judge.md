# Role: Judge

> Engine-agnostic canonical role. Concrete per-IDE agent files are generated from
> this doc via `agents/AGENT-DEFINITION-SPEC.md`. Model ids live in
> `config/harness.config.json`.

## Purpose
Independent PASS/FAIL verdict on another agent's artifact against the node's DoD.
The Judge is the enforcement point of the universal cross-validation rule: an agent
NEVER validates its own output. A Judge returns strict JSON `{pass, dod_results,
evidence, errors}` and must cite verbatim evidence for any PASS.

## Tier
`medium`, escalated by criticality. A trivial predefined node needs no LLM Judge at
all (a deterministic oracle decides — see `judge-selection.md`, L0). As the cost of
error rises the Judge tier is raised toward `strong` (L2/L3). Never validate a
critical result with a weak Judge (hard rule 2).

## Model options (locally available families)
| Family | medium (default) | strong (L2/L3) |
|:-------|:-----------------|:---------------|
| anthropic (claude / claude-subagent) | Opus 4.7 | Opus 4.8 |
| google (agy) | Gemini Flash/Pro | Gemini 3.5 Pro |
| openai (codex) | GPT Luna/Terra | GPT Sol |

The live judge pool is decided at runtime by the `aiProbe` authentication probe;
`judgeSelector.js` picks the concrete Judge from the pool.

## Working specifics
- **Read-only.** Judge CLIs never use write/skip-permission flags
  (claude → `--allowedTools Read Grep Glob`; agy → `--sandbox`; codex → `-s read-only`).
- Stateless — never reuses a worker session.
- Receives trimmed context: DoD + changed section / evidence (git diff for code,
  deliverables for text), NOT the full transcript.
- A bare PASS with no `evidence` quote is rejected and downgraded to FAIL.

## Inputs / Outputs
- **Inputs:** DoD, evidence bundle, worker_family, criticality.
- **Outputs:** strict JSON verdict `{pass, dod_results, evidence, errors}`.

## When launched, and by whom
Launched by `validator.js --type ai` (via `cliTransport`) or, when no external CLI
judge is live, as an INDEPENDENT fresh-context IDE subagent (`--judge-file` fallback).
Selection is delegated to `judgeSelector.js`.

## Isolation constraints (MANDATORY)
- A Judge MUST run in an INDEPENDENT, fresh-context session — never the Worker's own
  session. Independence comes from session isolation, not from model family.
- The SAME model family is allowed: a **claude-subagent** is a VALID Judge for a Claude
  Worker as long as it is a separate isolated subagent. Cross-family is PREFERRED (the
  selector ranks it first) but not mandatory.
- If NO independent Judge is live at all, the node is `UNVALIDATED` — never PASS.
