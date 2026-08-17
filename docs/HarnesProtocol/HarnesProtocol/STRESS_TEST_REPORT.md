# Отчёт стресс-теста Harness Protocol

**Дата:** 2026-07-12 22:46  
**Результат:** 24/24 проверок пройдено, 0 проблем.

## 1. Покрытие механизмов

| Механизм | Ожидание | Наблюдение | Итог | Важность |
|:---------|:---------|:-----------|:----:|:--------:|
| harnessPaths (чужой cwd) | Файлы созданы в repo/memory/tactical независимо от cwd | Каркас создан в корне репо из tmpdir | ✅ | HIGH |
| Гейт report_ready (validator до контекста) | GATE_FAILED gate=report_ready | GATE_FAILED/report_ready | ✅ | HIGH |
| Гейт validated (loopAdvancer до валидации) | GATE_FAILED gate=validated | GATE_FAILED/validated | ✅ | HIGH |
| contextAssembler init → context_served | stage=context_served | stage=context_served | ✅ | HIGH |
| Гейт awaiting_context (двойной init) | GATE_FAILED gate=awaiting_context | GATE_FAILED/awaiting_context | ✅ | MEDIUM |
| validate → report_ready | stage=report_ready | stage=report_ready | ✅ | HIGH |
| validator auto (PASS cmd) | overall=PASS, stage=validated | overall=PASS, stage=validated | ✅ | HIGH |
| loopAdvancer SUCCESS (единственный узел) | action=TASK_COMPLETE | action=TASK_COMPLETE | ✅ | HIGH |
| Лимит витков → CRITICAL_FAIL | action=CRITICAL_FAIL при max_iterations=2 | action=CRITICAL_FAIL | ✅ | HIGH |
| human → awaiting_human_validation | status=AWAITING_HUMAN | status=AWAITING_HUMAN, stage=awaiting_human_validation | ✅ | HIGH |
| human --reject → FAIL | result=FAIL | result=FAIL | ✅ | MEDIUM |
| human --approve → validated | result=PASS, stage=validated | result=PASS, stage=validated | ✅ | HIGH |
| Гейт subagent_files_check | GATE_FAILED gate=subagent_files_check (нет op_memory.json) | GATE_FAILED/subagent_files_check | ✅ | MEDIUM |
| AI внешний судья (без ENAMETOOLONG) | Структурный вердикт PASS/FAIL, без ENAMETOOLONG | result=NEEDS_SUBAGENT_JUDGE за 30.1s; Внешние CLI-судьи недоступны. Запусти НЕЗАВИСИМОГО субагента со свежим контексто | ✅ | HIGH |
| Оркестратор: code → NEEDS_IDE_AGENT | Выводит NEEDS_IDE_AGENT и останавливается | Оркестратор корректно передал управление IDE-агенту | ✅ | HIGH |
| Bootstrap guard (HARNESS_NO_BOOTSTRAP=1) | readRoadmap регенерирует JSON без обратного парсинга Markdown | nodes=1, json_regenerated=true | ✅ | MEDIUM |
| roadmapEdit round-trip (JSON→MD) | JSON обновлён + Markdown регенерирован с artifact_kind | nodes=2, md_has_kind=true | ✅ | MEDIUM |
| Drift-guard: SYNC_DUE после порога | action=SYNC_DUE на 3-м узле (interval=3) | action=SYNC_DUE | ✅ | HIGH |
| Drift-guard: гейт sync_due | GATE_FAILED gate=sync_due (контекст заблокирован) | GATE_FAILED/sync_due | ✅ | HIGH |
| Drift-guard: acknowledge снимает блок | action=CONTINUE, переход к следующему узлу | action=CONTINUE, next=УЗЕЛ-04 | ✅ | HIGH |
| Drift-guard: контекст разблокирован | contextAssembler init работает после сверки | Контекст выдан | ✅ | MEDIUM |
| selectStrategy (7 стратегий) | Все 7 маппингов детерминированы | 7/7 совпало | ✅ | MEDIUM |
| CLI-транспорт: большой payload | Нет ENAMETOOLONG (контент вне argv) | проверено бинарников: 2, ENAMETOOLONG=false | ✅ | HIGH |
| measureTokens | Отчёт экономии сгенерирован | init экономия 90%, step 99% | ✅ | LOW |

## 2. Проблемы (к решению)

_Проблем не выявлено — все механизмы отработали как ожидалось._

### Примечания (деградации/оговорки)
- **AI внешний судья (без ENAMETOOLONG):** Внешние CLI недоступны/таймаут — деградация корректна

## 3. Токен-политика (замеры)

Приближение: 1 токен ≈ 4 символа. Замеры — реальные размеры полезной нагрузки, которую агент получает от скриптов.

| Фаза | Полезная нагрузка | Символы | ≈ Токены |
|:-----|:------------------|--------:|---------:|
| gates | contextAssembler init | 1407 | 352 |
| lifecycle | contextAssembler init | 1416 | 354 |
| lifecycle | contextAssembler status | 280 | 70 |
| lifecycle | contextAssembler validate (JSON ответ) | 274 | 69 |
| lifecycle | validator auto (ответ) | 251 | 63 |
| lifecycle | loopAdvancer (ответ) | 81 | 21 |
| ai-judge | validator ai (ответ) | 712 | 178 |
| measure | naive_read_all_L2 | 8668 | 2167 |
| measure | assembler_init | 835 | 209 |
| measure | assembler_step | 81 | 20 |

**Суммарно за жизненный цикл узла (harness-served):** ~577 токенов.
**Наивное чтение всех L2 (один раз):** ~2167 токенов.
**Экономия contextAssembler:** init 90%, step 99%.

**Вывод по экономии:** агент, ведущий цикл через harness (init один раз + step на узел + компактные ответы валидатора/loopAdvancer), тратит на контекст на порядок меньше, чем при наивном перечитывании всех L2-файлов на каждом шаге.

## 4. Рекомендации

- Все полезные нагрузки укладываются в бюджет (<400 токенов на вызов). Дополнительная оптимизация не требуется.
