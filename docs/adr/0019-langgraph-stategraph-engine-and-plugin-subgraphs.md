# LangGraph StateGraph Engine and Strategy Subgraph Plugins

---
status: accepted
---

## Context
Harness Protocol previously relied on imperative Node.js orchestration scripts (`harness-orchestrator.js`, `loopAdvancer.js`) with hardcoded execution switches. As the system scales to support complex multi-agent workflows, branching strategies, and human/IDE checkpoints, managing deterministic transitions and state pauses via bespoke file polling becomes cumbersome and error-prone.

## Decision
Migrate the core execution engine to **LangGraph.js (`@langchain/langgraph` on Node.js/TypeScript)** with the following architectural invariants:
1. **Hierarchical StateGraph**: The top-level `TaskOrchestratorGraph` manages task-level progression (Roadmap, Drift-Guard, Scale Gating), delegating node execution to a `RalphLoopSubgraph`.
2. **Strategy Subgraph Plugin Architecture**: The 7 canonical strategies (and future custom strategies) are implemented as self-contained sub-graph plugins registered in a `StrategyPluginRegistry`, exposing isolated StateChannels and weapon/tool bindings.
3. **HarnessDiskCheckpointer**: LangGraph checkpoints are saved to `.harness/checkpoints/` on disk, automatically mirror-updating `.harness_state.json` and L2 Markdown forks (`tactical_ralph_loop.md`) to preserve the Zero-Bookkeeping and Zero-Manual-Read principles.
4. **Harness Model Adapter**: Models are invoked through a configurable adapter over `llmClient.js` / `cliTransport.js`, preserving model tier tournaments, binary whitelisting, and the Model Fallback Protocol.
5. **Interrupt Handover**: Human Gates, IDE Agent handoffs (`artifact_kind: 'code'`), and subagent judge fallbacks are managed deterministically via LangGraph `interrupt()`, resuming with `Command({ resume: payload })`.

## Consequences
- Full formal verification of cyclic and branching execution flows through LangGraph state graphs.
- Pluggable extension model for adding new execution strategies and toolsets without modifying core engine logic.
- Clean pause/resume lifecycle across IDE, CLI, and Human boundaries without breaking git-tracked state transparency.
