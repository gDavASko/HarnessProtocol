# Judge-Selection Calculus

How the harness decides **which judge(s)** validate a node — or that it must NOT
claim PASS at all. Implemented as a pure, unit-tested function in
`../Scripts/judgeSelector.js`; consumed by `validator.js` / `cli-judge.js` (the F5
integrity wire). Model ids/tiers come from `harness.config.json`.

## Criticality levels

| Level | Meaning | Decision |
|:------|:--------|:---------|
| **L0** | trivial / predefined code (the change is mechanically determined) | **deterministic oracle only** (compile / test / lint). NO LLM judge is spent. |
| **L1** | standard change | **one medium** cross-family judge. |
| **L2** | important change | **one strong** cross-family judge. |
| **L3** | critical / high cost of error | **strong judge + quorum** (2 distinct-family judges), or **dual-order** if only one cross-family judge is live. |

## Selection function

`selectJudge({ worker_family, artifact_kind, criticality, live_judges })`

**Inputs**
- `worker_family` — family (or bin) of the executor; excluded from the judge set.
- `artifact_kind` — `code` | `text` (drives fit scoring).
- `criticality` — `L0..L3` (or `0..3`).
- `live_judges` — judges proven LIVE by the auth-probe: `[{ id, family, cost?, latency? }]`.

**Output**
`{ decision, judges, tier, mode, reason }` where `decision ∈
{ 'oracle_only', 'judges', 'UNVALIDATED' }`.

## Rules (in order)
1. **L0 → `oracle_only`.** Return immediately; no LLM judge, zero judge tokens.
2. **Exclude the worker family.** Keep only live judges whose family ≠ `worker_family`.
   Because `claude-subagent`'s family is `anthropic`, this single rule makes it a
   VALID judge for `agy`/`codex` workers and an INVALID (same-family) judge for a
   Claude worker.
3. **No valid cross-family judge live → `UNVALIDATED`.** Never PASS on a same-family
   or empty judge set.
4. **Optimize** the remaining candidates by `fit(artifact_kind × judge family)` →
   then lower `latency` → then lower `cost` → then stable id.
   - Fit: code favors `openai`, text favors `anthropic`; all families are usable.
5. **Count/tier by criticality:** L1 → 1×medium, L2 → 1×strong, L3 → 2×strong
   (quorum of distinct families); if L3 has only one live cross-family judge, run it
   **dual-order** (two evidence orderings) rather than dropping to UNVALIDATED.

## Decision table (verbatim)

| worker_family | criticality | live cross-family judges | result |
|:--------------|:------------|:-------------------------|:-------|
| any | L0 | (any) | `oracle_only` (no LLM judge) |
| any | L1..L3 | none | `UNVALIDATED` (never PASS) |
| anthropic (claude) | L1 | only claude-subagent | `UNVALIDATED` (same family) |
| google (agy) | L1 | claude-subagent | judges: **claude-subagent** (single, medium) |
| any | L1 | ≥1 | single best-fit cross-family judge (medium) |
| any | L2 | ≥1 | single best-fit cross-family judge (strong) |
| any | L3 | ≥2 distinct families | **quorum** of 2 strong cross-family judges |
| any | L3 | exactly 1 | 1 strong judge, **dual-order** |

## Self-test
`node ../Scripts/judgeSelector.js` runs an in-file suite proving: L0 → oracle_only;
Claude worker + only claude-subagent live → UNVALIDATED; agy worker + claude-subagent
live → claude-subagent chosen; L3 → strong quorum; L3 single-judge → dual-order.
