# 🌐 Сравнительное исследование архитектур Agent Harness (Comparative Harness Research)

Исследование современных систем управления и выполнения автономных агентов (Agent Harness Systems), анализ их архитектурных решений, сравнительный анализ с **Harness Protocol** и синтез лучших практик для миграции на **LangGraph.js**.

---

## 1. Обзор 6 ведущих систем Agent Harness

### 1. Anthropic Agent Harness (Building Effective Agents / Claude Code)
- **Архитектурный принцип**: «Harness отделен от Модели». Фокус на простых компонуемых паттернах (Prompt Chaining, Routing, Parallelization, Orchestrator-Workers, Evaluator-Optimizer).
- **Ключевые механизмы**:
  - **GAN-Inspired Evaluation**: Строгое разделение Генератора и Оценщика (Evaluator). Самооценка моделью своего кода смещена в сторону завышения («skew positive»). Оценщик работает в изолированном контексте.
  - **Sprint Contracts**: Согласование условий готовности («done-condition») до начала выполнения.
  - **Structured Handoffs vs Compaction**: Отказ от бесконечной суммаризации контекста в пользу периодической очистки и передачи структурированного стейта в чистую сессию.

---

### 2. OpenAI Agents SDK & Swarm Harness
- **Архитектурный принцип**: Production-grade среда выполнения агентов, пришедшая на смену Swarm.
- **Ключевые механизмы**:
  - **Handoffs & Agent Loops**: Явная передача управления между агентами-специалистами с сохранением контекста сессии.
  - **Guardrails Interleaving**: Встроенные входные и выходные фильтры безопасности на каждом шаге цикла.
  - **HALO (Hierarchical Agent Loop Optimization)**: Трассировка выполнения с автоматическим выявлением сбоев самого харнеса и генерацией предложений по улучшению промптов и инструментов.

---

### 3. Nous Research Hermes Agent Harness
- **Архитектурный принцип**: Модель-агностичный автономный цикл долгоживущих агентов с обучением навыкам.
- **Ключевые механизмы**:
  - **Programmatic Tool Calling (`execute_code`)**: Схлопывание десятков последовательных вызовов инструментов в один исполняемый Python/JS скрипт, что экономит контекст и исключает промежуточный шум.
  - **Self-Improving Skill Synthesis**: Анализ успешных траекторий выполнения и автоматический синтез переиспользуемых процедур (Skills) для будущих задач.
  - **Persistent SessionDB**: Хранилище сессий с поддержкой фоновых асинхронных задач (cron) и мультиплатформенных шлюзов.

---

### 4. OpenHands (OpenDevin) Harness
- **Архитектурный принцип**: Событийно-ориентированная архитектура (Event-Stream Architecture) как единый источник истины.
- **Ключевые механизмы**:
  - **Typed Event Stream**: Все мысли, действия (`CmdRunAction`, `FileWriteAction`), наблюдения и ошибки сохраняются как неизменяемый лог типизированных событий.
  - **Decoupled Sandbox Runtime**: Изоляция исполнения в Docker/Kubernetes контейнерах с перехватом небезопасных команд до их выполнения.
  - **Stateful Action-Observation Loop**: Четкий цикл «Принятие решения -> Действие -> Выполнение в песочнице -> Наблюдение -> Обновление стейта».

---

### 5. Princeton SWE-agent & SWE-bench Harness
- **Архитектурный принцип**: Специализированный интерфейс взаимодействия агента с компьютером — **Agent-Computer Interface (ACI)**.
- **Ключевые механизмы**:
  - **Windowed File Viewing & Search Truncation**: Ограничение вывода файлов окном в 100 строк для предотвращения переполнения контекста.
  - **Pre-Execution Syntax Linters**: Проверка синтаксиса сгенерированного кода линтерами до его сохранения на диск.
  - **Fail-to-Pass Verification Gating**: Детерминированная валидация патча на основе тестов, воспроизводящих баг (тест падал до правки и обязан пройти после).

---

### 6. LangGraph Production Agent Harness
- **Архитектурный принцип**: Иерархический циклический граф состояний (StateGraph) с поддержкой Time-Travel и Human-in-the-Loop.
- **Ключевые механизмы**:
  - **State Channels & Reducers**: Строго типизированные каналы с функциями слияния состояния.
  - **Durable Checkpointing**: Чекпоинты на каждом шаге с поддержкой отката (time-travel/replay).
  - **Native Interrupt & Command**: Приостановка графа внутри подграфа с сохранением payload и возобновлением через `Command({ resume })`.

---

## 2. Сравнительная матрица подходов

| Параметр | Anthropic | OpenAI SDK | Hermes | OpenHands | SWE-agent | **Harness Protocol (Текущий)** | **Harness Protocol (LangGraph)** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Управление циклом** | Промпт-цепочки, Evaluator | Runner Loop, Handoffs | Action-Observation Loop | Event-Stream Loop | ACI Bash Loop | Детерминированный Ralph Loop | **Иерархический StateGraph (Guarded Phases)** |
| **Управление памятью** | Structured Handoffs | Session Store | SessionDB, Skills | Typed Event Stream | Чат-история (окна) | 3 уровня (L1/L2/L3), Data Cooling | **State Channels + L2 Markdown Forks + Disk Checkpointer** |
| **Безопасность/Транспорт** | MCP, Sandbox | Guardrails | Sandbox Backends | Security Interleaving | ACI Commands | File/Stdin, Binary Whitelist, Preflight | **Harness Model Adapter + Weapon Manifests + Sandboxing** |
| **Валидация решений** | Изолированный Оценщик | Trace-based Evals | Self-Verification | Test Assertions | Fail-to-Pass тесты | AI Judge, Quorum L3, F5 Integrity | **Quorum Subgraph + Auto Fail-to-Pass + AI Judge Chain** |
| **Восстановление при сбоях** | Retry с фидбеком | HALO | Error Observation | Retry Loop | Linter feedback | Ratchet Principle, No-Skip Law | **Strategy Escalation + Hierarchical Re-framing Loop** |
| **Human-in-the-Loop** | Interactivity | Breakpoints | Gateway Chat | Interactive Webhook | Terminal prompt | Human Gate (3 точки) | **LangGraph `interrupt()` + IDE Handover Protocol** |

---

## 3. В чем Harness Protocol превосходит аналоги
1. **Токен-экономика и Zero-Manual-Read**: Ни один другой фреймворк не компилирует контекст в pointwise-снапшоты с жестким ограничением инсайтов ($\le 200$ симв.) и Data Cooling (Hot/Warm/Cold), снижая расход токенов на 70-80%.
2. **Строгая изоляция CLI-транспорта ([ADR-0013](file:///e:/Projects/HarnessProtocol/docs/adr/0013-file-stdin-content-isolation-in-cli-transport.md))**: Запрет передачи аргументов через командную строку (только stdin/файлы) исключает утечки и обрезания в shell.
3. **Кросс-семейный консилиум судей (Cross-Family Quorum)**: Изолированная оценка моделями другого семейства с детекцией галлюцинаций и preflight-карантином.
4. **Принцип храповика (Ratchet Principle)**: Автоматическая персистентная дистрибуция правил защиты в `AGENTS.md` и `.gemini/rules/` при любой ошибке.

---

## 4. Что мы внедряем и улучшаем при миграции на LangGraph.js

1. **Из SWE-agent**: 
   - **ACI Windowing**: Ограничение вывода просмотрщиков контекста окнами по 100 строк.
   - **Pre-execution Syntax Linter**: Проверка синтаксиса в сабграфе LATM до записи на диск.
2. **Из Hermes Agent**: 
   - **Programmatic Execution (`execute_code`)**: Схлопывание шагов в LATM и Map-Reduce для минимизации лишних тактов LLM.
   - **Skill Synthesis**: Авто-генерация и сохранение навыков из успешно закрытых узлов L3.
3. **Из Anthropic**: 
   - **Sprint Contracts**: Жесткая фиксация DoD и критериев приемки в `Task Master` до входа в сабграфы.
   - **Structured Handoffs**: Полная очистка контекста между тактическими узлами с передачей только типизированного `op_memory.json`.
4. **Из OpenHands**:
   - **Typed Event-Stream в Checkpointer**: Сохранение детального лога событий и переходов состояний в `.harness/checkpoints/` для 100% воспроизводимости.
5. **Из нашего синтеза**:
   - **Иерархический контур рефрейминга (Hierarchical Escalation Loop)**: При исчерпании стратегий узел не падает фатально, а поднимается на уровень `TaskOrchestratorGraph`, который пересматривает декомпозицию задачи!
