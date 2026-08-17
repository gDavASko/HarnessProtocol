# 🏛️ Harness Protocol — Knowledge Base (Obsidian Hub)

Добро пожаловать в единую базу знаний архитектуры **Harness Protocol**. Вся проектная документация, канонические спецификации, доменная модель и архитектурные решения (ADR) собраны в этом хранилище для удобной навигации в **Obsidian** и в Markdown-редакторах.

---

## 🧭 Карта базы знаний (Map of Content / MOC)

### 1. 📖 Понятийный аппарат и глоссарий
- [[glossary|Глоссарий терминов (Ubiquitous Language)]] — 55 канонических доменных терминов с анти-паттернами (`_Avoid_`).

---

### 2. 🏛️ Архитектурные спецификации (Architecture Specs)
- [[architecture/core-cybernetics|Ядро и кибернетический контур]] — Формула $\text{Agent} = \text{Model} + \text{Harness}$, автомат состояний `.harness_state.json`, Ralph Loop.
- [[architecture/langgraph-engine-and-subgraphs|LangGraph Engine & Subgraphs]] — Иерархический рантайм, State Channels, HarnessDiskCheckpointer, Interrupt Handover.
- [[architecture/strategy-subgraphs-spec|Спецификация субграфов стратегий]] — 7 канонических субграфов, Weapon Manifests, Guarded Phase Routing и матрица эскалации.
- [[architecture/memory-hierarchy|Иерархия памяти и токен-экономика]] — Эшелонирование L1/L2/L3, Data Cooling (Hot/Warm/Cold), Zero-Manual-Read.
- [[architecture/agent-roles-and-effort|Когнитивные роли и шкала усилий]] — 6 канонических ролей, матрица *Capability Tier × Reasoning Effort*.
- [[architecture/workflows-and-strategies|Стратегии исполнения и воркфлоу]] — 7 паттернов ИИ, Scale Gating, лимиты безопасности.
- [[architecture/cli-transport-and-security|CLI-транспорт и безопасность]] — File/Stdin инвариант, preflight-зондирование, секьюрити-политика.
- [[architecture/evaluations-and-integrity|Верификация и целостность (F5)]] — 4 уровня тестирования, шкала критичности L0..L3, кворум судей.

---

### 3. 🤖 Агенты, роли и адаптеры (Agents Ecosystem)
- [[agents/AGENT-DEFINITION-SPEC|Генератор агентских спецификаций]] — Преобразование канонических ролей в файлы IDE.
- **Канонические роли:**
  - [[agents/roles/worker|Worker]] | [[agents/roles/judge|Judge]] | [[agents/roles/evaluator|Evaluator]]
  - [[agents/roles/reasoner|Reasoner]] | [[agents/roles/researcher|Researcher]] | [[agents/roles/manager|Manager]]
- **Адаптеры Claude Code:**
  - [[agents/claude/harness-worker|harness-worker]] | [[agents/claude/harness-judge|harness-judge]] | [[agents/claude/harness-evaluator|harness-evaluator]]
  - [[agents/claude/harness-reasoner|harness-reasoner]] | [[agents/claude/harness-researcher|harness-researcher]] | [[agents/claude/harness-manager|harness-manager]]

---

### 4. 📜 Канонические спецификации (Specs & Regulations)
- [[specs/current-implementation|Current Implementation (v2)]] — Источник истины текущей реализации и карта скриптов.
- [[specs/memory-protocol|Memory Protocol]] — Общая концепция трехуровневой памяти.
- [[specs/operational-memory-spec|L1 Operational Memory Spec]] — Регламент ведения JSON-памяти шага (`op_*.json`).
- [[specs/tactical-memory-spec|L2 Tactical Memory Spec]] — Регламент тактических форков и цикла Ralph Loop.
- [[specs/token-economy|Token Economy]] — Правила сохранения токенов и замеренные показатели.
- [[specs/skill-guide|Skill Guide]] — Руководство по диспетчерскому скилу `davasko-harness-dispatcher`.
- **Подсистемы:**
  - [[specs/Environments/sandbox-spec|Sandbox Spec]] — Регламент изолированной среды и прав доступа.
  - [[specs/Evaluations/evals-spec|Evaluations Spec]] — Спецификация автоматического тестирования и метрик.
  - [[specs/Evaluations/cli-models-config|CLI Models Config]] — Конфигурация запуска CLI-моделей.
  - [[specs/Workflows/agent-process-flow|Agent Process Flow]] — Пошаговый процесс решения задачи.
  - [[specs/Workflows/RalphLoopPrinciples|Ralph Loop Principles]] — Полные принципы контура Ralph Loop.
  - [[specs/Workflows/workflows-map|Workflows Map]] — Карта 7 паттернов работы.

---

### 5. ⚙️ Конфигурация и модели (Configuration)
- [[config/README|Harness Config Guide]] — Руководство по `harness.config.json` и локальным оверрайдам.
- [[config/judge-selection|Judge Selection]] — Логика выбора судей.
- [[config/reasoning-effort-selection|Reasoning Effort Selection]] — Выбор глубины рассуждений модели.

---

### 6. 📊 Отчеты и планы (Reports & Plans)
- [[reports/STRESS_TEST_REPORT|Стресс-тест Harness Protocol]] — Сквозной аудит гейтов и стабильности.
- [[reports/comparative-harness-systems-research|Сравнительное исследование Harness систем]] — Анализ 6 систем (Anthropic, OpenAI, Hermes, OpenHands, SWE-agent, LangGraph) и синтез лучших практик.
- [[plans/implementation_plan|План реализации]] — Базовый план разработки.
- [[wiki/index|L3 Vector Wiki Index]] — Индекс семантической вики.

---

### 7. 📑 Реестр архитектурных решений (ADR Catalog)

| ADR | Название решения | Статус |
| :--- | :--- | :--- |
| [[adr/0001-isolated-ai-judge|ADR-0001]] | Isolated Context for AI Judge Evaluation | Accepted |
| [[adr/0002-deterministic-gated-state-machine|ADR-0002]] | File-Based Deterministic Gated State Machine | Accepted |
| [[adr/0003-tri-tier-memory-hierarchy|ADR-0003]] | Tri-Tier Memory Architecture | Accepted |
| [[adr/0004-l1-disk-contracts-over-chat-context|ADR-0004]] | L1 Disk Contracts over Conversational Chat | Accepted |
| [[adr/0005-drift-guard-periodic-spec-synchronization|ADR-0005]] | Periodic Drift-Guard Synchronization | Accepted |
| [[adr/0006-brain-partitioning-by-artifact-kind|ADR-0006]] | Brain Partitioning by Artifact Kind | Accepted |
| [[adr/0007-strict-triad-of-mandatory-human-gates|ADR-0007]] | Strict Triad of Mandatory Human Gates | Accepted |
| [[adr/0008-scale-gating-and-workflow-limits|ADR-0008]] | Scale Gating and Workflow Safety Limits | Accepted |
| [[adr/0009-preflight-judge-quarantining-and-cross-family-evaluation|ADR-0009]] | Preflight Judge Quarantining and Cross-Family Evaluation | Accepted |
| [[adr/0010-tiered-criticality-and-quorum-verification|ADR-0010]] | Tiered Criticality and Quorum Verification | Accepted |
| [[adr/0011-marker-based-repository-anchor|ADR-0011]] | Marker-Based Repository Anchor | Accepted |
| [[adr/0012-context-assembler-and-token-economy-optimization|ADR-0012]] | Context Assembler and Token Economy Optimization | Accepted |
| [[adr/0013-file-stdin-content-isolation-in-cli-transport|ADR-0013]] | File/Stdin Content Isolation in CLI Transport | Accepted |
| [[adr/0014-deterministic-llm-security-policy-and-binary-whitelisting|ADR-0014]] | Deterministic LLM Security Policy and Binary Whitelisting | Accepted |
| [[adr/0015-f5-integrity-gate-and-stress-testing|ADR-0015]] | F5 Integrity Gate and Automated Stress Testing | Accepted |
| [[adr/0016-model-tournament-and-capability-tiering|ADR-0016]] | Model Tournament and Capability Tiering | Accepted |
| [[adr/0017-specialized-workflow-environments-and-phase-budgeting|ADR-0017]] | Specialized Workflow Environments and Phase Budgeting | Accepted |
| [[adr/0018-task-archiving-and-retention-lifecycle|ADR-0018]] | Task Archiving and Retention Lifecycle | Accepted |
| [[adr/0019-langgraph-stategraph-engine-and-plugin-subgraphs|ADR-0019]] | LangGraph StateGraph Engine and Strategy Subgraph Plugins | Accepted |

