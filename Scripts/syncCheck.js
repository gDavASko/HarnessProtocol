import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { callExternalJudge } from './cliTransport.js';
import { getAvailableJudgeChain, probeSummary } from './aiProbe.js';
import { resolveTaskDir, findRepoRoot } from './harnessPaths.js';
import {
    UTF8_BOM,
    readClean,
    readState,
    writeState,
    readRoadmap,
    writeRoadmap,
    readMasterInfo,
    getNextPendingNode,
    buildPreamble,
    parseCompactDiff
} from './harnessState.js';

// ─── Drift-guard: сверка накопленной реализации с исходным ТЗ ─────────────────
// Вызывается, когда loopAdvancer вернул action=SYNC_DUE (пройдено sync_interval
// узлов). Внешний независимый ИИ-судья сравнивает ТЕКУЩУЮ реализацию с ИСХОДНОЙ
// целью и DoD плана. Мягкая блокировка: при дрейфе агент обязан добавить
// корректирующий узел, иначе контекст следующего узла остаётся заблокирован.
//
// Использование:
//   node syncCheck.js <task_dir> [--force] [--acknowledge] [--comment "..."]
//     --force        выполнить сверку, даже если sync_due не выставлен
//     --acknowledge  подтвердить, что корректирующий узел добавлен → снять блок

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_EVIDENCE_CHARS = 100000;

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { taskDir: args[0], force: false, acknowledge: false, comment: null };
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--force') opts.force = true;
        else if (args[i] === '--acknowledge') opts.acknowledge = true;
        else if (args[i] === '--comment' && args[i + 1]) opts.comment = args[++i];
    }
    return opts;
}

function truncate(text) {
    return text.length <= MAX_EVIDENCE_CHARS
        ? text
        : `${text.slice(0, MAX_EVIDENCE_CHARS)}\n\n...[усечено ${text.length - MAX_EVIDENCE_CHARS} симв.]`;
}

// ИСХОДНЫЕ требования: глобальная цель + заметки человека + план (DoD узлов).
// Only DONE nodes (+ the current node) are in scope: PENDING/future nodes are
// not yet implemented, so including them would flag planned-but-unbuilt work as
// drift (false REQUIRE_CORRECTION on every sync).
async function gatherRequirements(taskDir, roadmap, master) {
    const inScope = roadmap.nodes.filter(n =>
        n.status === 'DONE' || n.id === roadmap.current_node_id
    );
    const dodByNode = inScope.map(n =>
        `• ${n.id} (${n.status}): ${n.title}\n` +
        n.dod.map(d => `    - [${d.done ? 'x' : ' '}] ${d.criterion}`).join('\n')
    ).join('\n');
    return `ГЛОБАЛЬНАЯ ЦЕЛЬ: ${master.title}\n` +
        (master.humanNotes ? `ЗАМЕТКИ ЧЕЛОВЕКА: ${master.humanNotes}\n` : '') +
        `\nПЛАН И КРИТЕРИИ (DoD по узлам):\n${dodByNode}`;
}

// ТЕКУЩАЯ реализация: git diff репозитория + содержимое deliverables закрытых узлов последнего интервала.
async function gatherImplementation(taskDir, roadmap) {
    let evidence = '';
    const repoRoot = findRepoRoot();

    // 1. Собираем deliverables только из закрытых (DONE) узлов последнего интервала сверки.
    const limit = roadmap.nodes_since_sync || roadmap.sync_interval || 4;
    const doneNodes = roadmap.nodes.filter(n => n.status === 'DONE');
    const recentDoneNodes = doneNodes.slice(-limit);

    const allDeliverables = [];
    for (const node of recentDoneNodes) {
        for (const item of node.deliverables || []) {
            const rel = typeof item === 'string' ? item : item.path;
            if (rel) {
                const abs = path.isAbsolute(rel) ? rel : path.resolve(taskDir, rel);
                allDeliverables.push({ path: abs, kind: node.artifact_kind || 'code', nodeId: node.id });
            }
        }
    }

    // 2. Получаем diff измененных отслеживаемых файлов
    try {
        if (allDeliverables.length > 0) {
            const relativePaths = allDeliverables.map(d => path.relative(repoRoot, d.path).replace(/\\/g, '/'));

            // Получаем diff измененных отслеживаемых файлов в сжатом формате
            const { stdout } = await execAsync(`git diff HEAD --submodule=diff -- ${relativePaths.map(p => `"${p}"`).join(' ')}`, {
                cwd: repoRoot,
                maxBuffer: 64 * 1024 * 1024
            });
            const diff = parseCompactDiff(stdout.trim());
            if (diff && diff !== '(нет изменений)') {
                evidence += `=== GIT DIFF (рабочее дерево последних закрытых узлов) ===\n${diff}\n`;
            }

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
                        evidence += `\n=== NEW UNTRACKED FILE ${relPath} ===\n${truncated}\n`;
                    }
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    // 3. Добавляем содержимое текстовых артефактов (только для kind === 'text')
    for (const item of allDeliverables) {
        if (item.kind === 'text') {
            try {
                const content = (await fs.readFile(item.path, 'utf-8')).replace(/^﻿/, '');
                const relPath = path.relative(repoRoot, item.path).replace(/\\/g, '/');
                evidence += `\n=== ТЕКСТОВЫЙ АРТЕФАКТ ${relPath} (${item.nodeId}) ===\n${content}\n`;
                if (evidence.length > MAX_EVIDENCE_CHARS) break;
            } catch { /* нет файла */ }
        }
    }

    return truncate(evidence.trim() || '(изменений/артефактов не обнаружено)');
}

async function advanceAfterSync(taskDir, roadmap, state) {
    roadmap.nodes_since_sync = 0;
    const next = getNextPendingNode(roadmap, roadmap.current_node_id);
    if (next) {
        next.status = 'IN_PROGRESS';
        roadmap.current_node_id = next.id;
    }
    state.sync_due = false;
    state.stage = 'awaiting_context';
    await writeRoadmap(taskDir, roadmap, { syncMarkdown: true });
    await writeState(taskDir, state);
    return next;
}

async function main() {
    const opts = parseArgs();
    const taskDir = resolveTaskDir(opts.taskDir);
    if (!taskDir) {
        console.error(JSON.stringify({ error: 'Использование: node syncCheck.js <task_dir> [--force] [--acknowledge]' }));
        process.exit(1);
    }

    const state = await readState(taskDir);
    const roadmap = await readRoadmap(taskDir);
    const master = await readMasterInfo(taskDir);

    if (!state.sync_due && !opts.force) {
        console.log(JSON.stringify({ action: 'NO_SYNC_DUE', message: 'Сверка не требуется (sync_due=false). Для ручного запуска добавьте --force.' }, null, 2));
        return;
    }

    // Подтверждение корректирующего узла человеком/агентом → снимаем блок.
    // F3(a): the lock only clears if a corrective node was actually ADDED since the
    // drift was raised (roadmap grew past the baseline recorded at REQUIRE_CORRECTION).
    if (opts.acknowledge) {
        const baseline = state.drift_baseline_nodes ?? 0;
        if (state.drift_open && roadmap.nodes.length <= baseline) {
            console.log(JSON.stringify({
                action: 'CORRECTION_MISSING',
                message: `Блок не снят: корректирующий узел не добавлен (узлов было ${baseline}, сейчас ${roadmap.nodes.length}). Добавьте узел через roadmapEdit add-node, затем повторите --acknowledge.`
            }, null, 2));
            return;
        }
        delete state.drift_open;
        delete state.drift_baseline_nodes;
        const next = await advanceAfterSync(taskDir, roadmap, state);
        console.log(JSON.stringify({
            action: 'CONTINUE',
            acknowledged: true,
            next_node: next ? { id: next.id, title: next.title } : null,
            message: 'Корректирующий узел учтён, блок снят, счётчик сброшен.'
        }, null, 2));
        return;
    }

    const requirements = await gatherRequirements(taskDir, roadmap, master);
    const implementation = await gatherImplementation(taskDir, roadmap);

    // F3(c): lean audit prompt — a 1-line role header + only DONE-scope DoD and the
    // git-diff/artifacts delta. The heavy buildPreamble (constraints/rules re-sent on
    // every audit) is intentionally dropped here.
    const systemText = `Ты — независимый аудитор дрейфа реализации. Сравни ТЕКУЩУЮ реализацию с DoD уже ВЫПОЛНЕННЫХ узлов.
F3(b): НЕ считай дрейфом отсутствие функциональности, запланированной в ещё НЕ выполненных (PENDING) узлах — оценивай ТОЛЬКО выполненное.
Поднимай "aligned": false ТОЛЬКО при КОНКРЕТНОМ, УСТРАНИМОМ расхождении выполненной работы с её DoD (тогда обязательно заполни "corrective"). Если конкретных корректирующих действий нет — верни aligned: true.
Верни СТРОГО JSON без markdown:
{
  "aligned": boolean,
  "drift": ["конкретное расхождение", "..."],
  "corrective": ["что сделать корректирующим узлом", "..."]
}`;

    const userText = `=== ИСХОДНЫЕ ТРЕБОВАНИЯ ===\n${requirements}\n\n=== ТЕКУЩАЯ РЕАЛИЗАЦИЯ ===\n${implementation}`;

    // Цепочка аудиторов фильтруется по preflight-опросу (aiProbe.js).
    const { chain, model, probe, fallback } = await getAvailableJudgeChain();
    if (fallback) {
        // Внешних аудиторов нет: блок НЕ снимаем, но даём протокол деградации —
        // сверку проводит независимый субагент, затем человек/агент снимает блок.
        console.log(JSON.stringify({
            action: 'SYNC_SUBAGENT_FALLBACK',
            aligned: null,
            probe: probeSummary(probe),
            message: 'Внешние аудиторы недоступны (preflight). Проведи сверку с исходным ТЗ НЕЗАВИСИМЫМ субагентом со свежим контекстом; при соответствии сними блок: node syncCheck.js <task_dir> --acknowledge --comment "subagent audit: aligned". При дрейфе — добавь корректирующий узел.'
        }, null, 2));
        return;
    }
    const timeoutMs = parseInt(process.env.HARNESS_JUDGE_TIMEOUT_MS, 10) || undefined;
    const judged = await callExternalJudge({ workDir: taskDir, systemText, userText, chain, model, timeoutMs });

    if (!judged.ok) {
        // Судья недоступен: НЕ снимаем блок (безопасная деградация), но и не роняем цикл.
        console.log(JSON.stringify({
            action: 'SYNC_UNAVAILABLE',
            aligned: null,
            message: `Внешний аудитор недоступен: ${(judged.attempts || []).map(a => `${a.bin}:${a.error}`).join(' | ')}. Блок сохранён. Повторите позже или снимите вручную через --acknowledge после ручной сверки.`
        }, null, 2));
        return;
    }

    let verdict;
    try {
        const m = judged.text.match(/\{[\s\S]*\}/);
        verdict = JSON.parse(m ? m[0] : judged.text);
    } catch (err) {
        console.log(JSON.stringify({ action: 'SYNC_UNAVAILABLE', aligned: null, message: `Ответ аудитора [${judged.bin}] не распарсился: ${err.message}` }, null, 2));
        return;
    }

    // Отчёт сверки на диск (для человека и истории).
    const reportPath = path.resolve(taskDir, `sync_report.md`);
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const report = `# Отчёт сверки drift-guard | ${dateStr}\n\n` +
        `**Аудитор:** ${judged.bin} | **Пройдено узлов с последней сверки:** ${roadmap.nodes_since_sync}/${roadmap.sync_interval}\n\n` +
        `**Итог:** ${verdict.aligned ? '✅ Соответствует исходному ТЗ' : '❌ Обнаружен дрейф'}\n\n` +
        (verdict.drift?.length ? `## Расхождения\n${verdict.drift.map(d => `- ${d}`).join('\n')}\n\n` : '') +
        (verdict.corrective?.length ? `## Корректирующие действия\n${verdict.corrective.map(c => `- ${c}`).join('\n')}\n` : '');
    await fs.writeFile(reportPath, UTF8_BOM + report, 'utf-8');

    // F3(a): actionable-or-silent. A finding blocks ONLY if it lists concrete
    // corrective actions; vague/non-actionable "drift" is not raised.
    const actionable = Array.isArray(verdict.corrective)
        && verdict.corrective.filter(c => String(c || '').trim()).length > 0;

    if (verdict.aligned || !actionable) {
        const next = await advanceAfterSync(taskDir, roadmap, state);
        console.log(JSON.stringify({
            action: 'CONTINUE',
            aligned: true,
            auditor: judged.bin,
            suppressed_nonactionable: (!verdict.aligned && !actionable) ? (verdict.drift || []) : undefined,
            next_node: next ? { id: next.id, title: next.title } : null,
            report: reportPath.replace(/\\/g, '/'),
            message: (!verdict.aligned && !actionable)
                ? 'Замечания без конкретных корректирующих действий — не блокируем (F3).'
                : 'Реализация соответствует ТЗ. Блок снят, счётчик сброшен.'
        }, null, 2));
    } else {
        // Actionable drift → hard soft-lock: record the current node count so
        // --acknowledge clears the lock ONLY after a corrective node is added.
        state.drift_baseline_nodes = roadmap.nodes.length;
        state.drift_open = true;
        await writeState(taskDir, state);
        console.log(JSON.stringify({
            action: 'REQUIRE_CORRECTION',
            aligned: false,
            auditor: judged.bin,
            drift: verdict.drift || [],
            corrective: verdict.corrective || [],
            report: reportPath.replace(/\\/g, '/'),
            correction_path: `node roadmapEdit.js ${opts.taskDir} add-node --id <NEW> --title "<fix>" --validation auto ...  ЗАТЕМ  node syncCheck.js ${opts.taskDir} --acknowledge`,
            message: 'Обнаружен УСТРАНИМЫЙ дрейф. Добавьте корректирующий узел, затем --acknowledge (блок не снимется, пока узел не добавлен).'
        }, null, 2));
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error(JSON.stringify({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) }));
    process.exit(1);
});
