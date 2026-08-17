# File-Based Deterministic Gated State Machine

---
status: accepted
---

## Context
Allowing an LLM to autonomously decide when a task or workflow is complete leads to phase skipping, ignored compiler errors, and unverified state decay across continuous execution loops.

## Decision
All task state transitions are governed by a deterministic, non-skippable state machine recorded in `.harness_state.json`. State Gates require explicit, verified evidence (automated checks, independent AI verdicts, or human sign-off) before the next phase or node can be served.

## Consequences
- Guarantees strict adherence to execution stages and eliminates step skipping.
- Tooling and scripts must update and validate `.harness_state.json` at each boundary.
