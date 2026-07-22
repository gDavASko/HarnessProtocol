import fs from 'fs/promises';
import path from 'path';
import { createInitialRoadmap, writeRoadmap, writeState } from './harnessState.js';
import { tacticalBase, findRepoRoot } from './harnessPaths.js';
import { getModelForRole, loadConfig } from './harnessConfig.js';

// Base tactical L2 L2-memory folder anchored from repo root
const TACTICAL_BASE_DIR = tacticalBase();
const UTF8_BOM = '\ufeff';

/**
 * Searches the codebase and wiki directory for references that match keywords in the title.
 */
async function findReferences(title) {
    const keywords = title.toLowerCase()
        .replace(/[^\w\sа-яё]/gi, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => w.length > 3 && !['тест', 'task', 'stage', 'module', 'задача', 'реализация', 'исправление', 'stage', 'stages', 'компонент', 'component'].includes(w));

    if (keywords.length === 0) return [];

    const discovered = [];
    const searchDirs = [
        { path: 'Assets/Dentistry-cow/Scripts', label: 'code' },
        { path: 'Assets/KBPro/kbpro-ai-docs', label: 'wiki' }
    ];

    const repoRoot = findRepoRoot();

    async function walk(dir) {
        try {
            const entries = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
            for (const entry of entries) {
                const relPath = path.join(dir, entry.name).replace(/\\/g, '/');
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'Library' && entry.name !== 'Temp') {
                        await walk(relPath);
                    }
                } else if (entry.isFile()) {
                    const nameLower = entry.name.toLowerCase();
                    const matches = keywords.filter(kw => nameLower.includes(kw));
                    if (matches.length > 0) {
                        discovered.push({
                            name: entry.name,
                            path: relPath,
                            matches
                        });
                    }
                }
            }
        } catch {
            // Ignore missing directories
        }
    }

    for (const d of searchDirs) {
        await walk(d.path);
    }

    // Return unique files by path, limited to 10
    const seen = new Set();
    const unique = [];
    for (const item of discovered) {
        if (!seen.has(item.path)) {
            seen.add(item.path);
            unique.push(item);
        }
    }
    return unique.slice(0, 10);
}

/**
 * Основная функция инициализации задачи
 * @param {string} taskId - Идентификатор задачи (например, TACT-045)
 * @param {string} title - Название глобальной задачи
 */
async function initializeTask(taskId, title) {
    if (!taskId || !title) {
        console.error(JSON.stringify({ error: "Необходимо передать taskId и title. Пример: node task_initializer.js TACT-045 'Название'" }));
        process.exit(1);
    }

    try {
        // Создаем изолированную директорию конкретной задачи
        const taskDir = path.join(TACTICAL_BASE_DIR, taskId);
        const forksDir = path.join(taskDir, 'forks');

        await fs.mkdir(taskDir, { recursive: true });
        await fs.mkdir(forksDir, { recursive: true });

        // Пути к файлам (фиксированные имена для совместимости с reindexTactical.js)
        const masterPath = path.join(taskDir, 'tactical_master.md');
        const ralphLoopPath = path.join(forksDir, 'tactical_ralph_loop.md');
        const workLogPath = path.join(forksDir, 'tactical_work_log.md');
        const constraintsPath = path.join(forksDir, 'tactical_constraints.md');
        const toolsPath = path.join(forksDir, 'tactical_tools_registry.md');

        const localDate = new Date();
        const dateString = localDate.toLocaleDateString('ru-RU') + ' ' + localDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        // 2. Генерируем контент для Мастер-Документа (с относительными ссылками)
        const masterTemplate = `---
tactical_task_id: ${taskId}
title: ${title}
global_status: PENDING
doc_type: MASTER
---

# 🧭 СКВОЗНАЯ НАВИГАЦИОННАЯ МАТРИЦА (ЯДРО СИСТЕМЫ)
<!-- ЗАГЛУШКА: Будет перезаписано скриптом reindexTactical.js после первого чиха ИИ -->
[Строка 000] -> # 📋 1. ГЛОБАЛЬНЫЙ ПЛАН И ТРЕБОВАНИЯ
[Форк_1 -> Строка 000] -> # 🔄 2. ТЕКУЩИЙ ЦИКЛ RALPH LOOP
[Форк_1 -> Строка 000] -> # 🎯 3. КРИТЕРИИ КАЧЕСТВА (Definition of Done)
[Форк_3 -> Строка 000] -> # ⚠️ 3.1. ЖЕСТКИЕ ОГРАНИЧЕНИЯ И ОКРУЖЕНИЕ (Constraints)
[Форк_4 -> Строка 000] -> # 🛠️ 3.2. БАЗА ПОДСКАЗОК: ИНСТРУМЕНТЫ, СКИЛЫ И MCP (Разрешено расширять)
[Форк_2 -> Строка 000] -> # 📜 4. СКВОЗНОЙ ЛОГ РАБОТЫ (Append-Only)
[Строка 000] -> # 👤 5. ЖУРНАЛ ВМЕШАТЕЛЬСТВА ЧЕЛОВЕКА
[Строка 000] -> # 🏁 6. УСЛОВИЕ ЗАКРЫТИЯ И ФИНАЛЬНЫЙ РЕЗУЛЬТАТ

---

<!-- ANCHOR: GLOBAL_PLAN -->
# 📋 1. ГЛОБАЛЬНЫЙ ПЛАН И ТРЕБОВАНИЯ
*   **Глобальная цель:** ${title}
*   **Связанные форки:**
    1.  **[ФОРК-1: УПРАВЛЕНИЕ ЦИКЛОМ]:** [./forks/tactical_ralph_loop.md](./forks/tactical_ralph_loop.md)
    2.  **[ФОРК-2: ЛОГ РАЗРАБОТКИ]:** [./forks/tactical_work_log.md](./forks/tactical_work_log.md)
    3.  **[ФОРК-3: ОГРАНИЧЕНИЯ И ОКРУЖЕНИЕ]:** [./forks/tactical_constraints.md](./forks/tactical_constraints.md)
    4.  **[ФОРК-4: БАЗА ПОДСКАЗОК И MCP]:** [./forks/tactical_tools_registry.md](./forks/tactical_tools_registry.md)

---

<!-- ANCHOR: HUMAN_INTERVENTION -->
# 👤 5. ЖУРНАЛ ВМЕШАТЕЛЬСТВА ЧЕЛОВЕКА
*   **[${dateString}] | INITIALIZATION:** Задача успешно создана и развернута программным скриптом.

---

<!-- ANCHOR: CLOSURE_CONDITION -->
# 🏁 6. УСЛОВИЕ ЗАКРЫТИЯ И ФИНАЛЬНЫЙ РЕЗУЛЬТАТ
*   **Автоматическая валидация:** \`PENDING\`
*   **Подтверждение разработчика-человека:** \`NOT_SIGNED\`
*   **Ссылки на финальные артефакты:** \`None\`
`;

        // 3. Генерируем контент для Форка-1 (Управление циклом)
        const ralphLoopTemplate = `---
parent_task_id: ${taskId}
fork_type: RALPH_LOOP_MANAGEMENT
updated_at: ${localDate.toISOString()}
---

<!-- ANCHOR: RALPH_LOOP -->
# 🔄 2. ТЕКУЩИЙ ЦИКЛ RALPH LOOP
*   **Текущий шаг роадмапа:** \`Инициализация и декомпозиция\`
*   **Глобальный статус узла:** \`PENDING\`
*   **Выбранная стратегия:** \`None\`
*   **Выделенный оперативный L1-файл:** \`None\`

### 🔄 МЕТРИКИ ТЕКУЩЕГО ЦИКЛА (Loop State)
*   **Номер текущего витка цикла:** \`Виток #0\`
*   **Вектор движения на текущем витке:** Первичный анализ требований и декомпозиция задачи человеком или ИИ-диспетчером.
*   **Последний зафиксированный блокер:** \`None\`
*   **Аварийный выход (Отчет о недостижимости):** Не активирован.

---

<!-- ANCHOR: DEFINITION_OF_DONE -->
# 🎯 3. КРИТЕРИИ КАЧЕСТВА (Definition of Done)
1.  [ ] Задача декомпозирована на понятные узлы.
`;

        // 4. Генерируем контент для Форка-2 (Лог работы)
        const workLogTemplate = `---
parent_task_id: ${taskId}
fork_type: WORK_LOG
updated_at: ${localDate.toISOString()}
---

<!-- ANCHOR: WORK_LOG -->
# 📜 4. СКВОЗНОЙ ЛОГ РАБОТЫ (Append-Only Loop Log)
<!-- Сюда будут последовательно дописываться результаты работы оперативных саб-агентов L1 -->
`;

        // 5. Генерируем контент для Форка-3 (Реестр ограничений)
        const constraintsTemplate = `---
parent_task_id: ${taskId}
fork_type: CONSTRAINTS_REGISTRY
updated_at: ${localDate.toISOString()}
---

<!-- ANCHOR: TACTICAL_CONSTRAINTS -->
# ⚠️ 3.1. ЖЕСТКИЕ ОГРАНИЧЕНИЯ И ОКРУЖЕНИЕ (Constraints)

## 📌 А. ОГРАНИЧЕНИЯ ИЗ УСЛОВИЯ ЗАДАЧИ (Бизнес-рамки)
<!-- Извлекаются субагентом из описания задачи на первом шаге -->
*   **Стиль/Формат вывода:** ESM (import/export), асинхронный код, UTF-8 без BOM для скриптов, UTF-8 с BOM для Markdown и C#.
*   **Архитектурное табу:** Не изменять сторонние или базовые библиотеки без прямого указания.
*   **Лимиты производительности:** Избегать лишних аллокаций.

## 💻 Б. ОГРАНИЧЕНИЯ ОКРУЖЕНИЯ И СКИЛОВ (Технические рамки Harness)
<!-- Считываются автоматически из доступных MCP-инструментов и среды -->
*   **Версия рантайма:** Node.js (поддержка ESM) / Unity C#.
*   **Доступные утилиты окружения (Скилы):** См. реестр доступных навыков во внутреннем wiki.
*   **Ограничение песочницы:** Не выполнять деструктивные команды удаления без согласования.

## 📖 В. ТРЕБОВАНИЯ СИСТЕМНОЙ WIKI (Глобальные стандарты L3)
*   **Навигация (Wiki-ID: NAV-01):** Только относительные markdown ссылки внутри HarnessProtocol.
*   **Стандарты кодировки (Wiki-ID: ENC-01):** C#/Markdown с BOM, JavaScript без BOM.
`;

        // 6. Генерируем контент для Форка-4 (Реестр разрешенных инструментов и скилов)
        const toolsTemplate = `---
parent_task_id: ${taskId}
fork_type: TOOLS_AND_SKILLS_PROMPTS
updated_at: ${localDate.toISOString()}
---

<!-- ANCHOR: TACTICAL_TOOLS -->
# 🛠️ 3.2. БАЗА ПОДСКАЗОК: ИНСТРУМЕНТЫ, СКИЛЫ И MCP (Разрешено расширять)
<!-- ВНИМАНИЕ ИИ: Этот документ — каталог твоих возможностей. Ты МОЖЕШЬ использовать любые другие инструменты рантайма, если они НЕ нарушают жесткий файл ограничений Форк-3. Нашел или синтезировал новый скил — немедленно внеси его в секцию "Д"! -->

## 🧠 А. ДОСТУПНЫЕ СИСТЕМНЫЕ СКИЛЫ (Внутренние навыки агента)
*   **[SKILL]** \`subagent_orchestration\` -> Навык порождения и контроля изолированных воркеров L1.
*   **[SKILL]** \`vector_db_search\` -> Семантический поиск ассоциаций в локальном хранилище опыта.

## 📡 Б. ПРЕДУСТАНОВЛЕННЫЕ MCP-СЕРВЕРЫ (Model Context Protocol)
*   *Список активных MCP-серверов считывается из среды запуска.*

## 🧰 В. ШПАРГАЛКА ПО СКРИПТАМ HARNESS И ОКРУЖЕНИЮ
*   **Автоиндексатор строк:** \`node HarnessProtocol/Scripts/reindexTactical.js\` — Вызывать обязательно после каждой правки L2!
*   **Тест-раннер:** \`npm run test\` — Запуск тестов для проверки текущего узла.
*   **Валидатор стилей:** \`node Assets/KBPro/kbpro-ai-docs/system/scripts/lint-wiki.js\`

## 📖 Г. РЕКОМЕНДУЕМЫЕ ССЫЛКИ И ИСТОЧНИКИ ФАКТОВ
*   **Общий регламент памяти:** [📁 memory-protocol.md](../memory-protocol.md)
*   **Спецификация L2-памяти:** [📁 tactical-memory-spec.md](../tactical-memory-spec.md)

---
## 📈 Д. СКИЛЫ И ИНСТРУМЕНТЫ, ПОДКЛЮЧЕННЫЕ ПО ХОДУ РАБОТЫ (Эволюция опыта)
<!-- Сюда ИИ-диспетчер ОБЯЗАН вносить подсказки по новым навыкам и утилитам, которые были задействованы в цикле Ralph Loop -->
*   *Разделы заполняются динамически по мере прохождения витков цикла.*
`;

        // Находим потенциальные референсы на основе заголовка задачи
        const discoveredRefs = await findReferences(title);
        const referencesPath = path.join(taskDir, 'references.json');
        await fs.writeFile(referencesPath, UTF8_BOM + JSON.stringify({
            title,
            references: discoveredRefs
        }, null, 2), 'utf-8');

        // Записываем все файлы с UTF-8 BOM
        await fs.writeFile(masterPath, UTF8_BOM + masterTemplate, 'utf-8');
        await fs.writeFile(ralphLoopPath, UTF8_BOM + ralphLoopTemplate, 'utf-8');
        await fs.writeFile(workLogPath, UTF8_BOM + workLogTemplate, 'utf-8');
        await fs.writeFile(constraintsPath, UTF8_BOM + constraintsTemplate, 'utf-8');
        await fs.writeFile(toolsPath, UTF8_BOM + toolsTemplate, 'utf-8');

        // Создаем начальный roadmap и state.
        // Phase-2 wiring: read the shared config at init time and stamp the resolved
        // worker (bin/tier/model) onto every node so downstream stages know which
        // model the config elected for this role. Config missing/broken → leave nulls.
        let workerResolved = null;
        try { workerResolved = getModelForRole('worker'); try { loadConfig(); } catch { /* noop */ } } catch { /* noop */ }
        const initialRoadmap = createInitialRoadmap(taskId, title);
        if (workerResolved) {
            for (const node of initialRoadmap.nodes) {
                node.worker_family = node.worker_family || workerResolved.family;
                node.tier = node.tier || workerResolved.tier;
                node.resolved_model = node.resolved_model || workerResolved.model;
                node.resolved_tier = node.resolved_tier || workerResolved.tier;
            }
        }
        await writeRoadmap(taskDir, initialRoadmap, { syncMarkdown: true });
        await writeState(taskDir, {
            stage: 'awaiting_context',
            current_node: 'УЗЕЛ-01',
            last_advanced_at: new Date().toISOString()
        });

        // 7. Выводим результат в формате JSON
        const response = {
            status: "SUCCESS",
            message: `Тактический каркас для задачи ${taskId} успешно развернут.`,
            target_files: {
                master_document: masterPath.replace(/\\/g, '/'),
                fork_ralph_loop: ralphLoopPath.replace(/\\/g, '/'),
                fork_constraints: constraintsPath.replace(/\\/g, '/'),
                fork_tools: toolsPath.replace(/\\/g, '/'),
                fork_work_log: workLogPath.replace(/\\/g, '/')
            },
            mode_gate: 'F4: узлы по умолчанию создаются в дешёвом режиме classic (validation=auto — вердикт выносят тесты/компилятор/линтер, без платного LLM-судьи). Полный harness (LLM-судья, drift-guard, WAL) резервируется для узлов БЕЗ дешёвого оракула: субъективное качество, длинный автономный горизонт, риск дрейфа большого ТЗ, недоверенный воркер. Помечайте такие узлы явно: --validation ai или --mode harness.',
            next_step: `ИИ-Диспетчер должен открыть fork_constraints и fork_tools, ознакомиться с ограничениями и возможностями, провести декомпозицию в fork_ralph_loop, запустить Виток #1 и затем запустить переиндексацию: "node HarnessProtocol/Scripts/reindexTactical.js ${taskDir.replace(/\\/g, '/')}"`
        };

        console.log(JSON.stringify(response, null, 2));

    } catch (error) {
        console.error(JSON.stringify({ status: "ERROR", message: error.message }));
    }
}

// Извлекаем аргументы командной строки: node task_initializer.js TACT-045 "Тест"
const [,, taskId, title] = process.argv;
initializeTask(taskId, title);
