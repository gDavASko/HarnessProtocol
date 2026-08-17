# Strategy and Workflow Map (Workflows Map)

This document describes the 7 key work-organization patterns for AI agents inside our Harness system. Their default selection is regulated by the deterministic **[Strategy Selection Matrix](RalphLoopPrinciples.md#strategy-selection-matrix-default)** depending on the complexity, atomicity of the task, and the DoD requirements.

> 🔄 **Implementation (v2):** autonomous execution of these strategies (`strategyEngine`)
> applies to nodes with `artifact_kind=text`; `code` nodes are written by the IDE agent
> directly into the working tree ("two brains"). Result validation — by an external AI judge.
> Details —[current-implementation.md](current-implementation.md)).

---

## 1. Prompt Chaining

A linear sequence of steps where the output of the previous step is passed to the next one.

```
[Input] -> [Step 1: Spec analysis] -> [Step 2: Plan generation] -> [Step 3: Writing code] -> [Result]
```

* **When to use:** for well-structured, predictable, repetitive tasks.
* **Example in our project:** the Bitrix24 task import process.
  1. Step 1: analyzing the source text spec and splitting it into logical blocks.
  2. Step 2: converting the blocks into the import JSON format.
  3. Step 3: uploading directly to the Bitrix24 API.

---

## 2. Routing

Classifying the incoming request and dispatching it to a specialized executor (agent or prompt).

```
                    /---> [UI-MVP agent] -> (Window creation)
[Incoming request] --> [Router] ---> [Logic agent] -> (C# systems)
                    \---> [Sound/Animation agent] -> (Audio/DOTween integration)
```

* **When to use:** when tasks differ strongly by domain and a single prompt for all of them would degrade answer quality.
* **Example in our project:**
  When starting a task, our orchestrator determines its type and calls the corresponding skill: `unity-ui-mvp-builder`, `kbpro-module-systems-builder`, or `kbpro-audio-builder`.

---

## 3. Parallelization

Launching several independent agents or prompts in parallel and merging their results afterwards.

```
                      /---> [Allocation-check agent] ---------\
[C# script for review] --> ---> [Async-leak-check agent] ------> [Collator agent] -> [Review]
                      \---> [DI and LazySrv check agent] -----/
```

* **When to use:**
  * **Sectioning:** the task is split into parts processed in parallel.
  * **Voting:** the same task is solved by several agents in parallel to pick the best result by majority vote.
* **Example in our project:** simultaneous review of several C# files before branch merging with different check focuses (allocations in Update, UniTask leaks, DI dependencies).

---

## 4. Orchestrator-Workers

A central controlling agent dynamically decomposes a complex task into subtasks, delegates them to specialized worker agents, and aggregates the result.

```
                    /---> [Worker 1: Code search (grep)] ---\
[Complex task] -> [Orchestrator] <-> [Worker 2: File replacement] ----> [Orchestrator] -> [Result]
                    \---> [Worker 3: Cleanup/Linter] -------/
```

* **When to use:** for complex tasks where the exact step order is unknown in advance and depends on intermediate results.
* **Example in our project:**
  The `kbpro-module-creator` skill acts as the orchestrator. It sequentially calls workers to create the input model (`ModuleInput`), logic systems, MVP UI components, and verifies their build.

---

## 5. Map-Reduce

Hierarchical processing of extremely large volumes of information. The task is split into many independent fragments processed in parallel, after which the results are merged into a single report.

```
                    /---> [Map worker 1 (op_map_data_1.json)] ---\
[Giant log data]                                                 ---> [Reduce collator (op_reduce_final.json)]
                    \---> [Map worker 2 (op_map_data_2.json)] ---/
```

* **When to use:** for extremely large data volumes (logs, the whole project source) that do not fit into one model's context window.
* **Example in our project:** analyzing 100 MB of game crash dumps for a week with automatic error clustering.

---

## 6. LATM / Tool Maker

Splitting the roles into a Tool Maker (writes scripts) and a Tool User (applies them to the task).

```
[Complex routine] -> [Tool Maker] ---> [New script (op_tool_make.json)]
                           ^                     |
                           |-------- (Tests) ----v [Tool User (op_tool_use.json)] ---> [Fork-4 / Registry]
```

* **When to use:** for bulk data-processing tasks or routines that are cheaper and more reliable to solve with a generated automation script rather than LLM calls.
* **Example in our project:** bulk parsing of test logs or auto-generating meta files for prefabs in the Unity project.

---

## 7. Evaluator-Optimizer

An iterative feedback loop where one agent generates a solution and an Evaluator assesses its quality and returns constructive feedback until the criterion is met. The Evaluator is either deterministic software (automatic tests, linters, the compiler) or an **external independent AI judge** (via `cliTransport`); the generating agent itself must never act as its own Evaluator.

```
 [Input] -> [Generator] ---> [Solution] ---> [Evaluator (tests/compiler/external AI judge)]
              ^                                  |
              |----------- (Errors / Feedback) --v (If not passed)
```

* **When to use:** when there are clear, formalizable success criteria (e.g. code compilability, passing tests) — or when an external AI judge can score the result against a strict rubric.
* **Example in our project:** fixing Unity compilation errors. The agent makes changes $\rightarrow$ the build runs $\rightarrow$ compiler errors are returned to the agent for rework until zero errors remain.

---

## 🔄 Relation to the Ralph Loop

All 7 base and advanced strategies above are integrated into a single tactical iteration control system — the **[Ralph Loop](RalphLoopPrinciples.md)**. Strategy selection per task type, the validation regulations, cascading AI-model fallback, and per-step reflection are described in that regulation.

---

## 📋 Step-by-step AI development process (Agent Process Flow)

These strategies are applied strictly within the end-to-end task lifecycle described in the **[Agent Process Flow regulation](agent-process-flow.md)**. That regulation defines 5 key steps:
1. **Step 1: Start and task formulation** (subagent launch, scaling).
2. **Step 2: Task deployment** ("propose & select" interview, specification, L2 forks, "Реализуй план" confirmation).
3. **Step 3: Resolution with the work loop (Ralph Loop)** (iterative strategy selection per node, local verify).
4. **Step 4: Wrap-up** (final build and Human-in-the-Loop control).
5. **Step 5: Decision documentation** (Gotchas in local L2 forks, approval of new global skills).
