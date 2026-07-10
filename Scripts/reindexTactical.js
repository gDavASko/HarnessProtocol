import fs from 'fs/promises';
import path from 'path';
import { resolveTaskDir } from './harnessPaths.js';

// Целевая директория задачи резолвится единым способом (якорь — корень
// репозитория), чтобы реиндексация работала из любого рабочего каталога.
const TASK_DIR = resolveTaskDir(process.argv[2]) || process.cwd();

const MASTER_FILE = 'tactical_master.md';
const RALPH_FILE = 'forks/tactical_ralph_loop.md';
const LOG_FILE = 'forks/tactical_work_log.md';
const CONSTRAINTS_FILE = 'forks/tactical_constraints.md';
const TOOLS_FILE = 'forks/tactical_tools_registry.md';

const UTF8_BOM = '\ufeff';

// Вспомогательная функция для поиска номера строки заголовка по шаблону
async function findHeaderLine(filePath, anchorRegex, fallbackRegex) {
    try {
        const fullPath = path.resolve(TASK_DIR, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        // Очищаем BOM для корректного поиска
        const cleanContent = content.replace(/^\uFEFF/, '');
        const lines = cleanContent.split(/\r?\n/);
        
        // 1. Ищем по комментарию-якорю
        if (anchorRegex) {
            for (let i = 0; i < lines.length; i++) {
                if (anchorRegex.test(lines[i])) {
                    // Ищем ближайший заголовок вниз по тексту, пропуская пустые строки
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim().startsWith('#')) {
                            return j + 1; // 1-indexed
                        }
                        if (lines[j].trim() !== '') {
                            // Если встретили непустую строку (не заголовок) - прерываем поиск
                            break;
                        }
                    }
                    // Если заголовок не найден или текст начался без #, возвращаем строку якоря
                    return i + 1;
                }
            }
        }
        
        // 2. Фоллбэк на текстовое регулярное выражение
        if (fallbackRegex) {
            for (let i = 0; i < lines.length; i++) {
                if (fallbackRegex.test(lines[i])) {
                    return i + 1;
                }
            }
        }
        return null;
    } catch (err) {
        console.warn(`[reindexTactical] Предупреждение при чтении ${filePath}: ${err.message}`);
        return null;
    }
}

async function reindex() {
    console.log(`\n=== Запуск автоиндексатора тактической памяти в: ${path.resolve(TASK_DIR)} ===`);

    // Сканируем строки заголовков с использованием якорей и текстового фоллбэка
    const linePlan = await findHeaderLine(MASTER_FILE, /<!--\s*ANCHOR:\s*GLOBAL_PLAN\s*-->/i, /^#\s+.*1\.\s+ГЛОБАЛЬНЫЙ\s+ПЛАН/i) || 'UNKNOWN';
    const lineRalph = await findHeaderLine(RALPH_FILE, /<!--\s*ANCHOR:\s*RALPH_LOOP\s*-->/i, /^#\s+.*2\.\s+ТЕКУЩИЙ\s+ЦИКЛ/i) || 'UNKNOWN';
    const lineDod = await findHeaderLine(RALPH_FILE, /<!--\s*ANCHOR:\s*DEFINITION_OF_DONE\s*-->/i, /^#\s+.*3\.\s+КРИТЕРИИ\s+КАЧЕСТВА/i) || 'UNKNOWN';
    const lineConstraints = await findHeaderLine(CONSTRAINTS_FILE, /<!--\s*ANCHOR:\s*TACTICAL_CONSTRAINTS\s*-->/i, /^#\s+.*3\.1\.\s+ЖЕСТКИЕ\s+ОГРАНИЧЕНИЯ/i) || 'UNKNOWN';
    const lineTools = await findHeaderLine(TOOLS_FILE, /<!--\s*ANCHOR:\s*TACTICAL_TOOLS\s*-->/i, /^#\s+.*3\.2\.\s+БАЗА\s+ПОДСКАЗОК/i) || 'UNKNOWN';
    const lineLogCompleted = await findHeaderLine(LOG_FILE, /<!--\s*ANCHOR:\s*COMPLETED_NODES\s*-->/i, /^#\s+.*4\.1\.\s+ЗАВЕРШЕННЫЕ\s+ШАГИ/i) || 'UNKNOWN';
    const lineLogActive = await findHeaderLine(LOG_FILE, /<!--\s*ANCHOR:\s*ACTIVE_NODE_LOG\s*-->/i, /^#\s+.*4\.2\.\s+ЛОГ\s+ТЕКУЩЕГО\s+УЗЛА/i) || 'UNKNOWN';
    const lineHuman = await findHeaderLine(MASTER_FILE, /<!--\s*ANCHOR:\s*HUMAN_INTERVENTION\s*-->/i, /^#\s+.*5\.\s+ЖУРНАЛ\s+ВМЕШАТЕЛЬСТВА/i) || 'UNKNOWN';
    const lineClose = await findHeaderLine(MASTER_FILE, /<!--\s*ANCHOR:\s*CLOSURE_CONDITION\s*-->/i, /^#\s+.*6\.\s+УСЛОВИЕ\s+ЗАКРЫТИЯ/i) || 'UNKNOWN';

    // Читаем Мастер-документ для обновления матрицы
    const masterPath = path.resolve(TASK_DIR, MASTER_FILE);
    let masterContent;
    try {
        masterContent = await fs.readFile(masterPath, 'utf-8');
    } catch (err) {
        console.error(`Ошибка: Не найден Мастер-документ по пути ${masterPath}`);
        process.exit(1);
    }

    // Очищаем BOM для работы с текстом
    const cleanMasterContent = masterContent.replace(/^\uFEFF/, '');

    // Генерируем новую навигационную матрицу
    const matrixLines = [
        `# 🧭 СКВОЗНАЯ НАВИГАЦИОННАЯ МАТРИЦА (ЯДРО СИСТЕМЫ)`,
        `[Строка ${String(linePlan).padStart(3, '0')}] -> # 📋 1. ГЛОБАЛЬНЫЙ ПЛАН И ТРЕБОВАНИЯ`,
        `[Форк_1 -> Строка ${String(lineRalph).padStart(3, '0')}] -> # 🔄 2. ТЕКУЩИЙ ЦИКЛ RALPH LOOP`,
        `[Форк_1 -> Строка ${String(lineDod).padStart(3, '0')}] -> # 🎯 3. КРИТЕРИИ КАЧЕСТВА (Definition of Done)`,
        `[Форк_3 -> Строка ${String(lineConstraints).padStart(3, '0')}] -> # ⚠️ 3.1. ЖЕСТКИЕ ОГРАНИЧЕНИЯ И ОКРУЖЕНИЕ (Constraints)`,
        `[Форк_4 -> Строка ${String(lineTools).padStart(3, '0')}] -> # 🛠️ 3.2. БАЗА ПОДСКАЗОК: ИНСТРУМЕНТЫ, СКИЛЫ И MCP (Разрешено расширять)`,
        `[Форк_2 -> Строка ${String(lineLogCompleted).padStart(3, '0')}] -> # 🎯 4.1. ЗАВЕРШЕННЫЕ ШАГИ (Итоги / Warm Storage)`,
        `[Форк_2 -> Строка ${String(lineLogActive).padStart(3, '0')}] -> # 🔄 4.2. ЛОГ ТЕКУЩЕГО УЗЛА (Горячий контекст)`,
        `[Архив -> Строка 000]  -> (СИСТЕМНОЕ: Глубокий дамп tactical_archive_dump.md. Читать при CRITICAL_FAIL)`,
        `[Строка ${String(lineHuman).padStart(3, '0')}] -> # 👤 5. ЖУРНАЛ ВМЕШАТЕЛЬСТВА ЧЕЛОВЕКА`,
        `[Строка ${String(lineClose).padStart(3, '0')}] -> # 🏁 6. УСЛОВИЕ ЗАКРЫТИЯ И ФИНАЛЬНЫЙ РЕЗУЛЬТАТ`
    ];
    const newMatrix = matrixLines.join('\n');

    // Находим старую матрицу и заменяем её (с учетом возможного комментария-якоря и пустых строк перед разделом 1)
    const matrixRegex = /(#\s*🧭\s*СКВОЗНАЯ НАВИГАЦИОННАЯ МАТРИЦА[\s\S]*?)(?=\r?\n(?:<!--[\s\S]*?-->\s*\r?\n)*#\s*(?:📋)?\s*1\.\s+ГЛОБАЛЬНЫЙ)/i;
    
    if (matrixRegex.test(cleanMasterContent)) {
        const updatedContent = cleanMasterContent.replace(matrixRegex, newMatrix + '\n\n');
        
        // Записываем файл обратно с BOM для поддержки Windows/Unity
        try {
            await fs.writeFile(masterPath, UTF8_BOM + updatedContent, 'utf-8');
            console.log(`Матрица навигации в ${MASTER_FILE} успешно обновлена!`);
            console.log(newMatrix);
        } catch (writeErr) {
            console.error(`Ошибка при записи файла ${masterPath}: ${writeErr.message}`);
            process.exit(1);
        }
    } else {
        console.warn(`Предупреждение: Не удалось локализовать блок Сквозной Матрицы в ${MASTER_FILE}. Добавьте разметку согласно регламенту.`);
    }
}

reindex();
