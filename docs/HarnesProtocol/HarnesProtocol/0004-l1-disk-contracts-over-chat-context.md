# L1 Disk Contracts over Conversational Chat

---
status: accepted
---

## Context
When multi-agent strategies (such as Orchestrator-Workers or Map-Reduce) exchange messages within an ongoing chat session, conversational noise bloats the context, causes confirmation bias (self-favoring), and prevents deterministic schema validation.

## Decision
All inter-agent communication, subtask assignments, and intermediate results are materialized exclusively as schema-validated JSON files (`op_*.json`) on disk. Validation scripts enforce the physical presence and schema compliance of these files before a node can advance.

## Consequences
- Guarantees verifiable, reproducible execution steps and clean token boundaries.
- Enables pointwise state rollbacks to specific iteration payloads (`iteration_output`).
