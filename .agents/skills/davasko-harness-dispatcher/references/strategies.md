# The 7 Strategies and the "Two Brains"

## Two brains — by the node's `artifact_kind` (WS-5)

Who executes a node depends on its artifact type:

| `artifact_kind` | Executor | What the `ai` judge validates | Autonomous engine |
|:----------------|:---------|:------------------------------|:------------------|
| `code` | **IDE agent** (writes into the working tree) | `git diff HEAD` | skips the node (`NEEDS_IDE_AGENT`) |
| `text` | autonomous `strategyEngine` / `harness-orchestrator.js` | deliverables content | executes |

Reason: strategy executors write results into `op_*.json` blobs, not into the
working tree. So real code is always written by the IDE agent, and the autonomous
engine takes only text artifacts (scenarios/GDDs/texts).

---

## Deterministic auto-selection (`selectStrategy`)

Pure logic without an LLM. If a strategy is set explicitly on the node (`!= None`) — it wins
(Override). Otherwise — by task metrics:

| Strategy | Auto-selection | I/O files (L1) |
|:---------|:---------------|:---------------|
| Prompt Chaining | ≤2 DoD, a linear task without special signs | `op_memory.json` |
| Routing | ≤2 DoD, mixed domains (UI+Audio, VFX+Logic…) | `op_route.json`, `op_worker_task_{route}.json`, `op_worker_result_{route}.json` |
| Parallelization | >2 DoD, independent criteria | `op_task_part_{N}.json`, `op_result_part_{N}.json`, `op_memory.json` |
| Orchestrator-Workers | >2 DoD, dependent steps ("after", "based on", "then") | `op_memory.json`, `op_worker_task_{ID}.json`, `op_worker_result_{ID}.json` |
| Map-Reduce | >2 DoD, massive data ("refactoring", "all files", "bulk") | `op_map_data_{M}.json`, `op_reduce_final.json`, `op_memory.json` |
| LATM / Tool Maker | ≤2 DoD, a new script/utility is needed ("script", "parsing", "generat") | `op_tool_make.json`, `op_tool_use.json` |
| Evaluator-Optimizer | ≤2 DoD, autotests exist (npm test, dotnet build, lint) | `op_feedback_loop.json`, `op_memory.json` |

---

## Cascading LLM Fallback (`callLLMWithFallback`)

Applies to autonomous `text` nodes:

1. The role's primary model (from `llm-config.json`, tier per `strategy_role_tiers`).
2. On rate-limit/timeout → alternatives of the same tier.
3. Tier exhausted → cascade (`frontier → advanced → medium → light`).
4. Free models are prioritized with `prefer_free: true`.
5. HTTP API is tried before CLI.

For the external judge (`ai` validation) a separate CLI binary chain
`cli_transport.judge_chain` applies — see [memory-and-validation.md](memory-and-validation.md).
