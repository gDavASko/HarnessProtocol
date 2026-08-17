# 💻 Workflow: Кодовые узлы и передача в IDE (Code Modification & IDE Handover)

Спецификация гибридного цикла («Два мозга») для тактических узлов с `artifact_kind: 'code'`.

---

## 1. Параметры цикла (Loop Parameters)

- **Trigger**: Переход к тактическому узлу с `artifact_kind: 'code'`.
- **Исполнитель**: IDE-агент (в рабочей директории с полными правами редактирования кода).
- **Валидатор**: Автономный компилятор + AI Judge / Human Gate.

---

## 2. Пошаговый пайплайн графа (Graph Pipeline)

```
[Trigger: Node with artifact_kind == 'code']
        │
        ▼
[1. Sprint Contract Formalizer] ──► Проверка DoD (наличие unit-тестов, ожидаемый diff)
        │
        ▼
[2. Compile IDE Context Brief] ──► Сборка контекста и ограничений (Fences)
        │
        ▼
[3. LangGraph interrupt({ type: 'NEEDS_IDE_AGENT' })] ──► Пауза автономного движка
        │
        ▼ (IDE-агент пишет код в рабочем дереве)
        │
[4. Resume Command via CLI] ──► node harness-orchestrator.js <taskDir> --resume
        │
        ▼
[5. Pre-Commit Syntax & AST Guard] ──► Проверка синтаксиса файлов из git diff
        │
        ▼
[6. Automated Test Runner / Compiler] ──► npm test / dotnet build / unity compile
        │
   ┌────┴────────────────────────┐
   ▼ (PASS)                      ▼ (FAIL)
[7. Advance Node & Ratchet]   [8. IDE Agent Retry with Failure Insight]
```

---

## 3. Decision-Ready Brief & Push Right

- **Brief для IDE-агента**:
  - Четкий список файлов для изменения.
  - Ограничения (Fences) и требования архитектуры.
  - Машиночитаемые критерии Definition of Done.
- **Push Right**: Автономный запуск юнит-тестов и синтаксического контроля перед тем, как решение попадет на финальное утверждение.
