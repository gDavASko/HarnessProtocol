# 🔄 Workflows, AI Strategies & Scale Gating

---

## 1. Семь стратегий ИИ (The 7 AI Strategies)

1. **Prompt Chaining:** Последовательная передача промежуточного контекста через `op_memory.json`.
2. **Routing:** Классификация запроса и маршрутизация на профильный скил/промпт через `op_route.json`.
3. **Parallelization:** Параллельная обработка секций задачи изолированными субагентами с объединением результатов.
4. **Orchestrator-Workers:** Динамическая декомпозиция и раздача подзадач воркерам через дисковые контракты.
5. **Map-Reduce:** Иерархическое разделение больших массивов данных (`op_map_data_*.json`) и финальная редукция (`op_reduce_final.json`).
6. **LATM (Tool Maker):** Синтез, валидация и применение специализированной runtime-утилиты под текущую задачу.
7. **Evaluator-Optimizer:** Внутренний цикл генерации и оптимизации через структурированный журнал фидбека `op_feedback_loop.json`.

---

## 2. Scale Gating & Safety Limits

Детерминированный выбор масштабирования через `scaleGate.js`:
- **`classic`**: 1 исполнитель, строго последовательно. Обязателен для узлов критичности **`L3`** (fan-out запрещен).
- **`goal_loop`**: Автономный цикл при наличии детерминированного оракула.
- **`workflow`**: Параллельный запуск при $\ge 3$ независимых частях или наличии профиля (`unity-compile-fix`, `readonly-code-audit`, `safe-migration`, `research-map-reduce`).

### Лимиты безопасности:
- `max_concurrent_workers: 3`
- `max_workers_per_run: 8`
- `token_budget: 120,000`

### Связанные ADR:
- [[../adr/0008-scale-gating-and-workflow-limits|ADR-0008: Scale Gating and Workflow Safety Limits]]
- [[../adr/0017-specialized-workflow-environments-and-phase-budgeting|ADR-0017: Specialized Workflow Environments and Phase Budgeting]]
- [[../adr/0019-langgraph-stategraph-engine-and-plugin-subgraphs|ADR-0019: LangGraph StateGraph Engine and Strategy Subgraph Plugins]]

