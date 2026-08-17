# Scale Gating and Workflow Safety Limits

---
status: accepted
---

## Context
Running unconstrained parallel subagent fan-outs on critical architectural changes risks divergence and context decay, while running heavy orchestration skeletons on trivial subtasks introduces unnecessary latency and token overhead.

## Decision
Execution modes are determined deterministically by `scaleGate.js`:
- **Classic**: Single sequential executor; strictly enforced for `L3` criticality (parallel fan-out is refused).
- **Goal Loop**: Autonomous loop active when a deterministic oracle proves completion.
- **Workflow**: Constrained parallel execution bound by fixed safety limits (`max_concurrent_workers: 3`, `max_workers_per_run: 8`, `token_budget: 120,000`).

## Consequences
- Prevents uncontrolled fan-out on high-risk nodes.
- Enforces hard token and worker limits across all specialized workflow profiles.
