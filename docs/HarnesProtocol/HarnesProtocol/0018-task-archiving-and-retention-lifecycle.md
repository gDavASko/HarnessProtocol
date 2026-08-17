# Task Archiving and Retention Lifecycle

---
status: accepted
---

## Context
Accumulating thousands of finished task JSON files and logs in the active operational and tactical memory directories degrades directory scan performance and risks context pollution in new sessions.

## Decision
Task lifecycle completion is sealed with an explicit `"marker": "EndOfDecision"` sentinel. The `archiveTasks.js` and `archiveNodeLog.js` utilities migrate sealed, terminal sessions (`COMPLETED` or `BLOCKED`) into dedicated `archive/` directories and prune hot logs.

## Consequences
- Maintains a clean, high-performance working environment in active memory tiers.
- Preserves full auditability by keeping immutable execution archives in cold storage.
