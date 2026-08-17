# Tiered Criticality and Quorum Verification

---
status: accepted
---

## Context
Applying maximum LLM evaluation rigor to trivial tasks wastes budget and time, whereas single-model evaluation on foundational architectural changes risks silent regressions and single-point evaluator failures.

## Decision
Validation rigor is determined dynamically by `judgeSelector.js` according to node criticality:
- **L0 (Trivial)**: Evaluated exclusively by deterministic oracles (compilers, unit tests); 0 LLM tokens spent.
- **L1 (Standard)**: Single medium-tier AI Judge.
- **L2 (High Impact)**: Single high-tier AI Judge.
- **L3 (System Invariant)**: Multi-judge Quorum of two maximum-tier models, combined with mandatory sequential execution (parallel fan-out is refused).

## Consequences
- Optimizes token spend by zero-rating deterministic tasks.
- Enforces consensus-based dual-evaluator verification for high-risk system invariant changes.
