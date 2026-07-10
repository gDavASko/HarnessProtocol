#!/usr/bin/env node

/**
 * Harness Task Scaffolding Script
 * Автоматически генерирует L2-структуру памяти (5 файлов) для новой тактической задачи.
 * Использование: node create-harness-task.js <TaskName> [--desc "Описание задачи"]
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) {
    console.error("❌ Ошибка: Имя задачи не указано.");
    console.error("Использование: node create-harness-task.js <TaskName> [--desc \"Описание задачи\"]");
    process.exit(1);
}

const taskName = args[0];
let taskDesc = "Без описания. Уточните цель задачи.";

const descIndex = args.indexOf('--desc');
if (descIndex !== -1 && args[descIndex + 1]) {
    taskDesc = args[descIndex + 1];
}

const targetDir = path.resolve(process.cwd(), taskName);
const forksDir = path.join(targetDir, 'forks');

if (fs.existsSync(targetDir)) {
    console.error(`❌ Ошибка: Директория '${taskName}' уже существует.`);
    process.exit(1);
}

// 1. Создание директорий
fs.mkdirSync(targetDir, { recursive: true });
fs.mkdirSync(forksDir, { recursive: true });

// 2. Шаблоны файлов
const masterTemplate = `---
tactical_task_id: ${taskName}
global_status: PENDING
---
# 📋 1. ГЛОБАЛЬНЫЙ ПЛАН И ТРЕБОВАНИЯ
**Глобальная цель:** ${taskDesc}
**Специфика:** 

## ДОПОЛНИТЕЛЬНЫЕ ДАННЫЕ ОТ ПОЛЬЗОВАТЕЛЯ
- 
`;

const loopTemplate = `### УЗЕЛ-01: Начало задачи
*   **Статус узла:** \`PENDING\`
*   **Виток #0**
*   **Стратегия:** \`Worker\`
*   **validation_type:** \`ai\`
> ⚖️ **ВНИМАНИЕ: ПЕРЕКРЕСТНАЯ ВАЛИДАЦИЯ!** Ты имеешь право проверять себя сам, НО обязан
> запустить параллельную валидацию другим ИИ.
> **Перед завершением узла выполни команду:**
> \`node Assets/KBPro/kbpro-ai-docs/HarnessProtocol/Scripts/cli-judge.js --file L2/tactical_work_log.md\`
> Проанализируй чужой вывод, сопоставь со своим, и только после этого закрывай узел!

- [ ] Шаг 1
- [ ] Шаг 2
`;

const constraintsTemplate = `* **Архитектура:** KBPro Component/LogicSystem
* **Запреты:** GameObject.Find, Coroutine (использовать UniTask), LINQ в Update
`;

const toolsTemplate = `* **[TOOL]** \`view_file\`
* **[TOOL]** \`write_to_file\`
* **[TOOL]** \`replace_file_content\`
`;

const logTemplate = `## Журнал операций (Work Log)\n\n### Виток #0\n* Инициализация задачи.\n`;

// 3. Запись файлов
try {
    fs.writeFileSync(path.join(targetDir, 'tactical_master.md'), masterTemplate, 'utf8');
    fs.writeFileSync(path.join(forksDir, 'tactical_ralph_loop.md'), loopTemplate, 'utf8');
    fs.writeFileSync(path.join(forksDir, 'tactical_constraints.md'), constraintsTemplate, 'utf8');
    fs.writeFileSync(path.join(forksDir, 'tactical_tools_registry.md'), toolsTemplate, 'utf8');
    fs.writeFileSync(path.join(forksDir, 'tactical_work_log.md'), logTemplate, 'utf8');

    console.log(`✅ Задача '${taskName}' успешно развернута.`);
    console.log(`📁 Путь: ${targetDir}`);
    console.log(`Файлы сгенерированы:
  - tactical_master.md
  - forks/tactical_ralph_loop.md
  - forks/tactical_constraints.md
  - forks/tactical_tools_registry.md
  - forks/tactical_work_log.md`);
} catch (e) {
    console.error("❌ Ошибка при создании файлов:", e);
    process.exit(1);
}
