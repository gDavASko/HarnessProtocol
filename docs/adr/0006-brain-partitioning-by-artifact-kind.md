# Brain Partitioning by Artifact Kind

---
status: accepted
---

## Context
Code changes require direct workspace manipulation, compiler checks, and repository tool access, while text generation and research require multi-agent reasoning strategies writing structured blobs.

## Decision
Execution is partitioned by `artifact_kind`:
1. `code` Nodes: Executed exclusively by the interactive IDE agent directly within the workspace tree; evidence is strictly `git diff HEAD`.
2. `text` Nodes: Executed autonomously by the `strategyEngine` script; evidence consists of deliverable files and `op_*.json` payloads.

## Consequences
- Prevents autonomous strategy scripts from making unverified direct edits to source code files.
- Ensures distinct, appropriate validation pipelines for code vs document deliverables.
