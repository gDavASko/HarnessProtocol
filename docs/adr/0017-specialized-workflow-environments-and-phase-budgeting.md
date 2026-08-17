# Specialized Workflow Environments and Phase Budgeting

---
status: accepted
---

## Context
Complex domain tasks (such as Unity headless compilation, security audits, or large data reductions) have specialized tooling needs, strict concurrency constraints, and high token volatility.

## Decision
Domain-specific execution patterns are defined as declarative Workflow Profiles in `Workflows/profiles/*.json`. Each profile specifies strict worker limits, allowed action whitelists, and Phase Budgeting (allocating separate token ceilings for diagnose, fix, and validation phases).

## Consequences
- Prevents runaway token consumption on complex multi-phase tasks.
- Encapsulates domain-specific compiler and validation rules into reusable profile templates.
