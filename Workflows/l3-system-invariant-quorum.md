# 🏛️ Workflow: Системные инварианты L3 и Кворум судей (L3 Invariant & Quorum)

Спецификация критических архитектурных узлов высшей степени влияния (Criticality `L3`), требующих кворума судей и Human Gate.

---

## 1. Параметры цикла (Loop Parameters)

- **Trigger**: Тактический узел с `criticality: 'L3'`.
- **Ограничения масштабирования**: Только последовательное выполнение (`classic` mode, fan-out запрещен).
- **Верификация**: **Quorum Subgraph** (2 независимых судьи высшего тира из разных семейств) + обязательный **Human Gate**.

---

## 2. Пошаговый пайплайн графа (Graph Pipeline)

```
[Trigger: L3 Tactical Node]
        │
        ▼
[1. Lock Single-Executor Sandbox] ──► Запрет параллельного распараллеливания
        │
        ▼
[2. Execute Deep Strategy] ──► Chaining / Evaluator-Optimizer
        │
        ▼
[3. Pre-Commit Syntax & AST Guard] ──► Проверка целостности AST
        │
        ▼
[4. Quorum Subgraph Execution]
   ├──► Judge A (Tier: Frontier / Family: Anthropic)
   └──► Judge B (Tier: Frontier / Family: OpenAI / Google)
        │
        ▼
[5. Consensus Reconciliation Node]
   ┌────┴────────────────────────┐
   ▼ (Consensus PASS)            ▼ (Disagreement / FAIL)
[6. Prepare Human Brief]      [7. Subagent Escalation / Retry]
        │
        ▼
[8. interrupt({ type: 'HUMAN_GATE' })] ──► Остановка до явного подтверждения
        │
        ▼ (Человек утверждает: --resume '{"approved": true}')
        │
[9. Skill & Pattern Distillation] ──► Синтез нового скилла в .agents/skills/
        │
        ▼
[10. Advance & Sync Drift-Guard]
```

---

## 3. Decision-Ready Brief & Push Right

- **Decision-Ready Brief**:
  - Точный вердикт обоих судей кворума с аргументацией.
  - Сводный diff и измененные файлы.
  - Кнопка/команда одобрения (`--resume '{"approved": true}'`) или отката (`--rollback <checkpointId>`).
- **Push Right**: Кворум судей и все автоматические тесты выполняются *до* Human Gate, человек получает уже согласованное двумя независимыми моделями решение.
