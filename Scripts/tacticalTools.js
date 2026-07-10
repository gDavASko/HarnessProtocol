import fs from 'fs/promises';
import path from 'path';

// Разрешаем путь к оперативной памяти относительно корня запуска (CWD)
// с возможностью переопределения через переменную окружения OP_DIR
const OP_DIR = process.env.OP_DIR || './memory/operational/';

// Вспомогательная функция для безопасного чтения JSON в параллельном режиме
async function readOpFiles() {
    try {
        const files = await fs.readdir(OP_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        const readPromises = jsonFiles.map(async file => {
            try {
                const fullPath = path.join(OP_DIR, file);
                const raw = await fs.readFile(fullPath, 'utf-8');
                // Превентивно удаляем UTF-8 BOM, если он присутствует
                const cleanRaw = raw.replace(/^\uFEFF/, '');
                const data = JSON.parse(cleanRaw);
                return { fileName: file, data };
            } catch (err) {
                console.warn(`[tacticalTools] Предупреждение: Не удалось распарсить JSON из ${file}: ${err.message}`);
                return null;
            }
        });

        const results = await Promise.all(readPromises);
        return results.filter(Boolean);
    } catch (err) {
        // Если папка не найдена, возвращаем пустой список без падения
        return [];
    }
}

/**
 * 1. Получить список файлов/задач с незавершенным статусом
 */
export async function getUnfinishedTasks() {
    const docs = await readOpFiles();
    return docs
        .filter(doc => {
            const hasMarker = doc.data?.result?.marker === 'EndOfDecision';
            const isProgress = doc.data?.result?.status === 'IN_PROGRESS';
            return isProgress || !hasMarker;
        })
        .map(doc => ({
            fileName: doc.fileName,
            task_id: doc.data?.meta?.task_id || 'UNKNOWN',
            agent: doc.data?.meta?.agent_name || 'UNKNOWN',
            last_step: doc.data?.iterations?.length || 0,
            goal: doc.data?.setup?.goal || 'Не указана'
        }));
}

/**
 * 2. Получить список успешно завершенных задач (готовых к переносу)
 */
export async function getCompletedTasks() {
    const docs = await readOpFiles();
    return docs
        .filter(doc => {
            const hasMarker = doc.data?.result?.marker === 'EndOfDecision';
            const isCompleted = doc.data?.result?.status === 'COMPLETED';
            return hasMarker && isCompleted;
        })
        .map(doc => ({
            fileName: doc.fileName,
            task_id: doc.data?.meta?.task_id,
            goal: doc.data?.setup?.goal
        }));
}

/**
 * 3. Саммари хода решения задачи (метрики и инсайты)
 */
export async function getTaskSummary(taskId) {
    const docs = await readOpFiles();
    const doc = docs.find(d => d.data?.meta?.task_id === taskId);
    
    if (!doc) return null;

    const iterations = doc.data?.iterations || [];
    const failedIterations = iterations.filter(i => i.status === 'FAIL');

    return {
        task_id: taskId,
        domain: doc.data?.meta?.domain,
        total_steps: iterations.length,
        failed_steps_count: failedIterations.length,
        errors_encountered: failedIterations.map(i => i.error_type).filter(Boolean),
        insight: doc.data?.result?.tactical_insight || 'Инсайт отсутствует'
    };
}

/**
 * 4. Саммари только результатов (чистые выходные данные)
 */
export async function getPureOutputs() {
    const docs = await readOpFiles();
    return docs
        .filter(doc => doc.data?.result?.marker === 'EndOfDecision')
        .map(doc => ({
            task_id: doc.data?.meta?.task_id,
            status: doc.data?.result?.status,
            output: doc.data?.result?.output_data || {}
        }));
}
