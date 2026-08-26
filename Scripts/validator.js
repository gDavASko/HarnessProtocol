import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { callExternalJudge, callSingleJudge } from './cliTransport.js';
import { getAvailableJudgeChain, probeSummary, familyOf, liveJudgesFromProbe } from './aiProbe.js';
import { selectJudge, toFamily } from './judgeSelector.js';
import { classifyNode, evaluateFloor, recordRung, RUNGS, isTrivialOracleCommand, recordTaskIntegration } from './evidenceLadder.js';
import { scanText } from './securityScan.js';
import { evaluateRubric } from './rubric.js';
import { getJudgePool, getQuorumPolicy } from './harnessConfig.js';
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

// F5 + Phase-2: derive a node's criticality for judge selection. Explicit
// node.criticality wins; otherwise map from tier/mode/validation_type. Auto/
// deterministic-oracle nodes default to L0 (no LLM judge). AI/harness nodes
// default to L1. Deep tier → L3, harness mode → L2.
function deriveCriticality(node) {
    if (node && node.criticality) return String(node.criticality).toUpperCase();
    const tier = (node && node.tier) || '';
    if (tier === 'deep' || tier === 'max' || tier === 'top') return 'L3';
    if (node && node.mode === 'harness') return 'L2';
    if (node && node.validation_type === 'auto') return 'L0';
    return 'L1';
}

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
        judgeFile: null,
        rung: null,
        waive: null
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
        if (args[i] === '--rung' && args[i + 1]) options.rung = args[++i].toLowerCase();
        if (args[i] === '--waive' && args[i + 1]) options.waive = args[++i];
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

Ты — независимый внешний AI-Судья (Red-Team Validator). Твоя работа — НЕ подтвердить, что работа хороша, а НАЙТИ, чем она НЕ решает настоящий запрос пользователя. Действуй с презумпцией подозрения: считай, что дефекты есть, пока не убедишься в обратном по фактам. Планка — то, что забраковал бы придирчивый senior-инженер на ревью перед мержем в продакшн.
Не доверяй отчёту исполнителя — опирайся ТОЛЬКО на фактические изменения/артефакты. Проверяй не «похоже ли, что критерий выполнен», а «действительно ли оно работает и полностью закрывает запрос»: ищи необработанные крайние случаи, разорванную интеграцию (код написан, но не подключён к вызывающей стороне), молчаливые провалы, рассинхрон с исходной целью задачи, регрессии в затронутых местах.
Для КАЖДОГО найденного дефекта дай КОНКРЕТНЫЙ воспроизводимый сценарий провала в форме «вход/состояние → неверный выход/поведение». Дефект без такого сценария — это догадка, не находка; не засчитывай его, но и не выдавай pass, если реальных сомнений много.
Выноси pass=true ТОЛЬКО когда каждый критерий DoD действительно закрыт по фактам и ты честно попытался сломать работу и не смог.
Верни СТРОГО JSON без markdown-обёртки:
{
  "pass": boolean,
  "dod_results": [ { "index": 0, "pass": true }, { "index": 1, "pass": false } ],
  "evidence": ["дословная цитата из diff/артефактов", "..."],
  "errors": ["DoD#<индекс>: <дефект и сценарий провала: вход/состояние → неверный результат>", "..."],
  "rubric": { "functionality": 0-10, "quality": 0-10, "security": 0-10, "edge_cases": 0-10 }
}
Рубрика (обязательна): оцени 4 измерения по шкале 0..10 честно и придирчиво: functionality (соответствие запросу по факту), quality (чистота/поддерживаемость/обработка ошибок), security (нет утечек секретов, инъекций, обхода авторизации), edge_cases (крайние случаи, некорректный ввод, отказы). Низкие measures при формальном pass — это сигнал; порог и security-floor применяются автоматически.
Массив dod_results обязан содержать оценку каждого критерия DoD по его индексу (с 0). Если хотя бы один критерий не выполнен — верни pass: false.
ОБЯЗАТЕЛЬНО: для вердикта pass=true массив "evidence" должен содержать минимум одну ДОСЛОВНУЮ цитату из фактических изменений/артефактов, доказывающую выполнение DoD. Голый pass без цитат-доказательств недопустим и будет отклонён.
ОБЯЗАТЕЛЬНО: для вердикта pass=false массив "errors" обязан содержать для каждого проваленного критерия конкретный сценарий провала (вход/состояние → неверный результат), а не общую формулировку.`;

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

// ── L3 quorum / dual_order helpers (F-quorum) ────────────────────────────────
//
// judgeSelector returns {mode:'single'|'quorum'|'dual_order', judges:[...]}. For
// L3 the selector chooses quorum (2 cross-family judges) or dual_order (1 judge,
// two orderings) — we MUST honor it and NOT early-exit on the first passing
// judge (that was the RUN3 N6 bug: single-judge assurance for critical nodes).
//
// Policy (default 'all', fail-closed):
//   * quorum   : run EVERY selected judge (parallel, each with its own timeout).
//                Combine per config quorum_policy ('all'|'majority').
//                Any judge that errors/times-out is NOT a valid verdict — if
//                that leaves fewer valid verdicts than required, overall is
//                UNVALIDATED (never PASS on the single answer that came back).
//   * dual_order: same judge invoked TWICE with the two evidence/DoD orderings
//                swapped; BOTH must PASS for overall PASS (mitigates position
//                bias when only one family is live).
//   * single   : existing chain-based path (chosen chain length == 1).

/**
 * Parse a raw judge JSON reply into a normalized verdict record.
 * Enforces the "bare PASS without evidence -> FAIL" rule already present in
 * the single-judge path, so quorum members can't sneak an unjustified PASS in.
 * @returns {{verdict:'PASS'|'FAIL'|'PARSE_ERROR', evidence:string[], errors:string[], dodResults:Array|null, rubric?:object, raw:string}}
 */
export function parseJudgeVerdict(rawText) {
    const parsed = tryFixJson(rawText);
    if (!parsed) {
        return { verdict: 'PARSE_ERROR', evidence: [], errors: ['unparseable JSON'], dodResults: null, raw: rawText };
    }
    const evidence = Array.isArray(parsed.evidence)
        ? parsed.evidence.filter(e => typeof e === 'string' && e.trim().length > 0)
        : [];
    const errors = Array.isArray(parsed.errors) ? parsed.errors.filter(Boolean) : [];
    const dodResults = Array.isArray(parsed.dod_results) ? parsed.dod_results : null;
    if (parsed.pass === true) {
        if (evidence.length === 0) {
            // Bare PASS without any cited evidence — reject exactly as the
            // single-judge path does.
            return { verdict: 'FAIL', evidence, errors: ['PASS отклонён: не приведено ни одной цитаты-доказательства (evidence).'], dodResults, raw: rawText };
        }
        // Взвешенная рубрика может понизить формальный PASS до FAIL.
        const rub = evaluateRubric(parsed.rubric);
        if (!rub.ok) {
            return { verdict: 'FAIL', evidence, errors: [...errors, `Рубрика отклонила PASS: ${rub.reason}`], dodResults, rubric: rub, raw: rawText };
        }
        return { verdict: 'PASS', evidence, errors, dodResults, rubric: rub, raw: rawText };
    }
    return { verdict: 'FAIL', evidence, errors, dodResults, rubric: evaluateRubric(parsed.rubric), raw: rawText };
}

/**
 * Combine per-judge verdicts into an overall decision.
 * @param {Array<{bin:string, ok:boolean, verdict:'PASS'|'FAIL'|'PARSE_ERROR'|'ERROR', error?:string, evidence?:string[], errors?:string[], dodResults?:Array|null}>} perJudge
 * @param {number} requiredCount   how many valid verdicts we planned for (quorum size or 2 for dual_order)
 * @param {'all'|'majority'} policy
 * @returns {{overall:'PASS'|'FAIL'|'UNVALIDATED', reason:string, dodResults:Array|null}}
 */
export function combineQuorumVerdicts(perJudge, requiredCount, policy = 'all') {
    const valid = perJudge.filter(v => v && (v.verdict === 'PASS' || v.verdict === 'FAIL'));
    if (valid.length < requiredCount) {
        return {
            overall: 'UNVALIDATED',
            reason: `insufficient valid verdicts: ${valid.length}/${requiredCount} (errored: ${perJudge.length - valid.length})`,
            dodResults: null
        };
    }
    const passes = valid.filter(v => v.verdict === 'PASS').length;
    const fails = valid.length - passes;
    let overall;
    let reason;
    if (policy === 'majority') {
        overall = passes > (valid.length / 2) ? 'PASS' : 'FAIL';
        reason = `policy=majority: ${passes} pass / ${fails} fail of ${valid.length}`;
    } else {
        // fail-closed 'all': any FAIL flips overall to FAIL.
        overall = fails === 0 ? 'PASS' : 'FAIL';
        reason = `policy=all: ${passes} pass / ${fails} fail of ${valid.length}`;
    }
    // Merge dod_results conservatively: for PASS overall, all judges agreed;
    // adopt the first judge's dod_results as canonical. For FAIL, adopt the
    // first FAILing judge's dod_results (its criticism is what caused the fail).
    let dodResults = null;
    if (overall === 'PASS') {
        const first = valid.find(v => v.dodResults);
        dodResults = first ? first.dodResults : null;
    } else if (overall === 'FAIL') {
        const firstFail = valid.find(v => v.verdict === 'FAIL' && v.dodResults);
        dodResults = firstFail ? firstFail.dodResults : null;
    }
    return { overall, reason, dodResults };
}

/**
 * Swap the ordering of DoD-criteria and evidence sections in the judge user
 * prompt (dual_order). Falls back to the original text if the markers aren't
 * found (never crash).
 */
export function swapUserTextOrder(userText) {
    if (!userText || typeof userText !== 'string') return userText;
    const critIdx = userText.indexOf('КРИТЕРИИ DoD');
    // The evidence label varies ('ФАКТИЧЕСКИЕ ИЗМЕНЕНИЯ' or 'СОДЕРЖИМОЕ АРТЕФАКТОВ');
    // both are followed by ':' at a section boundary. Find the last section
    // start (evidence section) and swap it with the criteria section.
    const evIdxA = userText.indexOf('\nФАКТИЧЕСКИЕ ИЗМЕНЕНИЯ');
    const evIdxB = userText.indexOf('\nСОДЕРЖИМОЕ АРТЕФАКТОВ');
    const evIdx = evIdxA >= 0 ? evIdxA : evIdxB;
    if (critIdx < 0 || evIdx < 0 || evIdx <= critIdx) return userText;
    const head = userText.slice(0, critIdx);
    const criteria = userText.slice(critIdx, evIdx).trimEnd();
    const evidence = userText.slice(evIdx).trimStart();
    return `${head}${evidence}\n\n${criteria}\n`;
}

// AI-валидация всегда идёт через НЕЗАВИСИМОГО судью. Приоритет — внешний CLI-ИИ.
// Цепочка судей фильтруется по preflight-опросу (aiProbe.js): мёртвые бинарники
// не опрашиваются вслепую и не вешают цикл таймаутами. Если живых внешних судей
// нет — возвращается fallback_required: валидацию выполняет независимый субагент
// IDE-агента (свежий контекст) через --judge-file. Дифф/артефакты передаются
// судье через файл/stdin (внутри cliTransport), а не через argv.
async function runAiValidation(taskDir, node) {
    const { systemText, userText } = await buildJudgePrompt(taskDir, node);

    // Phase-2 wiring: dispatch judges via judgeSelector using LIVE judges from the
    // probe. L0 nodes never reach the LLM judge. UNVALIDATED must never PASS.
    const criticality = deriveCriticality(node);
    const { chain, model, probe, fallback, live_judges = [] } = await getAvailableJudgeChain();

    // L0 short-circuit: deterministic oracle is the verdict — no LLM judge. If we
    // reached runAiValidation for an L0 node, the caller did not provide an oracle
    // (--cmd). Return a synthetic verdict that marks the node UNVALIDATED without
    // spending judge tokens.
    if (criticality === 'L0') {
        return {
            overall: 'UNVALIDATED',
            oracle_only: true,
            probe_summary: probeSummary(probe),
            comment: 'L0: deterministic oracle required (compile/test) — no LLM judge invoked. Provide --cmd or lower criticality.'
        };
    }

    // Isolation doctrine: the judge is an INDEPENDENT session (fresh-context
    // subagent), never the worker's own session. It MAY be the same model family —
    // cross-family is preferred (the selector ranks it first) but not mandatory.
    // Pass the full live pool; the selector prefers cross-family and falls back to a
    // same-family isolated judge, returning UNVALIDATED only when no judge is live.
    const selection = selectJudge({
        worker_family: node.worker_family,
        artifact_kind: node.artifact_kind,
        criticality,
        live_judges
    });

    if (selection.decision === 'UNVALIDATED') {
        return {
            overall: 'UNVALIDATED',
            selection_reason: selection.reason,
            probe_summary: probeSummary(probe),
            comment: `Судьи не выбраны (${selection.reason}). Проба: ${probeSummary(probe)}`
        };
    }
    if (selection.decision === 'oracle_only') {
        return {
            overall: 'UNVALIDATED',
            oracle_only: true,
            probe_summary: probeSummary(probe),
            comment: 'oracle_only selection but no deterministic oracle configured for this node.'
        };
    }

    // Selector chose specific judges — honor its ordering EXACTLY. Do not fall back
    // to the wider chain, do not add extras. If the chosen judge is not live in the
    // probe cache (should not happen because live_judges is derived from probe),
    // callExternalJudge will report the failure and we mark UNVALIDATED.
    const chosenChain = selection.judges.map(j => j.id).filter(Boolean);
    if (chosenChain.length === 0) {
        return {
            overall: 'UNVALIDATED',
            selection_reason: 'judgeSelector returned no judges',
            probe_summary: probeSummary(probe)
        };
    }
    // Special case: claude-subagent is an IDE subagent, not a CLI. If the selector
    // picked it, route to the manual subagent-fallback path (writes ai_judge_task.md,
    // human/IDE feeds the verdict back via --judge-file). This is the SAME code path
    // as the legacy fallback_required branch.
    if (chosenChain.every(id => id === 'claude-subagent')) {
        return {
            overall: null,
            fallback_required: true,
            probe_summary: probeSummary(probe),
            selection_reason: selection.reason
        };
    }
    // Drop non-CLI judges from the chain we hand to callExternalJudge (it can only
    // spawn actual CLI binaries). Same-family or non-CLI mixed into the chain would
    // waste attempts.
    const cliChain = chosenChain.filter(id => id !== 'claude-subagent');
    // Shorter default per-call timeout for judges + bounded retry (max 2 attempts).
    const timeoutMs = parseInt(process.env.HARNESS_JUDGE_TIMEOUT_MS, 10) || null;

    // ── L3 quorum (F-quorum): run ALL selected judges (parallel), combine fail-closed.
    if (selection.mode === 'quorum' && cliChain.length >= 2) {
        const policy = getQuorumPolicy();
        const requiredCount = cliChain.length;
        const invocations = await Promise.all(cliChain.map(async bin => {
            const res = await callSingleJudge({ workDir: taskDir, systemText, userText, bin, model, timeoutMs, role: 'judge' });
            if (!res.ok) {
                return { bin, ok: false, verdict: 'ERROR', error: res.error || 'unknown error' };
            }
            const parsed = parseJudgeVerdict(res.text);
            return { bin, ok: true, verdict: parsed.verdict, evidence: parsed.evidence, errors: parsed.errors, dodResults: parsed.dodResults, raw: parsed.raw };
        }));
        const combined = combineQuorumVerdicts(invocations, requiredCount, policy);
        const perJudgeLog = invocations.map(v => v.ok
            ? `${v.bin}=${v.verdict}${v.verdict === 'PASS' && v.evidence?.length ? ' [' + v.evidence.slice(0, 1).join('') + ']' : ''}${v.verdict === 'FAIL' && v.errors?.length ? ' (' + v.errors.slice(0, 1).join('') + ')' : ''}`
            : `${v.bin}=ERROR (${v.error})`).join(' | ');
        const comment = combined.overall === 'UNVALIDATED'
            ? `Судья [quorum ${cliChain.join('+')}]: ${combined.reason}. Per-judge: ${perJudgeLog}`
            : combined.overall === 'PASS'
                ? `Судья [quorum ${cliChain.join('+')}]: PASS (${combined.reason}). Per-judge: ${perJudgeLog}`
                : `Судья [quorum ${cliChain.join('+')}]: FAIL (${combined.reason}). Per-judge: ${perJudgeLog}`;
        return {
            overall: combined.overall,
            dod_results: combined.dodResults,
            comment,
            judge_verdicts: invocations
        };
    }

    // ── L3 dual_order (single judge, two orderings): both must PASS.
    if (selection.mode === 'dual_order' && cliChain.length >= 1) {
        const bin = cliChain[0];
        const userTextA = userText;
        const userTextB = swapUserTextOrder(userText);
        const [ra, rb] = await Promise.all([
            callSingleJudge({ workDir: taskDir, systemText, userText: userTextA, bin, model, timeoutMs, role: 'judge' }),
            callSingleJudge({ workDir: taskDir, systemText, userText: userTextB, bin, model, timeoutMs, role: 'judge' })
        ]);
        const invocations = [ra, rb].map((res, i) => {
            const label = `${bin}#${i === 0 ? 'A' : 'B'}`;
            if (!res.ok) return { bin: label, ok: false, verdict: 'ERROR', error: res.error || 'unknown error' };
            const parsed = parseJudgeVerdict(res.text);
            return { bin: label, ok: true, verdict: parsed.verdict, evidence: parsed.evidence, errors: parsed.errors, dodResults: parsed.dodResults, raw: parsed.raw };
        });
        // dual_order is ALWAYS all-must-PASS (fail-closed), independent of quorum_policy.
        const combined = combineQuorumVerdicts(invocations, 2, 'all');
        const perJudgeLog = invocations.map(v => v.ok
            ? `${v.bin}=${v.verdict}`
            : `${v.bin}=ERROR (${v.error})`).join(' | ');
        const comment = combined.overall === 'UNVALIDATED'
            ? `Судья [dual_order ${bin}]: ${combined.reason}. Per-order: ${perJudgeLog}`
            : combined.overall === 'PASS'
                ? `Судья [dual_order ${bin}]: PASS обе перестановки. Per-order: ${perJudgeLog}`
                : `Судья [dual_order ${bin}]: FAIL (${combined.reason}). Per-order: ${perJudgeLog}`;
        return {
            overall: combined.overall,
            dod_results: combined.dodResults,
            comment,
            judge_verdicts: invocations
        };
    }

    // ── L1/L2 single-judge path (unchanged: chain of length 1 + one retry).
    let judged = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        judged = await callExternalJudge({
            workDir: taskDir, systemText, userText, chain: cliChain, model, timeoutMs, role: 'judge'
        });
        if (judged.ok) break;
    }

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

// Встроенный security-оракул: сканирует те же доказательства, что видит судья
// (git diff для кода / артефакты), и пишет рецепт рунга `security`. Turnkey —
// не требует внешнего инструмента.
async function runSecurityRung(taskDir, node) {
    const { evidence } = await gatherEvidence(taskDir, node);
    const scan = scanText(evidence);
    const detail = scan.clean
        ? 'security scan: чисто'
        : 'security: ' + scan.findings.map(f => `${f.desc} (${f.sample})`).join('; ');
    await recordRung(taskDir, node, RUNGS.SECURITY, scan.clean ? 'PASS' : 'FAIL', detail);
    return { clean: scan.clean, findings: scan.findings, detail };
}

async function main() {
    const options = parseArgs();
    if (!options.taskDir || !options.nodeId || !options.type) {
        console.error(JSON.stringify({
            error: 'Использование: node validator.js <task_dir> --node УЗЕЛ-01 --type auto|ai|human [--result PASS|FAIL] [--comment "..."] [--approve] [--reject] [--cmd "..."]'
        }));
        process.exit(1);
    }

    if (!['auto', 'ai', 'human', 'oracle'].includes(options.type)) {
        console.error(JSON.stringify({
            error: `Неизвестный тип: ${options.type}. Допустимые: auto, ai, human, oracle`
        }));
        process.exit(1);
    }

    const state = await readState(options.taskDir);
    const roadmap = await readRoadmap(options.taskDir);
    // ─── Интеграционный оракул (гейт целостности всей задачи) ───
    // `--type oracle --rung integration` прогоняет полную сборку/тесты кодовой
    // базы и пишет task-level рецепт. Не требует конкретного узла — это финальная
    // сверка перед TASK_COMPLETE (loopAdvancer вернёт NEEDS_FINAL_INTEGRATION без неё).
    if (options.type === 'oracle' && options.rung === 'integration') {
        if (options.commands.length === 0) {
            console.error(JSON.stringify({ error: 'integration требует --cmd "<полная сборка/тесты>".' }));
            process.exit(1);
        }
        const trivial = options.commands.find(isTrivialOracleCommand);
        if (trivial) {
            console.error(JSON.stringify({ error: 'TRIVIAL_ORACLE', rejected_cmd: trivial, message: `«${trivial}» не является реальной интеграционной проверкой.` }));
            process.exit(1);
        }
        const auto = await runAutoValidation(options.taskDir, options.commands);
        const detail = auto.results.map(item => item.command ? `${item.command}: ${item.status}` : item.output).join('; ');
        await recordTaskIntegration(options.taskDir, roadmap, auto.overall, detail);
        console.log(JSON.stringify({
            type: 'oracle', rung: 'integration', result: auto.overall, checks: auto.results,
            message: auto.overall === 'PASS'
                ? 'Интеграционный прогон зелёный — задачу можно закрывать (loopAdvancer вернёт TASK_COMPLETE).'
                : 'Интеграция провалена — вся кодовая база не собирается/не проходит тесты вместе. Исправь перед закрытием.'
        }, null, 2));
        process.exit(auto.overall === 'PASS' ? 0 : 1);
    }

    const node = getNode(roadmap, options.nodeId);
    if (!node) {
        console.error(JSON.stringify({ error: `Узел ${options.nodeId} не найден в .harness_roadmap.json` }));
        process.exit(1);
    }

    // ─── Тип `oracle` (Lever 1′): запись рецепта рунга лестницы доказательств ───
    // Прогоняет детерминированную проверку (compile/tests/console_clean/lint) во
    // время работы над узлом и фиксирует рецепт. НЕ меняет стадию/статус узла —
    // это ступень пола, а не сертификация. Пол проверяется позже, в точке PASS.
    // Отвод рунга: `--rung <name> --waive "<причина>"` пишет WAIVED-рецепт для
    // физически непроверяемого headless остатка (честный залогированный клапан).
    if (options.type === 'oracle') {
        const rung = options.rung || RUNGS.TESTS;
        if (options.waive) {
            const rec = await recordRung(options.taskDir, node, rung, 'WAIVED', options.waive);
            console.log(JSON.stringify({
                type: 'oracle', node: node.id, rung, result: 'WAIVED',
                reason: options.waive, iteration: rec.iteration,
                message: `Рунг [${rung}] отведён (WAIVED) с обоснованием. Отвод залогирован и виден судье/человеку.`
            }, null, 2));
            return;
        }
        // Встроенный security-оракул: без --cmd сканируем доказательства сами.
        if (rung === RUNGS.SECURITY && options.commands.length === 0) {
            const sec = await runSecurityRung(options.taskDir, node);
            console.log(JSON.stringify({
                type: 'oracle', node: node.id, rung: 'security', result: sec.clean ? 'PASS' : 'FAIL',
                findings: sec.findings,
                message: sec.clean ? 'Security-скан чист.' : `Security-скан нашёл проблемы: ${sec.detail}. Убери секреты/опасные конструкции.`
            }, null, 2));
            process.exit(sec.clean ? 0 : 1);
        }
        if (options.commands.length === 0) {
            console.error(JSON.stringify({
                error: 'oracle требует --cmd "<команда>" (или --waive "<причина>" для непроверяемого рунга).'
            }));
            process.exit(1);
        }
        // Пол не засчитывает фиктивные no-op команды — иначе зелёная галочка на
        // непроверенном коде. Требуем реальный оракул, трогающий deliverables.
        const trivial = options.commands.find(isTrivialOracleCommand);
        if (trivial) {
            const rec = await recordRung(options.taskDir, node, rung, 'TRIVIAL', `no-op отклонён: ${trivial}`);
            console.error(JSON.stringify({
                error: 'TRIVIAL_ORACLE',
                node: node.id, rung, rejected_cmd: trivial, iteration: rec.iteration,
                message: `Команда «${trivial}» ничего не проверяет и НЕ засчитывается в пол. Дай реальный оракул, прогоняющий deliverables узла (сборка/typecheck/тесты/скриптовый прогон).`
            }));
            process.exit(1);
        }
        const auto = await runAutoValidation(options.taskDir, options.commands);
        const detail = auto.results.map(item =>
            item.command ? `${item.command}: ${item.status}` : item.output).join('; ');
        const rec = await recordRung(options.taskDir, node, rung, auto.overall, detail);
        console.log(JSON.stringify({
            type: 'oracle', node: node.id, rung, result: auto.overall,
            iteration: rec.iteration, checks: auto.results,
            message: auto.overall === 'PASS'
                ? `Рунг [${rung}] зафиксирован зелёным (итерация ${rec.iteration}).`
                : `Рунг [${rung}] провален — исправь и прогони заново перед сертификацией.`
        }, null, 2));
        return;
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

    // ─── ГЕЙТ: самопроверка исполнителя (Lever 4) ───
    // Прежде чем тратить внешнего судью, исполнитель обязан в отчёте оставить
    // раздел ## SELF-REVIEW: для каждого пункта DoD — строка, что его выполняет;
    // ≥3 способа, которыми это может сломаться; результат прогона оракула. Именно
    // здесь чинится «ИИ не проверяла свою работу». Scoped на code-классы, чтобы
    // не мешать текстовым артефактам. Включается HARNESS_REQUIRE_SELFREVIEW=1.
    if (process.env.HARNESS_REQUIRE_SELFREVIEW !== '0' && !options.judgeFile
        && classifyNode(node).startsWith('code.')
        && !(options.type === 'human' && !options.approve && !options.reject)) {
        let reportRaw = '';
        try { reportRaw = await readClean(path.resolve(options.taskDir, 'validation_report.md')); } catch { /* нет отчёта */ }
        const m = reportRaw.match(/##\s*SELF-REVIEW\s*\n+([\s\S]*?)(?:\n---|\n##\s|$)/i);
        const body = m ? m[1].trim() : '';
        // Структурная (не смысловая) проверка качества: ловит отписки вроде
        // «SELF-REVIEW: ok». Требуем содержательность: длину, ≥3 пунктов и
        // упоминание результата оракула (compile/tests/rung/oracle).
        const lineItems = (body.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) || []).length;
        const mentionsOracle = /\b(oracle|оракул|compile|typecheck|tests?|тест|rung|рунг|build|сборк)\b/i.test(body);
        const substantive = body.length >= 100 && lineItems >= 3 && mentionsOracle;
        if (!body || body.includes('ОБЯЗАТЕЛЬНО заполнить') || !substantive) {
            console.error(JSON.stringify({
                error: 'GATE_FAILED',
                gate: 'self_review_required',
                detail: { length: body.length, line_items: lineItems, mentions_oracle: mentionsOracle },
                message: 'Раздел ## SELF-REVIEW не содержателен. Для code-узла нужно: (1) по каждому пункту DoD — строка/файл, что его закрывает; (2) ≥3 конкретных способа, которыми это может сломаться (пунктами); (3) результат прогона оракула по каждому рунгу. Отписка вида «ok» не проходит. (или HARNESS_REQUIRE_SELFREVIEW=0)'
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
            // Lever 1′: штатный детерминированный прогон засчитывается в пол лестницы.
            // No-op команды не засчитываются (TRIVIAL), даже если формально прошли.
            {
                const rr = (auto.overall === 'PASS' && options.commands.some(isTrivialOracleCommand)) ? 'TRIVIAL' : auto.overall;
                await recordRung(options.taskDir, node, options.rung || RUNGS.TESTS, rr, validationComment);
            }
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
                {
                    const rr = (auto.overall === 'PASS' && options.commands.some(isTrivialOracleCommand)) ? 'TRIVIAL' : auto.overall;
                    await recordRung(options.taskDir, node, options.rung || RUNGS.TESTS, rr, validationComment);
                }
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

                // Взвешенная рубрика понижает формальный PASS субагента до FAIL.
                const subRubric = evaluateRubric(verdict.rubric);
                const subPass = verdict.pass && subRubric.ok;
                validationResult = subPass ? 'PASS' : 'FAIL';
                validationComment = subPass
                    ? `Судья [subagent-fallback]: все критерии выполнены.${subRubric.score != null ? ' Рубрика: ' + subRubric.reason + '.' : ''}`
                    : (verdict.pass && !subRubric.ok
                        ? `Судья [subagent-fallback]: DoD формально закрыт, но рубрика отклонила: ${subRubric.reason}`
                        : `Судья [subagent-fallback]: ${(verdict.errors || []).join('; ') || 'критерии не выполнены'}`);

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
                // F5 integrity gate: we prioritize cross-family judges, but if none are
                // live, we allow same-family subagents with clean context as fallback.
                const sel = selectJudge({
                    worker_family: node.worker_family,
                    artifact_kind: node.artifact_kind,
                    criticality: deriveCriticality(node),
                    live_judges: [{ id: 'claude-subagent', family: 'anthropic' }]
                });
                if (sel.decision === 'UNVALIDATED') {
                    const unvComment = `Нет доступных судей: единственный доступный fallback — Claude-субагент (anthropic). ${sel.reason} (probe: ${aiCheck.probe_summary})`;
                    await updateReportVerdict(options.taskDir, 'UNVALIDATED', unvComment);
                    updateRoadmapAfterValidation(roadmap, node, 'UNVALIDATED', unvComment, null);
                    state.stage = 'report_ready';
                    state.validation_type = 'ai';
                    state.validation_result = 'UNVALIDATED';
                    state.current_node = node.id;
                    await writeRoadmap(options.taskDir, roadmap, { syncMarkdown: true });
                    await writeState(options.taskDir, state);
                    console.log(JSON.stringify({
                        type: 'ai',
                        node: node.id,
                        result: 'UNVALIDATED',
                        judge: 'none',
                        reason: sel.reason,
                        probe: aiCheck.probe_summary,
                        message: 'Нет доступных судей (даже для fallback-субагента). Узел НЕ засчитан как PASS (UNVALIDATED). Подключите живого CLI-судью и повторите валидацию.'
                    }, null, 2));
                    return;
                }
                // Субагент — валидный кросс-семейный судья (воркер не Claude): штатный fallback.
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
        // ─── ГЕЙТ: пол лестницы доказательств (Lever 1′) ───────────────────────
        // Ни один code-узел не сертифицируется как PASS, пока обязательные
        // детерминированные рунги (compile/tests/console_clean) не прогнаны
        // зелёными на ТЕКУЩЕЙ итерации. Это ловит «сырое забагованное, которое
        // ИИ даже не запускал»: судья по диффу больше не может подменить оракул,
        // который был обязателен и доступен. Отключается HARNESS_ENFORCE_FLOOR=0.
        let floor = await evaluateFloor(options.taskDir, node);
        // Turnkey security-floor: если рунг security ещё не прогнан на этой итерации,
        // автозапускаем встроенный скан. Чистый код проходит сам; утечка секрета/
        // auth-bypass роняет пол с конкретной находкой.
        if (process.env.HARNESS_ENFORCE_FLOOR !== '0' && floor.enforce && floor.missing.includes(RUNGS.SECURITY)) {
            await runSecurityRung(options.taskDir, node);
            floor = await evaluateFloor(options.taskDir, node);
        }
        if (process.env.HARNESS_ENFORCE_FLOOR !== '0' && floor.enforce && !floor.floorMet) {
            node.dod = node.dod.map(d => ({ ...d, done: false }));
            const delivPart = floor.missing_deliverables.length
                ? ` Отсутствуют/пусты заявленные deliverables: [${floor.missing_deliverables.join(', ')}].` : '';
            node.last_error = `oracle_floor: не хватает рунгов [${floor.missing.join(', ')}]${floor.missing_deliverables.length ? '; deliverables: [' + floor.missing_deliverables.join(', ') + ']' : ''}`;
            const floorMsg = `Пол доказательства не выполнен для класса ${floor.cls}: не хватает зелёных рунгов [${floor.missing.join(', ')}].${delivPart} `
                + `Прогони рунги через: node validator.js <task_dir> --node ${node.id} --type oracle --rung <rung> --cmd "<команда>" `
                + `(или --waive "<причина>" для физически непроверяемого headless остатка), создай недостающие deliverables, затем повтори валидацию.`;
            await updateReportVerdict(options.taskDir, 'FAIL', floorMsg);
            state.stage = 'report_ready';
            state.validation_result = 'FLOOR_UNMET';
            state.current_node = node.id;
            await writeRoadmap(options.taskDir, roadmap, { syncMarkdown: true });
            await writeState(options.taskDir, state);
            console.log(JSON.stringify({
                error: 'GATE_FAILED',
                gate: 'oracle_floor',
                node: node.id,
                artifact_class: floor.cls,
                required: floor.required,
                met: floor.met,
                waived: floor.waived,
                missing: floor.missing,
                missing_deliverables: floor.missing_deliverables,
                message: floorMsg
            }, null, 2));
            // Гейт обязан падать громко (ненулевой код выхода), как остальные
            // GATE_FAILED движка — иначе вызывающая сторона примет блок за успех.
            process.exit(1);
        }
        state.stage = 'validated';
        state.validated_at = new Date().toISOString();
        state.validation_result = 'PASS';
        state.current_node = node.id;
        state.evidence_floor = { class: floor.cls, met: floor.met, waived: floor.waived };
    } else if (validationResult === 'UNVALIDATED') {
        // F5: not a FAIL (the work may be fine) but NOT certified — cannot advance.
        state.stage = 'report_ready';
        state.validation_result = 'UNVALIDATED';
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
