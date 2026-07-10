import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { callExternalJudge } from './cliTransport.js';
import { getAvailableJudgeChain, probeSummary } from './aiProbe.js';
import { findRepoRoot } from './harnessPaths.js';
import {
    UTF8_BOM,
    getNode,
    normalizeNodeId,
    readClean,
    readRoadmap,
    readState,
    writeRoadmap,
    writeState,
    buildPreamble,
    parseCompactDiff
} from './harnessState.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Максимальный объём доказательной базы (diff/артефакты), передаваемой судье.
// Контент идёт в файл/stdin (не в argv), но усечение защищает контекст модели.
const MAX_EVIDENCE_CHARS = 100000;

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        taskDir: args[0],
        nodeId: null,
        type: null,
        result: null,
        comment: null,
        approve: false,
        reject: false,
        commands: [],
        judgeFile: null
    };

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--node' && args[i + 1]) options.nodeId = normalizeNodeId(args[++i]);
        if (args[i] === '--type' && args[i + 1]) options.type = args[++i].toLowerCase();
        if (args[i] === '--result' && args[i + 1]) options.result = args[++i].toUpperCase();
        if (args[i] === '--comment' && args[i + 1]) options.comment = args[++i];
        if (args[i] === '--approve') options.approve = true;
        if (args[i] === '--reject') options.reject = true;
        if (args[i] === '--cmd' && args[i + 1]) options.commands.push(args[++i]);
        if (args[i] === '--judge-file' && args[i + 1]) options.judgeFile = args[++i];
    }

    return options;
}

async function updateReportVerdict(taskDir, result, comment) {
    const reportPath = path.resolve(taskDir, 'validation_report.md');
    try {
        let content = await readClean(reportPath);
        const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
        const icon = result === 'PASS' ? '✅' : '❌';

        const verdictSection = `## Вердикт

> **Результат:** ${icon} **${result}** | ${dateStr}
>
> - [${result === 'PASS' ? 'x' : ' '}] PASS — все критерии DoD выполнены
> - [${result === 'FAIL' ? 'x' : ' '}] FAIL — указать какие критерии не выполнены
>
> **Комментарий:**
> ${comment || '_(без комментария)_'}
`;

        if (/## Вердикт[\s\S]*$/i.test(content)) {
            content = content.replace(/## Вердикт[\s\S]*$/i, verdictSection);
        } else {
            content = `${content.trimEnd()}\n\n${verdictSection}`;
        }

        await fs.writeFile(reportPath, UTF8_BOM + content, 'utf-8');
        return reportPath;
    } catch {
        return null;
    }
}

async function runAutoValidation(taskDir, commands) {
    if (commands.length === 0) {
        return {
            overall: 'FAIL',
            config_error: true,
            results: [
                {
                    command: null,
                    status: 'FAIL',
                    output: 'Для auto-валидации не переданы команды --cmd.'
                }
            ]
        };
    }

    const results = [];
    for (const command of commands) {
        try {
            const { stdout } = await execAsync(command, { cwd: taskDir, timeout: 60000 });
            results.push({
                command,
                status: 'PASS',
                output: (stdout || '').trim().slice(0, 500)
            });
        } catch (error) {
            results.push({
                command,
                status: 'FAIL',
                output: (error.stderr || error.message || '').trim().slice(0, 500)
            });
        }
    }

    return {
        overall: results.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
        config_error: false,
        results
    };
}

function updateRoadmapAfterValidation(roadmap, node, result, detail, dodResults = null) {
    node.history.push({
        iteration: node.iteration,
        result,
        detail,
        at: new Date().toISOString()
    });

    if (dodResults && Array.isArray(dodResults)) {
        dodResults.forEach(dr => {
            if (node.dod[dr.index]) {
                node.dod[dr.index].done = dr.pass;
            }
        });
    } else if (result === 'PASS') {
        node.dod = node.dod.map(item => ({ ...item, done: true }));
    }

    if (result === 'PASS') {
        node.last_error = null;
    } else {
        node.last_error = detail || 'Валидация завершилась FAIL';
    }

    roadmap.current_node_id = node.id;
    return roadmap;
}

async function validateSubagentsStructure(taskDir, node) {
    const strategy = node.strategy;
    if (strategy === 'Orchestrator-Workers') {
        const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
        try {
            const opMemory = JSON.parse(await fs.readFile(opMemoryPath, 'utf-8'));
            const workers = opMemory.workers || {};
            const workerIds = Object.keys(workers);
            if (workerIds.length === 0) {
                return { success: false, error: 'В op_memory.json не объявлены исполнители (workers) для стратегии Orchestrator-Workers.' };
            }
            for (const workerId of workerIds) {
                const taskPath = path.resolve(taskDir, `op_worker_task_${workerId}.json`);
                const resultPath = path.resolve(taskDir, `op_worker_result_${workerId}.json`);
                try {
                    await fs.access(taskPath);
                } catch (err) {
                    return { success: false, error: `Отсутствует файл задачи субагента: op_worker_task_${workerId}.json` };
                }
                try {
                    await fs.access(resultPath);
                } catch (err) {
                    return { success: false, error: `Отсутствует файл отчета субагента: op_worker_result_${workerId}.json` };
                }
            }
        } catch (err) {
            return { success: false, error: `Ошибка при проверке op_memory.json: ${err.message}` };
        }
    } else if (strategy === 'Parallelization') {
        const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
        try {
            await fs.access(opMemoryPath);
            const files = await fs.readdir(taskDir);
            const partFiles = files.filter(f => /^op_task_part_.*\.json$/.test(f));
            if (partFiles.length === 0) {
                return { success: false, error: 'Для стратегии Parallelization отсутствуют файлы частей задач op_task_part_[ID].json.' };
            }
            for (const partFile of partFiles) {
                const match = partFile.match(/^op_task_part_(.*)\.json$/);
                if (match) {
                    const partId = match[1];
                    const resultPartPath = path.resolve(taskDir, `op_result_part_${partId}.json`);
                    try {
                        await fs.access(resultPartPath);
                    } catch (err) {
                        return { success: false, error: `Отсутствует файл результата для части задачи: op_result_part_${partId}.json` };
                    }
                }
            }
        } catch (err) {
            return { success: false, error: 'Отсутствует op_memory.json для стратегии Parallelization.' };
        }
    } else if (strategy === 'Map-Reduce') {
        const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
        try {
            await fs.access(opMemoryPath);
            const files = await fs.readdir(taskDir);
            const mapFiles = files.filter(f => /^op_map_data_.*\.json$/.test(f));
            if (mapFiles.length === 0) {
                return { success: false, error: 'Для стратегии Map-Reduce отсутствуют файлы данных op_map_data_[ID].json.' };
            }
            const hasReduce = files.some(f => f === 'op_reduce_final.json');
            if (!hasReduce) {
                return { success: false, error: 'Для стратегии Map-Reduce отсутствует файл сборки op_reduce_final.json.' };
            }
        } catch (err) {
            return { success: false, error: 'Отсутствует op_memory.json для стратегии Map-Reduce.' };
        }
    } else if (strategy === 'Routing') {
        const routePath = path.resolve(taskDir, 'op_route.json');
        try {
            const routeContent = JSON.parse(await fs.readFile(routePath, 'utf-8'));
            const routeSelected = routeContent.route_selected;
            if (!routeSelected) {
                return { success: false, error: 'В op_route.json не указано поле route_selected.' };
            }
            const taskPath = path.resolve(taskDir, `op_worker_task_${routeSelected}.json`);
            const resultPath = path.resolve(taskDir, `op_worker_result_${routeSelected}.json`);
            try {
                await fs.access(taskPath);
            } catch (err) {
                return { success: false, error: `Отсутствует файл задачи для выбранного маршрута: op_worker_task_${routeSelected}.json` };
            }
            try {
                await fs.access(resultPath);
            } catch (err) {
                return { success: false, error: `Отсутствует файл отчета для выбранного маршрута: op_worker_result_${routeSelected}.json` };
            }
        } catch (err) {
            return { success: false, error: `Не удалось прочитать или проверить op_route.json: ${err.message}` };
        }
    } else if (strategy === 'LATM / Tool Maker') {
        const makePath = path.resolve(taskDir, 'op_tool_make.json');
        const usePath = path.resolve(taskDir, 'op_tool_use.json');
        try {
            await fs.access(makePath);
        } catch (err) {
            return { success: false, error: 'Отсутствует файл разработки инструмента: op_tool_make.json' };
        }
        try {
            await fs.access(usePath);
        } catch (err) {
            return { success: false, error: 'Отсутствует файл использования инструмента: op_tool_use.json' };
        }
    } else if (strategy === 'Evaluator-Optimizer') {
        const feedbackPath = path.resolve(taskDir, 'op_feedback_loop.json');
        try {
            await fs.access(feedbackPath);
            const feedback = JSON.parse(await fs.readFile(feedbackPath, 'utf-8'));
            if (!feedback.iterations || !Array.isArray(feedback.iterations) || feedback.iterations.length === 0) {
                return { success: false, error: 'В op_feedback_loop.json отсутствует или пуст массив итераций оптимизации iterations.' };
            }
        } catch (err) {
            return { success: false, error: `Не удалось прочитать или проверить op_feedback_loop.json: ${err.message}` };
        }
    } else if (strategy === 'Prompt Chaining') {
        const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
        try {
            await fs.access(opMemoryPath);
        } catch (err) {
            return { success: false, error: 'Отсутствует op_memory.json для стратегии Prompt Chaining.' };
        }
    }
    return { success: true };
}

function truncateEvidence(text) {
    if (text.length <= MAX_EVIDENCE_CHARS) return text;
    return `${text.slice(0, MAX_EVIDENCE_CHARS)}\n\n...[усечено: показано ${MAX_EVIDENCE_CHARS} из ${text.length} символов]`;
}

// Доказательная база для судьи зависит от типа узла (WS-5, гибрид по типу):
//  - code → реальные изменения рабочего дерева (git diff репозитория + сабмодулей);
//  - text → содержимое deliverables (сценарии/ГДД/тексты не отражаются в git diff).
async function gatherEvidence(taskDir, node) {
    const kind = node.artifact_kind || 'code';

    if (kind === 'text') {
        const parts = [];
        let total = 0;
        for (const item of node.deliverables || []) {
            const rel = typeof item === 'string' ? item : item.path;
            if (!rel) continue;
            const abs = path.isAbsolute(rel) ? rel : path.resolve(taskDir, rel);
            try {
                const content = (await fs.readFile(abs, 'utf-8')).replace(/^﻿/, '');
                const chunk = `\n===== Артефакт: ${rel} =====\n${content}`;
                parts.push(chunk);
                total += chunk.length;
                if (total > MAX_EVIDENCE_CHARS) break;
            } catch { /* артефакт недоступен */ }
        }
        const evidence = parts.join('\n').trim() || '(артефакты не найдены на диске)';
        return { label: 'СОДЕРЖИМОЕ АРТЕФАКТОВ (проверяй по нему)', evidence: truncateEvidence(evidence) };
    }

    let gitDiff = '';
    try {
        const repoRoot = findRepoRoot();
        const filePaths = (node.deliverables || [])
            .map(d => typeof d === 'string' ? d : d.path)
            .filter(Boolean);

        if (filePaths.length > 0) {
            const relativePaths = filePaths.map(p => {
                const abs = path.isAbsolute(p) ? p : path.resolve(taskDir, p);
                return path.relative(repoRoot, abs).replace(/\\/g, '/');
            });

            // Получаем diff измененных отслеживаемых файлов
            const { stdout } = await execAsync(`git diff HEAD --submodule=diff -- ${relativePaths.map(p => `"${p}"`).join(' ')}`, {
                cwd: repoRoot,
                maxBuffer: 64 * 1024 * 1024
            });
            gitDiff = parseCompactDiff(stdout.trim());

            // Проверяем статус каждого файла на предмет untracked
            for (const relPath of relativePaths) {
                try {
                    const { stdout: status } = await execAsync(`git status --porcelain -- "${relPath}"`, { cwd: repoRoot });
                    if (status.startsWith('?? ')) {
                        const absPath = path.resolve(repoRoot, relPath);
                        const fileContent = await fs.readFile(absPath, 'utf-8');
                        const truncated = fileContent.length > 20000 
                            ? fileContent.slice(0, 20000) + '\n...[содержимое файла усечено]'
                            : fileContent;
                        gitDiff += `\n\n=== NEW UNTRACKED FILE ${relPath} ===\n${truncated}`;
                    }
                } catch { /* ignore */ }
            }
        }
    } catch (err) {
        gitDiff = `Не удалось получить git diff: ${err.message}`;
    }

    if (!gitDiff) gitDiff = '(нет изменений в рабочем дереве)';
    return { label: 'ФАКТИЧЕСКИЕ ИЗМЕНЕНИЯ (git diff HEAD)', evidence: truncateEvidence(gitDiff) };
}

// Собирает промпт судьи (system + user). Используется и для внешнего CLI-судьи,
// и для выгрузки задания субагенту-судье в режиме fallback.
async function buildJudgePrompt(taskDir, node) {
    const reportPath = path.resolve(taskDir, 'validation_report.md');
    let reportContent = '';
    try {
        reportContent = await readClean(reportPath);
    } catch {
        reportContent = 'Отчёт отсутствует.';
    }

    const { evidence, label } = await gatherEvidence(taskDir, node);
    const dodText = node.dod.map((item, idx) => `${idx}. ${item.criterion}`).join('\n');
    const preamble = await buildPreamble(taskDir, node);

    const systemText = `${preamble}

Ты — независимый внешний AI-Судья (Validator). Тебя вызвали, чтобы объективно и жёстко проверить ЧУЖУЮ работу по критериям DoD. Не доверяй отчёту исполнителя — опирайся на фактические изменения/артефакты. Оценивай строго по существу. Никаких лишних действий, придирок к стилю или не связанных с задачей рефакторингов. Оценивай ТОЛЬКО то, о чем просили в DoD. Новые изменения ни в коем случае не должны ломать действующую структуру.
Верни СТРОГО JSON без markdown-обёртки:
{
  "pass": boolean,
  "dod_results": [ { "index": 0, "pass": true }, { "index": 1, "pass": false } ],
  "evidence": ["дословная цитата из diff/артефактов, подтверждающая вердикт", "..."],
  "errors": ["конкретная причина 1", "..."]
}
Массив dod_results обязан содержать оценку каждого критерия DoD по его индексу (с 0). Если хотя бы один критерий не выполнен — верни pass: false.
ОБЯЗАТЕЛЬНО: для вердикта pass=true массив "evidence" должен содержать минимум одну ДОСЛОВНУЮ цитату из фактических изменений/артефактов, доказывающую выполнение DoD. Голый pass без цитат-доказательств недопустим и будет отклонён.`;

    const userText = `КРИТЕРИИ DoD (индексы с 0):
${dodText}

ОТЧЁТ ИСПОЛНИТЕЛЯ (может быть неточным — проверяй по фактам):
${reportContent}

${label}:
${evidence}`;

    return { systemText, userText };
}

/**
 * Пытается распарсить и восстановить поломанный JSON от ИИ.
 * @param {string} text
 * @returns {object|null}
 */
function tryFixJson(text) {
    if (!text) return null;
    let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
        return null;
    }
    clean = clean.slice(firstBrace, lastBrace + 1);

    try {
        return JSON.parse(clean);
    } catch (e) {
        try {
            const fixed = clean
                .replace(/,\s*([}\]])/g, '$1') // trailing commas
                .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":') // unquoted keys
                .replace(/'([^']+)'\s*:/g, '"$1":'); // single quotes to double quotes
            return JSON.parse(fixed);
        } catch (e2) {
            // Фолбек регулярными выражениями при полной невалидности структуры
            const passMatch = clean.match(/"pass"\s*:\s*(true|false)/i);
            const errorsMatch = clean.match(/"errors"\s*:\s*\[([\s\S]*?)\]/);
            if (passMatch) {
                const passVal = passMatch[1].toLowerCase() === 'true';
                const errors = [];
                if (errorsMatch && errorsMatch[1]) {
                    const stringMatches = errorsMatch[1].match(/"([^"]+)"/g);
                    if (stringMatches) {
                        errors.push(...stringMatches.map(s => s.slice(1, -1)));
                    }
                }
                return { pass: passVal, errors, dod_results: [] };
            }
        }
    }
    return null;
}

// AI-валидация всегда идёт через НЕЗАВИСИМОГО судью. Приоритет — внешний CLI-ИИ.
// Цепочка судей фильтруется по preflight-опросу (aiProbe.js): мёртвые бинарники
// не опрашиваются вслепую и не вешают цикл таймаутами. Если живых внешних судей
// нет — возвращается fallback_required: валидацию выполняет независимый субагент
// IDE-агента (свежий контекст) через --judge-file. Дифф/артефакты передаются
// судье через файл/stdin (внутри cliTransport), а не через argv.
async function runAiValidation(taskDir, node) {
    const { systemText, userText } = await buildJudgePrompt(taskDir, node);

    // A judge must not be a sibling of the executor's own model family.
    const { chain, model, probe, fallback } = await getAvailableJudgeChain({ excludeFamily: node.worker_family || null });
    if (fallback) {
        return {
            overall: null,
            fallback_required: true,
            probe_summary: probeSummary(probe)
        };
    }
    const timeoutMs = parseInt(process.env.HARNESS_JUDGE_TIMEOUT_MS, 10) || undefined;

    // Вызываем судей параллельно
    const judged = await callExternalJudge({
        workDir: taskDir, systemText, userText, chain, model, timeoutMs
    });

    if (!judged.ok) {
        const tried = (judged.attempts || []).map(a => `${a.bin}: ${a.error}`).join(' | ');
        return {
            overall: null,
            fallback_required: true,
            probe_summary: `внешние судьи упали в рантайме: ${tried}`
        };
    }

    const result = tryFixJson(judged.text);
    if (result) {
        // Reject a bare PASS: a positive verdict MUST cite at least one non-empty
        // evidence quote from the diff/artifacts, else it is not trustworthy.
        const evidence = Array.isArray(result.evidence)
            ? result.evidence.filter(e => typeof e === 'string' && e.trim().length > 0)
            : [];
        if (result.pass && evidence.length === 0) {
            return {
                overall: 'FAIL',
                dod_results: result.dod_results || null,
                comment: `Судья [${judged.bin}]: PASS отклонён — не приведено ни одной цитаты-доказательства (evidence). Требуется дословное подтверждение из diff/артефактов.`
            };
        }
        return {
            overall: result.pass ? 'PASS' : 'FAIL',
            dod_results: result.dod_results || null,
            comment: result.pass
                ? `Судья [${judged.bin}]: все критерии выполнены. Доказательства: ${evidence.slice(0, 3).join(' | ')}`
                : `Судья [${judged.bin}]: ${(result.errors || []).join('; ') || 'критерии не выполнены'}`
        };
    }

    return {
        overall: 'FAIL',
        dod_results: null,
        comment: `Ответ судьи [${judged.bin}] не удалось распарсить как JSON: ${judged.text.slice(0, 160)}`
    };
}

async function main() {
    const options = parseArgs();
    if (!options.taskDir || !options.nodeId || !options.type) {
        console.error(JSON.stringify({
            error: 'Использование: node validator.js <task_dir> --node УЗЕЛ-01 --type auto|ai|human [--result PASS|FAIL] [--comment "..."] [--approve] [--reject] [--cmd "..."]'
        }));
        process.exit(1);
    }

    if (!['auto', 'ai', 'human'].includes(options.type)) {
        console.error(JSON.stringify({
            error: `Неизвестный тип: ${options.type}. Допустимые: auto, ai, human`
        }));
        process.exit(1);
    }

    const state = await readState(options.taskDir);
    const roadmap = await readRoadmap(options.taskDir);
    const node = getNode(roadmap, options.nodeId);
    if (!node) {
        console.error(JSON.stringify({ error: `Узел ${options.nodeId} не найден в .harness_roadmap.json` }));
        process.exit(1);
    }

    if (options.type === 'human' && (options.approve || options.reject)) {
        if (state.stage !== 'awaiting_human_validation') {
            console.error(JSON.stringify({
                error: 'GATE_FAILED',
                gate: 'awaiting_human_validation',
                current_stage: state.stage,
                message: 'Нет ожидающей человеческой валидации для этого узла.'
            }));
            process.exit(1);
        }
    } else if (options.type === 'ai' && options.judgeFile) {
        // Вердикт субагента-судьи принимается ТОЛЬКО в fallback-режиме,
        // объявленном самим валидатором (гейт от самовалидации в обход судьи).
        if (state.stage !== 'awaiting_subagent_validation') {
            console.error(JSON.stringify({
                error: 'GATE_FAILED',
                gate: 'awaiting_subagent_validation',
                current_stage: state.stage,
                message: '--judge-file допустим только после того, как валидатор сам объявил fallback (NEEDS_SUBAGENT_JUDGE). Пока внешние судьи доступны — вердикт выносят они.'
            }));
            process.exit(1);
        }
    } else if (state.stage && state.stage !== 'report_ready') {
        console.error(JSON.stringify({
            error: 'GATE_FAILED',
            gate: 'report_ready',
            current_stage: state.stage,
            message: 'Сначала сгенерируйте отчёт через contextAssembler.js --mode validate'
        }));
        process.exit(1);
    }

    // ─── ГЕЙТ: обязательный SUMMARY в отчёте (B2) ───
    // Handoff-компрессия работает только если каждый узел оставляет краткое резюме.
    // Отключается HARNESS_REQUIRE_SUMMARY=0. Не применяется к приёму вердикта субагента
    // и к запросу человеческой валидации (там отчёт ещё может дозаполняться).
    if (process.env.HARNESS_REQUIRE_SUMMARY !== '0' && !options.judgeFile
        && !(options.type === 'human' && !options.approve && !options.reject)) {
        let reportRaw = '';
        try { reportRaw = await readClean(path.resolve(options.taskDir, 'validation_report.md')); } catch { /* нет отчёта */ }
        const m = reportRaw.match(/##\s*SUMMARY\s*\n+([\s\S]*?)(?:\n---|\n##\s|$)/i);
        const body = m ? m[1].trim() : '';
        if (!body || body.includes('ОБЯЗАТЕЛЬНО заполнить')) {
            console.error(JSON.stringify({
                error: 'GATE_FAILED',
                gate: 'summary_required',
                message: 'Отчёт не содержит заполненного раздела ## SUMMARY (≤300 токенов). Заполните резюме сделанного перед валидацией (или HARNESS_REQUIRE_SUMMARY=0).'
            }));
            process.exit(1);
        }
    }

    // ─── ГЕЙТ: Проверка наличия файлов субагентов для мультиагентных стратегий ───
    const isPassing = (options.type === 'ai' && options.result === 'PASS') ||
                      (options.type === 'auto') ||
                      (options.type === 'human' && options.approve);
                      
    if (isPassing) {
        const subagentCheck = await validateSubagentsStructure(options.taskDir, node);
        if (!subagentCheck.success) {
            console.error(JSON.stringify({
                error: 'GATE_FAILED',
                gate: 'subagent_files_check',
                current_stage: state.stage,
                message: subagentCheck.error
            }));
            process.exit(1);
        }
    }

    let response;
    let validationResult = null;
    let validationComment = options.comment || null;

    switch (options.type) {
        case 'auto': {
            const auto = await runAutoValidation(options.taskDir, options.commands);
            validationResult = auto.overall;
            validationComment = auto.results.map(item =>
                item.command ? `${item.command}: ${item.status}` : item.output
            ).join('; ');
            await updateReportVerdict(options.taskDir, validationResult, validationComment);
            updateRoadmapAfterValidation(roadmap, node, validationResult, validationComment);

            response = {
                type: 'auto',
                node: node.id,
                overall: auto.overall,
                config_error: auto.config_error,
                checks: auto.results
            };
            break;
        }

        case 'ai': {
            // Deterministic-oracle short-circuit (F2): if the node ships a cheap
            // deterministic oracle (--cmd: tests/linter/compiler), the exit code IS
            // the verdict — do NOT spend paid judge tokens. The LLM judge is reserved
            // for nodes with NO cheap oracle. The subagent-fallback (--judge-file) and
            // pure-ai (no --cmd) paths are unchanged.
            if (!options.judgeFile && options.commands.length > 0) {
                const auto = await runAutoValidation(options.taskDir, options.commands);
                validationResult = auto.overall;
                validationComment = `[oracle, judge skipped] ` + auto.results.map(item =>
                    item.command ? `${item.command}: ${item.status}` : item.output
                ).join('; ');
                await updateReportVerdict(options.taskDir, validationResult, validationComment);
                updateRoadmapAfterValidation(roadmap, node, validationResult, validationComment);
                response = {
                    type: 'ai',
                    node: node.id,
                    result: validationResult,
                    judge: 'deterministic_oracle',
                    judge_tokens: 0,
                    checks: auto.results,
                    comment: validationComment
                };
                break;
            }
            if (options.judgeFile) {
                // Fallback: вердикт вынес независимый субагент IDE-агента.
                const verdictPath = path.isAbsolute(options.judgeFile)
                    ? options.judgeFile
                    : path.resolve(options.taskDir, options.judgeFile);
                let verdict;
                try {
                    verdict = JSON.parse((await readClean(verdictPath)));
                } catch (err) {
                    console.error(JSON.stringify({
                        error: `Не удалось прочитать вердикт судьи из ${verdictPath}: ${err.message}`
                    }));
                    process.exit(1);
                }
                if (typeof verdict.pass !== 'boolean') {
                    console.error(JSON.stringify({
                        error: 'Вердикт судьи обязан содержать поле "pass": boolean (формат: {pass, dod_results, errors}).'
                    }));
                    process.exit(1);
                }

                if (verdict.pass) {
                    const subagentCheck = await validateSubagentsStructure(options.taskDir, node);
                    if (!subagentCheck.success) {
                        console.error(JSON.stringify({
                            error: 'GATE_FAILED',
                            gate: 'subagent_files_check',
                            message: subagentCheck.error
                        }));
                        process.exit(1);
                    }
                }

                validationResult = verdict.pass ? 'PASS' : 'FAIL';
                validationComment = verdict.pass
                    ? 'Судья [subagent-fallback]: все критерии выполнены.'
                    : `Судья [subagent-fallback]: ${(verdict.errors || []).join('; ') || 'критерии не выполнены'}`;

                await updateReportVerdict(options.taskDir, validationResult, validationComment);
                updateRoadmapAfterValidation(roadmap, node, validationResult, validationComment, verdict.dod_results || null);

                state.validation_mode = 'subagent_fallback';
                response = {
                    type: 'ai',
                    judge: 'subagent_fallback',
                    node: node.id,
                    result: validationResult,
                    comment: validationComment
                };
                break;
            }

            const aiCheck = await runAiValidation(options.taskDir, node);

            if (aiCheck.fallback_required) {
                // Внешних судей нет — выгружаем задание судьи и переводим цикл в
                // режим субагент-валидации, НЕ роняя узел «мусорным» FAIL.
                const { systemText, userText } = await buildJudgePrompt(options.taskDir, node);
                const judgeTaskPath = path.resolve(options.taskDir, 'ai_judge_task.md');
                await fs.writeFile(
                    judgeTaskPath,
                    UTF8_BOM + `# Задание независимому судье (subagent-fallback)\n\n` +
                    `> Внешние CLI-судьи недоступны: ${aiCheck.probe_summary}\n\n` +
                    `## SYSTEM\n\n${systemText}\n\n## USER\n\n${userText}\n`,
                    'utf-8'
                );

                state.stage = 'awaiting_subagent_validation';
                state.validation_type = 'ai';
                state.validation_mode = 'subagent_fallback';
                state.current_node = node.id;
                await writeState(options.taskDir, state);

                console.log(JSON.stringify({
                    type: 'ai',
                    node: node.id,
                    action: 'NEEDS_SUBAGENT_JUDGE',
                    probe: aiCheck.probe_summary,
                    judge_task: judgeTaskPath.replace(/\\/g, '/'),
                    verdict_file: 'ai_judge_verdict.json',
                    message: 'Внешние CLI-судьи недоступны. Запусти НЕЗАВИСИМОГО субагента со свежим контекстом (никакого доступа к текущему диалогу): он читает ai_judge_task.md, проверяет работу по фактам и пишет вердикт строго в JSON {pass, dod_results, errors} в ai_judge_verdict.json. Затем: node validator.js <task_dir> --node ' + node.id + ' --type ai --judge-file ai_judge_verdict.json. Самовалидация в текущем контексте запрещена.'
                }, null, 2));
                return;
            }

            validationResult = aiCheck.overall;
            validationComment = aiCheck.comment;

            await updateReportVerdict(options.taskDir, validationResult, validationComment);
            updateRoadmapAfterValidation(roadmap, node, validationResult, validationComment, aiCheck.dod_results);

            response = {
                type: 'ai',
                node: node.id,
                result: validationResult,
                comment: validationComment
            };
            break;
        }

        case 'human': {
            if (options.approve) {
                validationResult = 'PASS';
                validationComment = options.comment || 'Одобрено человеком.';
                await updateReportVerdict(options.taskDir, validationResult, validationComment);
                updateRoadmapAfterValidation(roadmap, node, validationResult, validationComment);

                response = {
                    type: 'human',
                    node: node.id,
                    result: validationResult,
                    comment: validationComment
                };
            } else if (options.reject) {
                validationResult = 'FAIL';
                validationComment = options.comment || 'Отклонено человеком.';
                await updateReportVerdict(options.taskDir, validationResult, validationComment);
                updateRoadmapAfterValidation(roadmap, node, validationResult, validationComment);

                response = {
                    type: 'human',
                    node: node.id,
                    result: validationResult,
                    comment: validationComment
                };
            } else {
                state.stage = 'awaiting_human_validation';
                state.validation_type = 'human';
                state.current_node = node.id;
                await writeState(options.taskDir, state);

                const reportPath = path.resolve(options.taskDir, 'validation_report.md').replace(/\\/g, '/');
                console.log(JSON.stringify({
                    type: 'human',
                    node: node.id,
                    status: 'AWAITING_HUMAN',
                    report_path: reportPath,
                    message: `Отчёт готов: ${reportPath}. Ожидаю вашу оценку. Для одобрения: node validator.js ${options.taskDir} --node ${node.id} --type human --approve`
                }, null, 2));
                return;
            }
            break;
        }
    }

    if (validationResult === 'PASS') {
        state.stage = 'validated';
        state.validated_at = new Date().toISOString();
        state.validation_result = 'PASS';
        state.current_node = node.id;
    } else {
        state.stage = 'report_ready';
        state.validation_result = 'FAIL';
        state.current_node = node.id;
    }

    await writeRoadmap(options.taskDir, roadmap, { syncMarkdown: true });
    await writeState(options.taskDir, state);
    console.log(JSON.stringify(response, null, 2));
}

main().then(() => process.exit(0)).catch(err => {
    console.error(JSON.stringify({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) }));
    process.exit(1);
});
