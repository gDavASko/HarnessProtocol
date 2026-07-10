import fs from 'fs/promises';
import path from 'path';

// Направление на оперативную память с возможностью переопределения
const OP_DIR = process.env.OP_DIR || './memory/operational/';
const ARCHIVE_DIR = path.join(OP_DIR, 'archive');

async function archiveTasks() {
    try {
        await fs.mkdir(ARCHIVE_DIR, { recursive: true });
        const files = await fs.readdir(OP_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        let count = 0;

        for (const file of jsonFiles) {
            const filePath = path.join(OP_DIR, file);
            try {
                const raw = await fs.readFile(filePath, 'utf-8');
                const doc = JSON.parse(raw);
                const status = doc.result?.status;
                const hasMarker = doc.result?.marker === 'EndOfDecision';

                // Архивируем только те сессии, которые завершили свое выполнение (успешно или заблокированы)
                if (hasMarker && (status === 'COMPLETED' || status === 'BLOCKED')) {
                    const destPath = path.join(ARCHIVE_DIR, file);
                    await fs.rename(filePath, destPath);
                    console.log(`Архивирован файл: ${file} (Статус: ${status})`);
                    count++;
                }
            } catch (err) {
                console.error(`Ошибка при архивации файла ${file}:`, err.message);
            }
        }
        console.log(`Успешно архивировано задач: ${count}`);
    } catch (err) {
        // Игнорируем ошибку отсутствия исходной папки, если там ничего нет
        if (err.code !== 'ENOENT') {
            console.error("Ошибка при выполнении архивации:", err.message);
        }
    }
}

archiveTasks();
