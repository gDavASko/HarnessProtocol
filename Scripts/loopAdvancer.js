import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { findRepoRoot } from './harnessPaths.js';
import { evaluateTaskIntegration } from './evidenceLadder.js';
import {
    readClean,
    readState,
    writeState,
    readRoadmap,
    writeRoadmap,
    getNode,
    getNextPendingNode,
    appendLoopEntry,
    appendWorkLog,
    UTF8_BOM
} from './harnessState.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => rl.question(query, (ans) => {
        rl.close();
        resolve(ans.trim());
    }));
}

async function runSessionLogger(taskDir, roadmap, insight) {
    const loggerPath = path.resolve(__dirname, 'sessionLogger.js');
    const totalIter = roadmap.nodes ? roadmap.nodes.reduce((s, n) => s + (n.iteration || 0), 0) : 0;
    const doneCount = roadmap.nodes ? roadmap.nodes.filter(n => n.status === 'DONE').length : 0;
    const promptArg = `${roadmap.title || 'Без названия'} (${doneCount}/${roadmap.nodes?.length || 0} узлов, ${totalIter} итераций)`;
    const summaryArg = insight || 'Задача решена успешно (подробности — см. детали по узлам ниже)';

    // Collect deliverables from all nodes as a hint for changed files
    const deliverables = [];
    for (const n of (roadmap.nodes || [])) {
        for (const d of (n.deliverables || [])) {
            if (!deliverables.includes(d)) deliverables.push(d);
        }
    }
    const changedFilesArg = deliverables.length > 0 ? deliverables.join(',') : null;

    try {
        console.error(`[loopAdvancer] Запуск sessionLogger.js для сохранения лога сессии...`);
        const args = [
            loggerPath,
            taskDir,
            '--prompt', promptArg,
            '--summary', summaryArg
        ];
        if (changedFilesArg) {
            args.push('--changed-files', changedFilesArg);
        }
        const { stdout } = await execFileAsync('node', args);
        console.error(`[loopAdvancer] Результат логгера: ${stdout.trim()}`);
    } catch (err) {
        console.error(`[loopAdvancer] Ошибка запуска логгера сессий: ${err.message}`);
    }
}


async function distributeRules(rulesContent) {
    try {
        const repoRoot = findRepoRoot();
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
        const block = `\n\n## AI Rules Added on ${timestamp}\n${rulesContent}\n`;

        // 1. Root AGENTS.md
        const rootAgentsPath = path.resolve(repoRoot, 'AGENTS.md');
        try {
            const current = await fs.readFile(rootAgentsPath, 'utf-8');
            await fs.writeFile(rootAgentsPath, UTF8_BOM + current.replace(/^﻿/, '') + block, 'utf-8');
            console.error(`[loopAdvancer] Добавлено в AGENTS.md: ${rootAgentsPath}`);
        } catch (e) {
            console.warn(`[loopAdvancer] Не удалось обновить root AGENTS.md: ${e.message}`);
        }

        // 2. .agents/AGENTS.md
        const agentsAgentsPath = path.resolve(repoRoot, '.agents/AGENTS.md');
        try {
            const current = await fs.readFile(agentsAgentsPath, 'utf-8');
            await fs.writeFile(agentsAgentsPath, UTF8_BOM + current.replace(/^﻿/, '') + block, 'utf-8');
            console.error(`[loopAdvancer] Добавлено в .agents/AGENTS.md: ${agentsAgentsPath}`);
        } catch (e) {
            console.warn(`[loopAdvancer] Не удалось обновить .agents/AGENTS.md: ${e.message}`);
        }

        // 3. .gemini/rules/
        const geminiRulesDir = path.resolve(repoRoot, '.gemini/rules');
        try {
            await fs.mkdir(geminiRulesDir, { recursive: true });
            const rulesFile = path.join(geminiRulesDir, 'continuous_learning.md');
            let existing = '';
            try { existing = await fs.readFile(rulesFile, 'utf-8'); } catch {}
            await fs.writeFile(rulesFile, UTF8_BOM + existing.replace(/^﻿/, '') + block, 'utf-8');
            console.error(`[loopAdvancer] Добавлено в .gemini/rules/continuous_learning.md: ${rulesFile}`);
        } catch (e) {
            console.warn(`[loopAdvancer] Не удалось записать в .gemini/rules: ${e.message}`);
        }

    } catch (err) {
        console.error(`[loopAdvancer] Ошибка при распределении правил: ${err.message}`);
    }
}

async function runContinuousLearning(taskDir) {
    const judgePath = path.resolve(__dirname, 'cli-judge.js');
    const reportPath = path.resolve(taskDir, 'validation_report.md');
    
    try {
        await fs.access(reportPath);
    } catch {
        console.warn(`[loopAdvancer] Файл отчета ${reportPath} не найден. Пропускаем авто-обучение.`);
        return;
    }

    console.error(`[loopAdvancer] Запуск ИИ-судьи для анализа решения...`);
    try {
        const { stdout } = await execFileAsync('node', [
            judgePath,
            '--file', reportPath,
            '--prompt', 'Оцени решение. Если решение качественное, сформулируй новые полезные правила кодирования или правила для ИИ-агента, основываясь на данном решении, в формате markdown, начиная с заголовка "### Рекомендованные правила для ИИ".'
        ]);
        console.error(stdout);

        const ruleMarker = '### Рекомендованные правила для ИИ';
        const markerIndex = stdout.indexOf(ruleMarker);
        if (markerIndex !== -1) {
            const rulesContent = stdout.slice(markerIndex).trim();
            // NEVER auto-append to AGENTS.md or its mirrors (human gate). Proposed
            // rules are staged to a pending file; a human merges them explicitly via
            // `loopAdvancer.js <task_dir> --approve-rules`.
            const taskId = path.basename(taskDir);
            const pendingDir = path.resolve(taskDir, 'pending-rules');
            const pendingPath = path.join(pendingDir, `${taskId}.md`);
            await fs.mkdir(pendingDir, { recursive: true });
            const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
            const block = `\n\n## Proposed on ${stamp}\n${rulesContent}\n`;
            let existing = '';
            try { existing = await fs.readFile(pendingPath, 'utf-8'); } catch {}
            await fs.writeFile(pendingPath, UTF8_BOM + existing.replace(/^﻿/, '') + block, 'utf-8');
            console.error(`[loopAdvancer] Новые правила ПРЕДЛОЖЕНЫ (не применены) → ${pendingPath}. Слить в AGENTS.md вручную: node loopAdvancer.js ${taskDir} --approve-rules`);
        } else {
            console.error("[loopAdvancer] ИИ-судья не предложил новых правил.");
        }
    } catch (err) {
        console.error(`[loopAdvancer] Ошибка при работе ИИ-судьи: ${err.message}`);
    }
}

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const taskDir = args[0];
    const opts = { taskDir, nodeId: null, status: null, insight: null, error: null, approveRules: false };

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--node' && args[i + 1]) opts.nodeId = args[++i];
        if (args[i] === '--status' && args[i + 1]) opts.status = args[++i].toUpperCase();
        if (args[i] === '--insight' && args[i + 1]) opts.insight = args[++i];
        if (args[i] === '--error' && args[i + 1]) opts.error = args[++i];
        if (args[i] === '--approve-rules') opts.approveRules = true;
    }
    return opts;
}

// ─── Реиндексация ────────────────────────────────────────────────────────────

async function runReindex(taskDir) {
    const reindexPath = path.resolve(__dirname, 'reindexTactical.js');
    try {
        await execFileAsync('node', [reindexPath, taskDir]);
    } catch (err) {
        console.warn(`[loopAdvancer] Предупреждение: reindex не удался: ${err.message}`);
    }
}

// ─── Основная логика ─────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs();

    // Human-invoked merge of staged rules into AGENTS.md and mirrors. This is the
    // ONLY path that writes governance files; automatic completion never does.
    if (opts.approveRules) {
        if (!opts.taskDir) {
            console.error(JSON.stringify({ error: 'Использование: node loopAdvancer.js <task_dir> --approve-rules' }));
            process.exit(1);
        }
        const taskId = path.basename(opts.taskDir);
        const pendingPath = path.resolve(opts.taskDir, 'pending-rules', `${taskId}.md`);
        let content;
        try {
            content = (await fs.readFile(pendingPath, 'utf-8')).replace(/^﻿/, '');
        } catch {
            console.error(JSON.stringify({ error: `Нет файла предложенных правил: ${pendingPath}` }));
            process.exit(1);
        }
        await distributeRules(content);
        await fs.unlink(pendingPath).catch(() => {});
        console.log(JSON.stringify({ action: 'RULES_MERGED', from: pendingPath.replace(/\\/g, '/') }, null, 2));
        return;
    }

    if (!opts.taskDir || !opts.nodeId || !opts.status) {
        console.error(JSON.stringify({
            error: 'Использование: node loopAdvancer.js <task_dir> --node УЗЕЛ-01 --status SUCCESS|FAIL [--insight "..."] [--error "..."]'
        }));
        process.exit(1);
    }

    if (!['SUCCESS', 'FAIL'].includes(opts.status)) {
        console.error(JSON.stringify({ error: `Неизвестный статус: ${opts.status}. Допустимые: SUCCESS, FAIL` }));
        process.exit(1);
    }

    // ─── ГЕЙТ: проверка stage ─────────────────────────────────────────────
    const state = await readState(opts.taskDir);
    const isRetryAllowed = opts.status === 'FAIL' && state.stage === 'report_ready';
    if (state.stage !== 'validated' && !isRetryAllowed) {
        console.error(JSON.stringify({
            error: 'GATE_FAILED',
            gate: 'validated',
            current_stage: state.stage || 'None',
            message: 'Узел не прошёл валидацию. Вызовите validator.js перед продвижением.'
        }));
        process.exit(1);
    }

    // ─── Читаем роадмап ───────────────────────────────────────────────────
    const roadmap = await readRoadmap(opts.taskDir);
    const node = getNode(roadmap, opts.nodeId);
    if (!node) {
        console.error(JSON.stringify({ error: `Узел ${opts.nodeId} не найден в роадмапе` }));
        process.exit(1);
    }

    let result;

    if (opts.status === 'SUCCESS') {
        // Успешный шаг
        node.status = 'DONE';
        node.last_error = null;
        node.dod.forEach(d => d.done = true);
        // Capture the compact handoff summary (B2): the insight, bounded to ~300 tokens.
        if (opts.insight) node.summary = String(opts.insight).slice(0, 1200);

        node.history.push({
            iteration: node.iteration,
            result: 'SUCCESS',
            detail: opts.insight || null,
            at: new Date().toISOString()
        });

        // Дописываем виток в Markdown и work log
        await appendLoopEntry(opts.taskDir, node.id, 'SUCCESS', node.iteration, opts.insight);
        await appendWorkLog(opts.taskDir, node.id, 'SUCCESS', opts.insight, node.iteration, node.strategy);

        // Drift-guard: инкремент счётчика закрытых узлов с последней сверки.
        roadmap.nodes_since_sync = (roadmap.nodes_since_sync || 0) + 1;

        // Ищем следующий PENDING узел
        const nextPending = getNextPendingNode(roadmap, node.id);

        // Drift-guard: если накопили sync_interval узлов и работа не окончена —
        // требуем сверку с исходным ТЗ ДО перехода к следующему узлу (мягкая
        // блокировка). Текущий указатель НЕ двигаем, пока syncCheck не разрешит.
        if (nextPending && roadmap.nodes_since_sync >= (roadmap.sync_interval || 4)) {
            result = {
                action: 'SYNC_DUE',
                reason: `Пройдено ${roadmap.nodes_since_sync}/${roadmap.sync_interval} узлов с последней сверки`,
                next_node: { id: nextPending.id, title: nextPending.title },
                instruction: `Выполните: node HarnessProtocol/Scripts/syncCheck.js ${opts.taskDir}`
            };
        } else if (nextPending) {
            nextPending.status = 'IN_PROGRESS';
            roadmap.current_node_id = nextPending.id;

            result = {
                action: 'ADVANCE_TO_NEXT',
                next_node: { id: nextPending.id, title: nextPending.title },
                iteration: 0
            };
        } else {
            // Проверяем, все ли узлы DONE
            const allDone = roadmap.nodes.every(n => n.status === 'DONE');
            if (allDone) {
                // ─── ГЕЙТ: финальная интеграция ───
                // Каждый узел зелён по отдельности — но собирается ли вся кодовая
                // база и проходит ли тесты ВМЕСТЕ? Требуем свежий зелёный
                // интеграционный прогон перед закрытием. Отключается
                // HARNESS_REQUIRE_FINAL_INTEGRATION=0 (напр. для чисто-текстовых задач).
                if (process.env.HARNESS_REQUIRE_FINAL_INTEGRATION !== '0') {
                    const integ = await evaluateTaskIntegration(opts.taskDir, roadmap);
                    if (!integ.ok) {
                        console.log(JSON.stringify({
                            action: 'NEEDS_FINAL_INTEGRATION',
                            reason: integ.reason,
                            instruction: `Прогони финальную интеграцию всей кодовой базы: node HarnessProtocol/Scripts/validator.js ${opts.taskDir} --node __TASK__ --type oracle --rung integration --cmd "<полная сборка+тесты>". Затем повтори loopAdvancer.`
                        }, null, 2));
                        process.exit(0);
                    }
                }

                // Interactive prompt
                const isInteractive = process.stdout.isTTY && process.stdin.isTTY && process.env.CI !== '1';
                if (isInteractive) {
                    const answer = await askQuestion("Я выполнил текущие задачи. Сессия завершена и задача решена успешно? (y/n): ");
                    if (answer.toLowerCase() !== 'y') {
                        console.error("Продвижение отменено пользователем. Сессия продолжается.");
                        process.exit(0);
                    }
                } else {
                    console.error("[loopAdvancer] Обнаружен неинтерактивный режим/CI. Автоматически подтверждаем завершение сессии.");
                }

                roadmap.status = 'DONE';
                roadmap.current_node_id = null;
                roadmap.last_completed_node_id = node.id;
                
                const totalIter = roadmap.nodes.reduce((s, n) => s + n.iteration, 0);
                result = {
                    action: 'TASK_COMPLETE',
                    total_iterations: totalIter,
                    nodes_completed: roadmap.nodes.length
                };

                // Run sessionLogger
                await runSessionLogger(opts.taskDir, roadmap, opts.insight);

                // Call cli-judge.js for continuous learning
                await runContinuousLearning(opts.taskDir);
            } else {
                // Если не все DONE, но PENDING нет
                result = {
                    action: 'ADVANCE_TO_NEXT',
                    next_node: null,
                    note: 'Нет PENDING узлов, но не все DONE. Проверьте роадмап.'
                };
            }
        }
    } else {
        // FAIL
        const newIteration = node.iteration + 1;
        const maxIter = node.max_iterations || 5;

        if (newIteration >= maxIter) {
            // Лимит исчерпан
            node.status = 'CRITICAL_FAIL';
            roadmap.status = 'CRITICAL_FAIL';
            node.iteration = newIteration;
            node.last_error = opts.error || 'Лимит витков исчерпан';
            
            node.history.push({
                iteration: newIteration,
                result: 'FAIL',
                detail: opts.error || 'Лимит витков исчерпан',
                at: new Date().toISOString()
            });

            // Sawtooth Compaction: сжатие 3-х старых записей при накоплении 6
            if (node.history.length >= 6) {
                const toCompact = node.history.slice(0, 3);
                const remaining = node.history.slice(3);
                const summaryDetail = toCompact
                    .map(h => `[Итерация #${h.iteration}] ${h.detail || 'Без логов'}`)
                    .join('; ');
                const compactedEntry = {
                    iteration: toCompact[0].iteration,
                    result: 'FAIL_COMPACTED_SUMMARY',
                    detail: summaryDetail,
                    at: toCompact[toCompact.length - 1].at
                };
                node.history = [compactedEntry, ...remaining];
            }

            await appendLoopEntry(opts.taskDir, node.id, 'FAIL', newIteration, opts.error || 'Лимит витков исчерпан');
            await appendWorkLog(opts.taskDir, node.id, 'CRITICAL_FAIL', opts.error || 'Лимит витков исчерпан', newIteration, node.strategy);

            result = {
                action: 'CRITICAL_FAIL',
                node: node.id,
                iteration: newIteration,
                max: maxIter,
                reason: opts.error || 'Лимит витков исчерпан'
            };
        } else {
            // Инкремент витка, повторный проход
            node.iteration = newIteration;
            node.status = 'IN_PROGRESS';
            node.last_error = opts.error || 'Неизвестная ошибка';
            
            node.history.push({
                iteration: newIteration,
                result: 'FAIL',
                detail: opts.error || 'Неизвестная ошибка',
                at: new Date().toISOString()
            });

            // Sawtooth Compaction: сжатие 3-х старых записей при накоплении 6
            if (node.history.length >= 6) {
                const toCompact = node.history.slice(0, 3);
                const remaining = node.history.slice(3);
                const summaryDetail = toCompact
                    .map(h => `[Итерация #${h.iteration}] ${h.detail || 'Без логов'}`)
                    .join('; ');
                const compactedEntry = {
                    iteration: toCompact[0].iteration,
                    result: 'FAIL_COMPACTED_SUMMARY',
                    detail: summaryDetail,
                    at: toCompact[toCompact.length - 1].at
                };
                node.history = [compactedEntry, ...remaining];
            }

            await appendLoopEntry(opts.taskDir, node.id, 'FAIL', newIteration, opts.error);
            await appendWorkLog(opts.taskDir, node.id, 'FAIL', opts.error, newIteration, node.strategy);

            result = {
                action: 'RETRY',
                node: node.id,
                iteration: newIteration,
                max: maxIter,
                last_error: opts.error
            };
        }
    }

    // Сохраняем roadmap и синхронизируем Markdown
    await writeRoadmap(opts.taskDir, roadmap, { syncMarkdown: true });

    // Обновляем state
    state.stage = 'awaiting_context';
    state.current_node = roadmap.current_node_id;
    state.last_advanced_at = new Date().toISOString();
    state.validation_result = null;
    state.validated_at = null;
    state.report_ready_at = null;
    // Drift-guard: флаг «нужна сверка» блокирует выдачу контекста следующего узла.
    state.sync_due = result.action === 'SYNC_DUE';
    await writeState(opts.taskDir, state);

    // Реиндексация
    await runReindex(opts.taskDir);

    console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
    console.error(JSON.stringify({ error: err.message, stack: err.stack }));
    process.exit(1);
});
