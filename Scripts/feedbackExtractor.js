import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { callLLM } from './llmClient.js';
import { readState, readRoadmap, getCurrentNode, UTF8_BOM } from './harnessState.js';
import { findRepoRoot } from './harnessPaths.js';

const execAsync = promisify(exec);
const MAX_DIFF_CHARS = 100000;

async function getDiff(taskDir, node) {
    try {
        const repoRoot = findRepoRoot();

        // 1. Находим все измененные и untracked файлы
        const { stdout: diffFilesRaw } = await execAsync('git diff HEAD --name-only', { cwd: repoRoot });
        const { stdout: statusRaw } = await execAsync('git status --porcelain', { cwd: repoRoot });

        const changedFiles = new Set(diffFilesRaw.split(/\r?\n/).map(f => f.trim()).filter(Boolean));
        const untrackedFiles = [];

        for (const line of statusRaw.split(/\r?\n/)) {
            if (line.startsWith('?? ')) {
                untrackedFiles.push(line.slice(3).trim());
            }
        }

        // 2. Определяем список deliverables текущего узла
        const deliverables = (node.deliverables || [])
            .map(d => typeof d === 'string' ? d : d.path)
            .filter(Boolean)
            .map(p => path.relative(repoRoot, path.isAbsolute(p) ? p : path.resolve(taskDir, p)).replace(/\\/g, '/'));

        const deliverableSet = new Set(deliverables);

        // Фильтр релевантности: либо из deliverables, либо код/текст/ассеты в Assets/
        function isRelevant(relPath) {
            if (deliverableSet.has(relPath)) return true;
            if (!relPath.startsWith('Assets/')) return false;
            if (relPath.endsWith('.meta')) return false;

            const allowedExts = ['.cs', '.prefab', '.md', '.json', '.txt', '.html', '.css', '.shader', '.uxml', '.uss'];
            const ext = path.extname(relPath).toLowerCase();
            return allowedExts.includes(ext);
        }

        const filesToDiff = [...changedFiles].filter(isRelevant).sort((a, b) => {
            const aIsDel = deliverableSet.has(a);
            const bIsDel = deliverableSet.has(b);
            if (aIsDel && !bIsDel) return -1;
            if (!aIsDel && bIsDel) return 1;
            return a.localeCompare(b);
        });
        const untrackedToInclude = untrackedFiles.filter(isRelevant).sort((a, b) => {
            const aIsDel = deliverableSet.has(a);
            const bIsDel = deliverableSet.has(b);
            if (aIsDel && !bIsDel) return -1;
            if (!aIsDel && bIsDel) return 1;
            return a.localeCompare(b);
        });

        let diffContent = '';
        const FILE_DIFF_LIMIT = 20000;

        // Пофайловый сбор диффов с ограничением
        for (const relPath of filesToDiff) {
            try {
                const { stdout } = await execAsync(`git diff HEAD -- "${relPath}"`, { cwd: repoRoot });
                const fileDiff = stdout.trim();
                if (fileDiff) {
                    if (fileDiff.length > FILE_DIFF_LIMIT) {
                        diffContent += `\n=== DIFF FOR ${relPath} (TRUNCATED) ===\n${fileDiff.slice(0, FILE_DIFF_LIMIT)}\n...[дифф файла превысил лимит ${FILE_DIFF_LIMIT} симв.]\n`;
                    } else {
                        diffContent += `\n=== DIFF FOR ${relPath} ===\n${fileDiff}\n`;
                    }
                }
            } catch {}
        }

        // Сбор содержимого untracked файлов напрямую с диска
        for (const relPath of untrackedToInclude) {
            try {
                const absPath = path.resolve(repoRoot, relPath);
                const fileContent = await fs.readFile(absPath, 'utf-8');
                const truncated = fileContent.length > FILE_DIFF_LIMIT
                    ? fileContent.slice(0, FILE_DIFF_LIMIT) + '\n...[содержимое файла усечено]'
                    : fileContent;
                diffContent += `\n=== NEW UNTRACKED FILE ${relPath} ===\n${truncated}\n`;
            } catch {}
        }

        // Глобальный лимит для защиты контекста
        if (diffContent.length > MAX_DIFF_CHARS) {
            diffContent = `${diffContent.slice(0, MAX_DIFF_CHARS)}\n\n...[ОБЩИЙ ДИФФ УСЕЧЕН ДО ${MAX_DIFF_CHARS} СИМВОЛОВ]`;
        }

        return diffContent.trim();
    } catch (err) {
        return `Не удалось получить git diff: ${err.message}`;
    }
}

async function main() {
    const taskDir = process.argv[2];
    if (!taskDir) {
        console.error('Использование: node feedbackExtractor.js <task_dir>');
        process.exit(1);
    }

    console.log(`🔍 Анализ ручного вмешательства для задачи: ${taskDir}`);
    const roadmap = await readRoadmap(taskDir);
    const node = getCurrentNode(roadmap) || roadmap.nodes[roadmap.nodes.length - 1]; // Берем текущий или последний

    const diff = await getDiff(taskDir, node);
    if (!diff || diff.includes('Не удалось')) {
        console.error('❌ Ошибка: нет доступного diff для анализа.');
        process.exit(1);
    }

    const systemPrompt = `Ты аналитик качества (Feedback Analyzer). 
Агент-исполнитель не справился с задачей, и человек (разработчик) внес ручные правки.
Оцени git diff (разницу между тем, что было/сделал агент, и финальным решением человека).
Сформулируй краткое, жесткое правило для агента, чтобы он больше не совершал эту ошибку.
Верни только текст правила (Markdown формат). Не пиши вводных слов.`;

    const userPrompt = `ЗАДАЧА / ТЕКУЩИЙ УЗЕЛ:
${node.title}

ИСТОРИЯ ОШИБОК АГЕНТА:
${node.last_error || 'Неизвестно'}

ИЗМЕНЕНИЯ ЧЕЛОВЕКА (git diff):
${diff}`;

    console.log(`🤖 Вызов LLM для извлечения урока (The Missing Signal)...`);
    let rule = '';
    try {
        rule = await callLLM('feedback_analyzer', systemPrompt, userPrompt);
    } catch (err) {
        console.error(`❌ Ошибка LLM: ${err.message}`);
        process.exit(1);
    }

    const dateStr = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
    const fileName = `feedback_${node.id}_${dateStr}.md`;
    
    // Поднимаемся до NewData/llm-wiki/skills-feedback/
    // Скрипт лежит в Assets/KBPro/kbpro-ai-docs/HarnessProtocol/Scripts
    // Нам нужно попасть в Assets/KBPro/kbpro-ai-docs/NewData/llm-wiki/skills-feedback/
    const docsRoot = path.resolve(import.meta.dirname || __dirname, '../..');
    const targetDir = path.join(docsRoot, 'NewData', 'llm-wiki', 'skills-feedback');

    await fs.mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, fileName);

    const planContent = `# План инжеста: Урок из ручного вмешательства
    
**Узел:** ${node.id} (${node.title})
**Дата:** ${dateStr}

## Извлеченное правило:
${rule}

---
**ИНСТРУКЦИЯ:**
Этот файл был сгенерирован скриптом \`feedbackExtractor.js\`. 
Он НЕ добавлен в векторную базу знаний автоматически.
Если правило корректно и полезно, переместите его в нужный Skill (SKILL.md) или оставьте здесь и вызовите вручную:
\`node system/scripts/ingest-newdata.js\`
`;

    await fs.writeFile(targetPath, UTF8_BOM + planContent, 'utf-8');

    console.log(`\n✅ Урок успешно извлечен!`);
    console.log(`📄 План инжеста сохранен в: ${targetPath}`);
    console.log(`\n⚠️ ВНИМАНИЕ: Скрипт остановлен. Автоматический инжест отключен по требованию.`);
    console.log(`Пожалуйста, прочитай файл выше. Если согласен — вызови ingest-newdata.js вручную.`);
}

main().catch(err => {
    console.error('Непредвиденная ошибка:', err);
    process.exit(1);
});
