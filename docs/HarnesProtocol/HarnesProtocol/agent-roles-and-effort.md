# 🤖 Agent Roles & Reasoning Effort

---

## 1. Канонические роли (Canonical Roles)

В системе определены 6 движко-независимых ролей:

1. **Worker:** Исполнитель (код, файлы, команды). Scoping: `read + write + run`.
2. **Judge:** Независимый внешний оценщик. Scoping: `read-only` (Grep, Glob, Read).
3. **Evaluator:** Глубокий аналитический оценщик сложных циклов и высококритичных задач. Scoping: `read-only`.
4. **Reasoner:** Логический решатель сложных архитектурных противоречий. Scoping: `read + run` (без правок кода).
5. **Researcher:** Исследователь первоисточников и документации. Scoping: `read + web`.
6. **Manager:** Оркестратор декомпозиции и управления циклом Ralph Loop. Scoping: `full` (может запускать субагентов).

---

## 2. Двухосевая модель управления моделями

| Ось | Вопрос | Регулируется |
| :--- | :--- | :--- |
| **Capability Tier** | *Какая модель?* (`cheap < medium < high < max < top`) | `harness.config.json` `agent_roles[*].default_tier` |
| **Reasoning Effort** | *Насколько глубоко думать?* (`off < low < medium < high`) | `reasoning_effort` |

### Таблица соответствия:
| Роль / Критичность | Default Tier | Reasoning Effort |
| :--- | :--- | :--- |
| **worker** (L0 механическая работа) | `cheap` | `off / low` |
| **judge** (L1 стандартная валидация) | `medium` | `medium` |
| **evaluator** (L2 важные ревью) | `high` | `high` |
| **reasoner** (L3 системные инварианты) | `max` | `high` |
| **researcher** (исследования) | `max` | `high` |
| **manager** (планирование/контроль) | `top` | `medium` (→ `high` при сложной декомпозиции) |

### Связанные ADR:
- [[../adr/0001-isolated-ai-judge|ADR-0001: Isolated Context for AI Judge Evaluation]]
- [[../adr/0010-tiered-criticality-and-quorum-verification|ADR-0010: Tiered Criticality and Quorum Verification]]
- [[../adr/0016-model-tournament-and-capability-tiering|ADR-0016: Model Tournament and Capability Tiering]]
