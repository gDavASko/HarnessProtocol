import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';

const execAsync = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Принимаем целевую директорию задачи и опциональную выжимку
const TASK_DIR = process.argv[2] || '.';
const SUMMARY_TEXT = process.argv[3] || 'Сводка не предоставлена (узел завершен).';

const LOG_FILE = 'forks/tactical_work_log.md';
const ARCHIVE_FILE = 'forks/tactical_archive_dump.md';
const UTF8_BOM = '\uFEFF';

async function archiveNodeLog() {
    console.log(`\n=== Архивация активного узла в: ${path.resolve(TASK_DIR)} ===`);
    
    const logPath = path.resolve(TASK_DIR, LOG_FILE);
    const archivePath = path.resolve(TASK_DIR, ARCHIVE_FILE);
    
    let content;
    try {
        content = await fs.readFile(logPath, 'utf-8');
    } catch (e) {
        console.error(`Ошибка: не удалось прочитать ${logPath}`);
        process.exit(1);
    }
    
    const cleanContent = content.replace(/^\uFEFF/, '');
    
    // Якоря для разделения документа
    const completedAnchor = '<!-- ANCHOR: COMPLETED_NODES -->';
    const activeAnchor = '<!-- ANCHOR: ACTIVE_NODE_LOG -->';
    
    if (!cleanContent.includes(completedAnchor) || !cleanContent.includes(activeAnchor)) {
        console.error('Ошибка: не найдены обязательные якоря (COMPLETED_NODES и ACTIVE_NODE_LOG) в файле логов.');
        process.exit(1);
    }
    
    const parts = cleanContent.split(activeAnchor);
    const beforeActive = parts[0];
    const activeContent = parts[1];
    
    // 1. Дописываем данные в холодный архив
    let archiveContent = '';
    try {
        archiveContent = await fs.readFile(archivePath, 'utf-8');
    } catch (e) {
        archiveContent = UTF8_BOM + '# 📦 ГЛУБОКИЙ АРХИВ (Cold Storage)\n\nЭтот файл содержит сырые дампы старых витков по завершенным узлам. Не загружается агентом по умолчанию.\n';
    }
    
    const timestamp = new Date().toISOString();
    const archiveAppend = `\n\n## 🗄️ Архивация от ${timestamp}\n${activeContent}`;
    await fs.writeFile(archivePath, archiveContent + archiveAppend, 'utf-8');
    console.log(`Данные успешно перенесены в ${ARCHIVE_FILE}`);
    
    // 2. Оставляем выжимку в теплом слое
    const summaryBlock = `\n\n### ✅ Завершенный узел (Архивировано ${timestamp})\n* **Итог:** ${SUMMARY_TEXT}\n`;
    const newBeforeActive = beforeActive.trimEnd() + summaryBlock + '\n\n';
    
    // 3. Сбрасываем горячий слой
    const newActiveBlock = `${activeAnchor}\n# 🔄 4.2. ЛОГ ТЕКУЩЕГО УЗЛА (Горячий контекст)\n\n(Ожидание новых витков...)\n`;
    const finalContent = UTF8_BOM + newBeforeActive + newActiveBlock;
    
    await fs.writeFile(logPath, finalContent, 'utf-8');
    console.log(`Файл ${LOG_FILE} успешно очищен и обновлен.`);
    
    // 4. Запускаем реиндексацию
    try {
        const reindexPath = path.join(__dirname, 'reindexTactical.js');
        console.log(`Запуск реиндексации: node "${reindexPath}" "${TASK_DIR}"`);
        const { stdout, stderr } = await execAsync(`node "${reindexPath}" "${TASK_DIR}"`);
        console.log(stdout);
        if (stderr) console.error(stderr);
        console.log('Индексация успешно завершена.');
    } catch (e) {
        console.log('Внимание: не удалось автоматически запустить reindexTactical.js. Запустите его вручную.');
        console.error(e.message);
    }
}

archiveNodeLog().catch(console.error);
