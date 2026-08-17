# 🎯 Evaluations, Criticality Policy & Integrity Gate (F5)

---

## 1. Четырехуровневая иерархия верификации

1. **Level 1 (Compile Check):** Детерминированная проверка компиляции (`dotnet build`, Unity assemblies).
2. **Level 2 (Static Lint):** Статический анализ кода на архитектурные инварианты.
3. **Level 2.5 (Qualitative AI Judge):** Семантическая оценка независимым AI-судьей (самопроверка категорически запрещена).
4. **Level 3 (Functional Testing):** Запуск автоматических тестов (Unit, Integration, Play Mode).
5. **Level 4 (Behavioral Validation):** Валидация генерируемых JSON-схем и артефактов.

---

## 2. Шкала критичности (Criticality Policy L0..L3)

- **`L0` (Oracle Only):** Тривиальные задачи. Валидация только детерминированным оракулом; $0$ токенов судей.
- **`L1` (Standard):** Один независимый судья уровня `medium`.
- **`L2` (High Impact):** Один сильный судья уровня `high`.
- **`L3` (System Invariant):** Кворум из двух судей `max`-тира и строго последовательное исполнение.

---

## 3. Drift-Guard и сквозной стресс-тест F5

- **Drift-Guard:** Каждые `sync_interval` (3–5) узлов срабатывает гейт `SYNC_DUE`. Выполнение останавливается до сверки накопленного `git diff` с оригинальным ТЗ задачи (`syncCheck.js`).
- **F5 Integrity Gate:** Автоматический сквозной прогон реальных сценариев (`stress_test.js`), верифицирующий работу блокировок, защиту от пропуска этапов и анти-саботажные инварианты.

### Связанные ADR:
- [[../adr/0001-isolated-ai-judge|ADR-0001: Isolated Context for AI Judge Evaluation]]
- [[../adr/0005-drift-guard-periodic-spec-synchronization|ADR-0005: Periodic Drift-Guard Synchronization]]
- [[../adr/0010-tiered-criticality-and-quorum-verification|ADR-0010: Tiered Criticality and Quorum Verification]]
- [[../adr/0015-f5-integrity-gate-and-stress-testing|ADR-0015: F5 Integrity Gate and Automated Stress Testing]]
