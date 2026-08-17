# Context Assembler and Token Economy Optimization

---
status: accepted
---

## Context
Allowing agents to manually read all L2 Markdown forks and record logs via text tools consumes tens of thousands of tokens per turn, degrades context stability, and causes bookkeeping errors.

## Decision
1. **Zero-Manual-Read**: Agents never inspect raw L2 fork files; `contextAssembler.js` generates tightly compiled JSON snapshots for each mode (`init`: ~800 tokens, `step`: ~500 tokens, `status`: ~300 tokens), achieving 86–99% context savings.
2. **Zero-Bookkeeping**: All status updates, fork synchronizations, and navigation matrix reindexing are handled atomically by `loopAdvancer.js`.
3. **Insight Truncation**: Tactical insights in the work log are strictly capped at $\le 200$ characters.

## Consequences
- Radically reduces token consumption and eliminates context distraction across long-running sessions.
- Requires all agent workflows to interact with L2 tactical memory strictly via context assembler and loop advancer tooling.
