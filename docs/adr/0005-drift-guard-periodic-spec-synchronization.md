# Periodic Drift-Guard Synchronization

---
status: accepted
---

## Context
In long-running autonomous workflows, passing individual node tests does not guarantee that the cumulative implementation remains aligned with the high-level task goal. Small per-step divergences compound into major architectural drift.

## Decision
Every `sync_interval` closed Tactical Nodes (default 4, range 3–5), the state machine triggers a mandatory `SYNC_DUE` state gate. Execution halts until an independent AI Judge cross-evaluates the cumulative diff against the root Task Master.

## Consequences
- Halts compound drift early and enforces corrective nodes before further execution.
- Introduces periodic verification overhead that protects project integrity.
