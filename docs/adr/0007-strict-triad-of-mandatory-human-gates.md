# Strict Triad of Mandatory Human Gates

---
status: accepted
---

## Context
Over-prompting the human for trivial approvals breaks autonomy and causes operator fatigue. Conversely, unrestricted agent execution risks permanent data loss or unauthorized knowledge poisoning.

## Decision
Mandatory Human Gates are strictly restricted to exactly three non-delegable operations:
1. **L3 Wiki Publishing**: Persisting processed documents into the permanent knowledge base.
2. **Git Mutations**: Any non-read-only git operations (commit, push, branch creation).
3. **Escalation**: Unsolvable dead ends (`CRITICAL_FAIL` / Unreachability Report).
All other Tactical Node state transitions proceed through automated or independent AI validation.

## Consequences
- Preserves full execution autonomy for intermediate tactical work.
- Guarantees complete human control over persistent repository artifacts and VCS history.
