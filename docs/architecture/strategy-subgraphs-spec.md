# 🧩 Strategy Subgraphs & Plugin Specification

---

## 1. Обзор архитектуры плагинов стратегий

Каждая стратегия исполнения в Harness Protocol реализуется как изолированный субграф LangGraph, зарегистрированный в [`StrategyRegistry.js`](file:///e:/Projects/HarnessProtocol/Scripts/graph/strategies/strategyRegistry.js). Субграфы имеют строго разграниченные каналы состояния (StateChannels), объявленный манифест инструментов (Weapon Manifest) и генерируют детерминированные L1 дисковые контракты (`op_*.json`).

---

## 2. Спецификация 7 канонических субграфов

### 1. `chaining` (Prompt Chaining)
- **Назначение**: Последовательное пошаговое выполнение критериев Definition of Done (DoD).
- **Топология графа**:
  `[StepInit]` ──► `[StepWorker]` ──► `[SaveOpMemory]` ──► `[HasMoreSteps?]`
                                                               │ (yes) ──► `[StepWorker]`
                                                               └──► (no) ──► `[CompileResult]`
- **Манифест инструментов**: `read_file`, `write_clean`.
- **Дисковый контракт**: `op_memory.json` (накопленные шаги и контекст).

---

### 2. `routing` (Domain Routing)
- **Назначение**: Классификация задачи по домену (`ui`, `audio`, `logic`, `data`, `vfx`) и вызов специализированного доменного воркера.
- **Топология графа**:
  `[ClassifyDomain]` ──► `[BranchByRoute]` ──► `[DomainWorker]` ──► `[SaveResult]`
- **Манифест инструментов**: `read_file`, `domain_profile_reader`.
- **Дисковый контракт**: `op_route.json` (выбранный домен, reasoning).

---

### 3. `parallelization` (Parallelization & Collator)
- **Назначение**: Параллельная обработка независимых фрагментов DoD изолированными воркерами с последующим слиянием.
- **Топология графа**:
  `[ShardPartition]` ──► `[ParallelWorker_1..N]` ──► `[CollatorNode]` ──► `[SaveResult]`
- **Манифест инструментов**: `read_file`, `shard_reader`.
- **Дисковый контракт**: `shard-*.json` (вывод каждого воркера), `op_collated.json`.

---

### 4. `orchestrator` (Orchestrator-Workers)
- **Назначение**: Динамическая декомпозиция задачи на последовательность зависимых шагов (2–10 шагов) с исполнением специализированными воркерами.
- **Топология графа**:
  `[OrchestratorPlanner]` ──► `[SavePlan]` ──► `[StepWorker]` ──► `[DepsResolver]` ──► `[NextStep?]`
- **Манифест инструментов**: `read_file`, `write_clean`.
- **Дисковый контракт**: `op_plan.json`, `op_step_*.json`.

---

### 5. `evaluator_optimizer` (Evaluator-Optimizer Loop)
- **Назначение**: Итеративный цикл генерации решения и независимой оценки критика до достижения порога качества.
- **Топология графа**:
  `[GeneratorNode]` ──► `[EvaluatorNode]` ──► `[CheckThreshold]`
                              ▲                          │ (needs refinement)
                              └──────────────────────────┴──► `[FeedbackUpdater]`
- **Манифест инструментов**: `read_file`, `write_clean`, `lint_checker`.
- **Дисковый контракт**: `op_feedback_loop.json` (история итераций, замечания критика, правки).

---

### 6. `map_reduce` (Map-Reduce Aggregator)
- **Назначение**: Обработка объемных наборов данных/файлов путем нарезки на чанки, параллельного маппинга и иерархической редукции.
- **Топология графа**:
  `[SplitChunks]` ──► `[MapWorkers_1..N]` ──► `[ReduceAggregator]` ──► `[SaveFinal]`
- **Манифест инструментов**: `read_file`, `chunk_splitter`.
- **Дисковый контракт**: `op_map_data_*.json`, `op_reduce_final.json`.

---

### 7. `latm` (LLMs as Tool Makers)
- **Назначение**: Модель синтезирует специализированный JavaScript/Python скрипт-утилиту, валидирует синтаксис, исполняет в песочнице и собирает результат.
- **Топология графа**:
  `[ToolSynthesizer]` ──► `[SyntaxValidator]` ──► `[SandboxExecutor]` ──► `[ParseOutput]`
                                 │ (syntax error)
                                 └──► `[ToolCorrector]` ──► `[SandboxExecutor]`
- **Манифест инструментов**: `node_sandbox_runner`, `python_sandbox_runner`.
- **Дисковый контракт**: `tools/temp_tool_<id>.js`, `op_tool_output.json`.

---

## 3. Матрица эскалации стратегий (Strategy Escalation)

```
[Попытка 1] Исходная стратегия (напр. Chaining) ──(FAIL)──► [Попытка 2] Evaluator-Optimizer
                                                                      │
                                                                   (FAIL)
                                                                      │
                                                                      ▼
[Попытка 4] Human Gate / Escalation ◄──(FAIL)── [Попытка 3] LATM (Tool Maker)
```
