# 📝 User Environment & Workflow Notes (NOTES.md)

---

## 1. Инструменты и Среда
- **IDE**: Antigravity IDE (Pair programming environment on Windows).
- **Core Runtime**: Node.js (ESM), LangGraph.js (`@langchain/langgraph`, `@langchain/core`).
- **CLI Транспорт**: Claude CLI, OpenAI Codex CLI, Google Antigravity (`agy`), локальные Node.js скрипты.
- **Управление репозиторием**: Git, PowerShell, локальная файловая система.

---

## 2. Канонический вокабуляр и терминология (Ubiquitous Language)
- **Harness**: Детерминированный управляющий каркас (песочница, гейты, валидация).
- **Model**: Вероятностный ИИ-движок рассуждений и генерации.
- **Task**: Высокоуровневая цель, декомпозированная на Tactical Nodes.
- **Tactical Node**: Атомарный шаг с назначенной стратегией, Artifact Kind и Criticality.
- **Ralph Loop**: Итеративный кибернетический контур с инвариантом "No-Skip".
- **Sprint Contract**: Машиночитаемая формализация Definition of Done (DoD) до начала исполнения.
- **Pre-Commit Syntax Guard**: Локальная проверка AST/синтаксиса за 5 мс до отправки судьям.
- **Programmatic Tool Calling**: Схлопывание 10 вызовов в 1 скрипт (`execute_code`) для экономии контекста.
- **ACI Windowing**: Ограничение просмотра файлов окнами по 100 строк.
- **Skill Distillation**: Автоматический синтез переиспользуемых навыков из успешных решений L3-узлов.
- **Typed Event-Stream**: Неизменяемый лог событий и переходов в чекпоинтере.
- **Final Acceptance Stress-Gate (ADR 0020)**: Полный запрет на закрытие задачи по коду выхода автотестов без независимого стресс-теста ИИ и ремедиации.
- **Dynamic Node Decomposition & Adaptive Fracturing (ADR 0021)**: Динамическое дробление крупных узлов в рантайме на атомарные под-узлы при высокой сложности, многомерном DoD или обнаружении скрытых дефектов.
- **Push Right**: Выполнение максимального объема работы до обращения к человеку (Human Gate вызывается только в конце, с готовым decision-ready брифом).
