# 🔄 Workflow: Автономное решение задачи (Autonomous Task Resolution)

Спецификация автономного цикла выполнения текстовых, архитектурных и исследовательских задач под управлением LangGraph StateGraph Engine.

---

## 1. Параметры цикла (Loop Parameters)

- **Trigger**: Создание новой задачи через `create-harness-task.js` или запуск `harness-orchestrator.js <taskDir>`.
- **Artifact Kind**: `text` (сценарии, GDD, архитектурные спецификации, документация).
- **Criticality**: `L0`..`L2`.
- **Strategy Selection**: Детерминированный выбор из 7 канонических стратегий.

---

## 2. Пошаговый пайплайн графа (Graph Pipeline)

```
[Trigger: Task Start]
        │
        ▼
[1. Init & Sprint Contract Formalizer] ──► Проверка каждого пункта DoD на верифицируемость
        │
        ▼
[2. Context Assembler with ACI Windowing] ──► Окно 100 строк, pointwise-снапшот
        │
        ▼
[3. Strategy Subgraph Execution] ──► Programmatic Tool Execution (схлопывание тактов)
        │
        ▼
[4. Pre-Commit Syntax & AST Guard] ──► Локальная проверка синтаксиса (0 токенов судей)
        │
        ▼
[5. Assemble Evidence & State Gate] ──► Auto-тест / AI Judge Chain
        │
   ┌────┴────────────────────────┐
   ▼ (PASS)                      ▼ (FAIL)
[6. Advance & Cooling]    [7. Strategy Escalation]
   │                             │ (1: Retry -> 2: Evaluator-Optimizer -> 3: LATM)
   ▼                             └──► При исчерпании: [Hierarchical Re-framing]
[8. Skill Distillation]
   │
   ▼
[Check Next Node or Complete]
```

---

## 3. Checkpoint & Push Right

- **Checkpoint**: Автономный прогон без прерываний для L0..L2. 
- **Push Right**: Человек привлекается только при `CRITICAL_FAIL` (исчерпание всех стратегий и рефрейминга) с готовым decision-ready брифом:
  - Точный отчет сбоя.
  - Журнал эскалаций.
  - Ссылка на артефакты и диффы.
