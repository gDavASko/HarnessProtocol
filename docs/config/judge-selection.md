# Judge-Selection Calculus

How the harness decides **which judge(s)** validate a node — or that it must NOT
claim PASS at all. Implemented as a pure, unit-tested function in
`../Scripts/judgeSelector.js`; consumed by `validator.js` / `cli-judge.js` (the F5
integrity wire). Model ids/tiers come from `harness.config.json`.

> **Companion rule:** which judge is only one half of model selection. For *how
> hard each agent thinks* (capability tier × reasoning effort), see
> [reasoning-effort-selection.md](reasoning-effort-selection.md).

## Criticality levels

| Level | Meaning | Decision |
|:------|:--------|:---------|
| **L0** | trivial / predefined code (the change is mechanically determined) | **deterministic oracle only** (compile / test / lint). NO LLM judge is spent. |
| **L1** | standard change | **one medium** judge (cross-family preferred). |
| **L2** | important change | **one strong** judge (cross-family preferred). |
| **L3** | critical / high cost of error | **strong judge + quorum** (2 judges, distinct families preferred), or **dual-order** if only one judge is live. |

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
2. **Prefer cross-family, allow same-family.** Rank judges whose family ≠ `worker_family`
   first, but keep same-family live judges in the pool. A `claude-subagent` is a VALID
   judge for a Claude worker as long as it runs in an isolated fresh-context session —
   independence comes from session isolation, not from family difference.
3. **No judge live at all → `UNVALIDATED`.** Never PASS on an empty judge set. A
   same-family isolated judge is acceptable and does NOT trigger UNVALIDATED.
4. **Optimize** the remaining candidates by `fit(artifact_kind × judge family)` →
   then lower `latency` → then lower `cost` → then stable id.
   - Fit: code favors `openai`, text favors `anthropic`; all families are usable.
5. **Count/tier by criticality:** L1 → 1×medium, L2 → 1×strong, L3 → 2×strong
   (quorum of distinct families); if L3 has only one live cross-family judge, run it
   **dual-order** (two evidence orderings) rather than dropping to UNVALIDATED.

## Decision table (verbatim)

| worker_family | criticality | live judges | result |
|:--------------|:------------|:------------|:-------|
| any | L0 | (any) | `oracle_only` (no LLM judge) |
| any | L1..L3 | none | `UNVALIDATED` (never PASS) |
| anthropic (claude) | L1 | only claude-subagent | judges: **claude-subagent** (isolated same-family fallback, medium) |
| google (agy) | L1 | claude-subagent | judges: **claude-subagent** (single, medium) |
| any | L1 | ≥1 | single best-fit judge, cross-family first (medium) |
| any | L2 | ≥1 | single best-fit judge, cross-family first (strong) |
| any | L3 | ≥2 distinct families | **quorum** of 2 strong judges (distinct families) |
| any | L3 | exactly 1 | 1 strong judge, **dual-order** |

## Self-test
`node ../Scripts/judgeSelector.js` runs an in-file suite proving: L0 → oracle_only;
Claude worker + only claude-subagent live → claude-subagent chosen (isolated same-family
fallback); agy worker + claude-subagent live → claude-subagent chosen; L3 → strong
quorum; L3 single-judge → dual-order.
