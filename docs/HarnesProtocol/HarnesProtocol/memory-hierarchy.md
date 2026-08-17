# 🧠 Memory Hierarchy & Token Economy

---

## 1. Трехуровневая модель памяти

Память агента в Harness Protocol строго эшелонирована:

1. **L1 (Operational Memory):** Изолированные типизированные JSON-файлы шага (`op_*.json`). Создаются для автономных движков (`artifact_kind=text`) и многоитерационных узлов.
2. **L2 (Tactical Memory):** Тактическая память глобальной задачи, разбитая на 6 форков для защиты от контекстного шума:
   - `tactical_master.md` — Мастер-паспорт и Матрица Навигации.
   - `forks/tactical_ralph_loop.md` (Fork 1) — Односторонняя проекция `.harness_roadmap.json`.
   - `forks/tactical_work_log.md` (Fork 2) — Журнал сессий с разделением на Hot и Warm Storage.
   - `forks/tactical_constraints.md` (Fork 3) — Реестр жестких ограничений и стандартов.
   - `forks/tactical_tools_registry.md` (Fork 4) — Каталог доступных утилит и скилов.
   - `forks/tactical_archive_dump.md` (Fork 5) — Cold Storage (сырой дамп закрытых узлов).
3. **L3 (Vector Wiki):** Постоянная семантическая база знаний репозитория, обновляемая только через модерацию разработчиком.

---

## 2. Data Cooling (Охлаждение данных)

- **Hot Storage:** Последние 5 итераций активного узла.
- **Warm Storage:** Сжатые выжимки закрытых узлов (инсайты $\le 200$ символов).
- **Cold Storage:** Append-only архив сырых логов, исключенный из активного чтения.

---

## 3. Токен-экономика

- **Zero-Manual-Read:** Агент никогда не читает форки вручную через `view_file`. `contextAssembler.js` отдает компактные JSON-снапшоты (экономия 86–99% токенов).
- **Zero-Bookkeeping:** Агент не редактирует Markdown вручную — обновление файлов и матрицы навигации выполняет `loopAdvancer.js`.

### Связанные ADR:
- [[../adr/0003-tri-tier-memory-hierarchy|ADR-0003: Tri-Tier Memory Architecture]]
- [[../adr/0004-l1-disk-contracts-over-chat-context|ADR-0004: L1 Disk Contracts over Conversational Chat]]
- [[../adr/0012-context-assembler-and-token-economy-optimization|ADR-0012: Context Assembler and Token Economy Optimization]]
- [[../adr/0018-task-archiving-and-retention-lifecycle|ADR-0018: Task Archiving and Retention Lifecycle]]
