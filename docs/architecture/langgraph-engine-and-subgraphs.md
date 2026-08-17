# 🕸️ LangGraph Engine, Subgraphs & Persistence

---

## 1. Архитектура движка на базе LangGraph.js

Harness Protocol использует **LangGraph.js (`@langchain/langgraph`)** в качестве детерминированного исполнительного ядра. Архитектура построена по иерархическому принципу с разделением контекстов на уровне каналов состояния (State Channels).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TaskOrchestratorGraph (thread_id = taskId)                                 │
│                                                                             │
│  [ReadRoadmap] ──► [ScaleGateCheck] ──► [DriftGuardCheck]                   │
│                                                │                            │
│                                                ▼                            │
│                                     [RalphLoopSubgraph]                     │
│                                                │                            │
│                                   (Advance / Loop Complete)                 │
│                                                │                            │
│                                                ▼                            │
│                                      [CheckTaskStatus]                      │
│                                      ┌─────────┴─────────┐                  │
│                                      ▼                   ▼                  │
│                               [NextNode]          [TaskComplete]            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Иерархия StateChannels и аннотаций

1. **`TaskStateAnnotation` (Мета-уровень задачи)**:
   - `taskDir`: string — абсолютный путь к рабочей директории задачи.
   - `roadmap`: object — текущее состояние `.harness_roadmap.json`.
   - `currentNodeIndex`: number — указатель на исполняемый тактический узел.
   - `driftCounter`: number — счетчик закрытых узлов для Drift-Guard синхронизации.
   - `tokenBudget`: number — глобальный лимит токенов задачи.
   - `status`: `'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'CRITICAL_FAIL'`.

2. **`NodeStateAnnotation` (Уровень тактического узла Ralph Loop)**:
   - `nodeId`: string — идентификатор узла (например, `TACT-01`).
   - `iteration`: number — текущий виток итерации.
   - `maxIterations`: number — максимальный лимит итераций до `CRITICAL_FAIL`.
   - `strategy`: string — выбранная стратегия (`chaining`, `routing`, `parallelization`, `orchestrator`, `evaluator_optimizer`, `map_reduce`, `latm`).
   - `context`: object — дайджест ограничений (Форк-2), список инструментов (Форк-4) и критерии DoD.
   - `strategyResult`: object — результат выполнения сабграфа стратегии.
   - `evidence`: object — собранные доказательства (файлы, diffs, логи).
   - `validationResult`: object — вердикт валидатора (`PASS` / `FAIL` / `AWAITING_HUMAN`).
   - `ratchetRules`: array — накопленные правила защиты от регрессий.

3. **`StrategyStateAnnotation` (Уровень плагинов стратегий)**:
   - Изолированное состояние каждого сабграфа стратегии, содержащее промежуточные чанки, сообщения воркеров, артефакты `op_*.json`.

---

## 3. Статическая плагинная архитектура (Strategy Registry)

Каждая из 7 канонических стратегий реализуется как независимый субграф-плагин:

```
Scripts/graph/strategies/
├── strategyRegistry.js     # Центральный статический реестр
├── chaining.js             # Prompt Chaining Subgraph
├── routing.js              # Routing Subgraph
├── parallelization.js      # Parallelization Subgraph
├── orchestrator.js         # Orchestrator-Workers Subgraph
├── evaluatorOptimizer.js   # Evaluator-Optimizer Subgraph
├── mapReduce.js            # Map-Reduce Subgraph
└── latm.js                 # LLMs as Tool Makers Subgraph
```

Каждый плагин экспортирует единый интерфейс:
- `id`: строковый идентификатор стратегии.
- `name`: читаемое имя.
- `tools`: список авторизованных инструментов.
- `createSubgraph(config)`: функция, возвращающая скомпилированный `StateGraph`.

---

## 4. Чекпоинтинг и персистентность (HarnessDiskCheckpointer)

Для обеспечения прозрачности, воспроизводимости и поддержки Time-Travel в Git, чекпоинтер сохраняет снимки состояния на диск:
- **Физический путь чекпоинтов**: `<taskDir>/.harness/checkpoints/<thread_id>/`.
- **Зеркалирование состояния**: при каждой фиксации чекпоинта обновляются `.harness_state.json` и `forks/tactical_ralph_loop.md`.
- **Возобновление**: `graph.invoke(new Command({ resume: payload }), { configurable: { thread_id } })`.
- **Time-Travel Rollback**: команда `node Scripts/harness-orchestrator.js <taskDir> --rollback <checkpointId>` восстанавливает состояние графа и зеркал из указанного снимка.

---

## 5. Иерархический контур эскалации (Hierarchical Escalation Loop)

Когда тактический узел исчерпывает локальные попытки и эскалацию стратегий (1: Chaining -> 2: Evaluator-Optimizer -> 3: LATM), управление передается на уровень родительского графа `TaskOrchestratorGraph`:
1. **Анализ сбоя**: родительский граф фиксирует причину невозможности решения текущим методом.
2. **Decomposition Revision (Рефрейминг задачи)**: родительский узел пересматривает декомпозицию, разбивая проблемный узел на меньшие подзадачи или выбирая альтернативный тактический подход.
3. **Эскалация к Human Gate**: если рефрейминг также не дает решения или исчерпан глобальный бюджет попыток, граф вызывает `interrupt({ type: 'CRITICAL_FAIL' })` для вмешательства человека.

---

## 6. Прерывания и Human-in-the-Loop (Interrupt Handover)

LangGraph `interrupt()` вызывается в строго определенных точках:
1. **`HUMAN_GATE`**: при `validation_type: 'human'` — граф останавливается для одобрения человеком.
2. **`NEEDS_IDE_AGENT`**: при `artifact_kind: 'code'` — автономный движок передает исполнение IDE-агенту (возобновление: `--resume '{"status":"READY_FOR_VALIDATION"}'`).
3. **`NEEDS_SUBAGENT_JUDGE`**: при отсутствии доступных внешних CLI-судей — передача задачи изолированному субагенту-судье.
4. **`CRITICAL_FAIL`**: при исчерпании возможностей рефрейминга и превышении глобальных лимитов.

