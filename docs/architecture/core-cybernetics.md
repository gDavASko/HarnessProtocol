# ⚙️ Core Cybernetics & State Gating

---

## 1. Кибернетическая формула агента

В традиционных агентских фреймворках модели предоставляется бесконтрольный доступ к файлам и командной строке, что неизбежно ведет к дрейфу контекста, скрытым регрессиям и бесконечным циклам исправления ошибок. 

Harness Protocol разрешает это противоречие разделением системы на две ортогональные компоненты:

$$\text{Agent} = \text{Model} + \text{Harness}$$

- **Model (Вероятностный компонент):** Рассуждения, генерация гипотез, написание кода и планирование.
- **Harness (Детерминированный компонент):** Песочница, строгий автомат состояний, валидаторы, компиляторы и внешние судьи.

---

## 2. Gated State Machine

Продвижение задачи по циклу строго детерминировано и фиксируется в `.harness_state.json`. Перескок состояний невозможен благодаря жестким блокировкам (Deterministic Locks):

```
[awaiting_context] → contextAssembler init|step → [context_served]
                                                       │ (исполнитель делает работу)
                                                       │ contextAssembler validate
                                                       ▼
                                                 [report_ready]
                                                       │ validator auto|ai|human
                                     ┌──────────────────┴───────────────┐
                                     ▼                                  ▼
                               [validated]                 [awaiting_human_validation]
                                     │ loopAdvancer                     │ --approve
                      ┌──────────────┼───────────────┐            [validated]
                      ▼              ▼               ▼
             [awaiting_context]  [SYNC_DUE]     [task_complete]
```

### Связанные ADR:
- [[../adr/0002-deterministic-gated-state-machine|ADR-0002: File-Based Deterministic Gated State Machine]]
- [[../adr/0006-brain-partitioning-by-artifact-kind|ADR-0006: Brain Partitioning by Artifact Kind]]
- [[../adr/0007-strict-triad-of-mandatory-human-gates|ADR-0007: Strict Triad of Mandatory Human Gates]]
- [[../adr/0019-langgraph-stategraph-engine-and-plugin-subgraphs|ADR-0019: LangGraph StateGraph Engine and Strategy Subgraph Plugins]]

