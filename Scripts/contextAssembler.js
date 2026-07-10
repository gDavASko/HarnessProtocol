import fs from 'fs/promises';
import path from 'path';
import {
    UTF8_BOM,
    collectDeliverables,
    getCurrentNode,
    getNode,
    getRoadmapProgress,
    parseConstraints,
    parseLastInsight,
    parseTools,
    readMasterInfo,
    readRoadmap,
    readState,
    writeState
} from './harnessState.js';
import { runProbe, getAvailableJudgeChain, probeSummary } from './aiProbe.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        taskDir: args[0],
        mode: 'init',
        nodeId: null
    };

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--mode' && args[i + 1]) options.mode = args[++i];
        if (args[i] === '--node' && args[i + 1]) options.nodeId = args[++i];
    }

    return options;
}

async function modeInit(taskDir) {
    const [master, roadmap, constraints, tools, lastInsight] = await Promise.all([
        readMasterInfo(taskDir),
        readRoadmap(taskDir),
        parseConstraints(taskDir),
        parseTools(taskDir),
        parseLastInsight(taskDir)
    ]);

    const current = getCurrentNode(roadmap);

    return {
        mode: 'init',
        task: {
            id: roadmap.task_id || master.id,
            title: roadmap.title || master.title,
            status: roadmap.status || master.status
        },
        roadmap: roadmap.nodes.map(node => ({
            id: node.id,
            title: node.title,
            status: node.status,
            ...(node.status === 'IN_PROGRESS' ? { iteration: node.iteration } : {})
        })),
        current_node: toContextNode(current),
        dod: current ? current.dod : [],
        constraints_digest: constraints.digest,
        tools_available: tools,
        human_notes: master.humanNotes,
        last_insight: lastInsight
    };
}

async function modeStep(taskDir) {
    const [roadmap, constraints, lastInsight, state] = await Promise.all([
        readRoadmap(taskDir),
        parseConstraints(taskDir),
        parseLastInsight(taskDir),
        readState(taskDir)
    ]);

    const current = getCurrentNode(roadmap);
    let previousResult = null;

    if (roadmap.last_completed_node_id) {
        const previous = getNode(roadmap, roadmap.last_completed_node_id);
        if (previous) {
            previousResult = {
                node: previous.id,
                status: previous.status,
                insight: lastInsight
            };
        }
    } else if (state.current_node) {
        const previous = getNode(roadmap, state.current_node);
        if (previous) {
            previousResult = {
                node: previous.id,
                status: previous.status,
                insight: lastInsight
            };
        }
    }

    let constraintsChanged = false;
    if (state.constraints_mtime && constraints.mtime) {
        constraintsChanged = state.constraints_mtime !== constraints.mtime;
    }

    return {
        mode: 'step',
        current_node: toContextNode(current),
        dod: current ? current.dod : [],
        previous_result: previousResult,
        // Handoff from DONE nodes = their compact SUMMARYs, not raw artifacts (B2).
        // Full artifacts stay on disk and are pulled only on explicit request.
        done_summaries: doneSummaries(roadmap),
        remaining_nodes: roadmap.nodes.filter(n => n.status === 'PENDING' || n.status === 'IN_PROGRESS').length,
        nodes_since_sync: roadmap.nodes_since_sync || 0,
        sync_interval: roadmap.sync_interval || 4,
        constraints_changed: constraintsChanged,
        ...(constraintsChanged ? { constraints_digest: constraints.digest } : {})
    };
}

// Compact per-node handoff summaries of DONE nodes (bounded), for next-node context.
function doneSummaries(roadmap) {
    return roadmap.nodes
        .filter(n => n.status === 'DONE')
        .slice(-8)
        .map(n => ({
            id: n.id,
            title: n.title,
            summary: n.summary
                ? String(n.summary).slice(0, 400)
                : (n.history?.slice(-1)[0]?.detail
                    ? String(n.history.slice(-1)[0].detail).slice(0, 400)
                    : '(нет summary)')
        }));
}

async function modeStatus(taskDir) {
    const roadmap = await readRoadmap(taskDir);
    const current = getCurrentNode(roadmap);
    const progress = getRoadmapProgress(roadmap);

    return {
        mode: 'status',
        task_id: roadmap.task_id,
        progress: `${progress.done}/${progress.total} (${progress.percent}%)`,
        current_node: current ? `${current.id}: ${current.title}` : 'нет',
        iteration: current ? `${current.iteration}/${current.max_iterations}` : '0/0',
        blockers: progress.blockers,
        total_iterations_spent: progress.totalIterations,
        critical_fails: progress.criticalFails,
        roadmap_source: '.harness_roadmap.json'
    };
}

async function modeValidate(taskDir, nodeId) {
    if (!nodeId) {
        throw new Error('Укажите --node <ID> для режима validate');
    }

    const [roadmap, constraints] = await Promise.all([
        readRoadmap(taskDir),
        parseConstraints(taskDir)
    ]);

    const node = getNode(roadmap, nodeId);
    if (!node) {
        throw new Error(`Узел ${nodeId} не найден в .harness_roadmap.json`);
    }

    const deliverables = await collectDeliverables(taskDir, node);
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const reportPath = path.resolve(taskDir, 'validation_report.md');

    // Source the mandatory SUMMARY (B2): node.summary, else the autonomous
    // engine's result_<id>.md, else empty (executor must fill it before validation).
    let summaryText = node.summary || '';
    if (!summaryText) {
        try {
            const resultRaw = await fs.readFile(path.resolve(taskDir, `result_${node.id}.md`), 'utf-8');
            summaryText = resultRaw.replace(/^﻿/, '').slice(0, 1200);
        } catch { /* no autonomous result file */ }
    }

    const report = buildValidationReport({
        node,
        dateStr,
        constraintsDigest: constraints.digest,
        deliverables,
        summaryText
    });

    await fs.writeFile(reportPath, UTF8_BOM + report, 'utf-8');

    return {
        mode: 'validate',
        report_path: reportPath.replace(/\\/g, '/'),
        node: node.id,
        validation_type: node.validation_type,
        dod_count: node.dod.length,
        deliverables_count: deliverables.length,
        roadmap_source: '.harness_roadmap.json'
    };
}

async function updateStateForContext(taskDir, mode, constraints) {
    const state = await readState(taskDir);
    const roadmap = await readRoadmap(taskDir);
    const current = getCurrentNode(roadmap);
    const now = new Date().toISOString();

    if (mode === 'init' || mode === 'step') {
        state.stage = 'context_served';
        state.context_mode = mode;
        state.context_served_at = now;
        state.current_node = current ? current.id : null;
        if (constraints?.mtime) state.constraints_mtime = constraints.mtime;
    } else if (mode === 'validate') {
        state.stage = 'report_ready';
        state.report_ready_at = now;
        state.current_node = current ? current.id : state.current_node || null;
    }

    await writeState(taskDir, state);
}

const SUMMARY_PLACEHOLDER = '_(ОБЯЗАТЕЛЬНО заполнить: краткое резюме сделанного, ≤300 токенов)_';

function buildValidationReport({ node, dateStr, constraintsDigest, deliverables, summaryText = '' }) {
    const summaryBlock = summaryText && summaryText.trim()
        ? summaryText.trim()
        : SUMMARY_PLACEHOLDER;
    const dodTable = node.dod.map((item, index) =>
        `| ${index + 1} | ${item.criterion} | ${item.done ? '✅' : '❓'} |`
    ).join('\n');

    const deliverablesTable = deliverables.length > 0
        ? deliverables.map(item => {
            const base = path.basename(item.path);
            const timestamp = item.mtime.slice(0, 16).replace('T', ' ');
            return `| [${base}](file:///${item.path.replace(/\\/g, '/')}) | ${timestamp} |`;
        }).join('\n')
        : '| _(артефакты не обнаружены)_ | - |';

    const historyTable = node.history.length > 0
        ? node.history.map(item =>
            `| #${item.iteration} | ${item.result} | ${item.detail || '-'} |`
        ).join('\n')
        : '| _(нет истории)_ | - | - |';

    const constraintLines = constraintsDigest
        ? constraintsDigest.split('; ').map(item => `- ${item}`).join('\n')
        : '- _(не указаны)_';

    return `# Валидационный отчёт | ${node.id}: ${node.title}

**Тип валидации:** \`${node.validation_type}\` | **Виток:** #${node.iteration} | **Дата:** ${dateStr}

---

## SUMMARY

${summaryBlock}

---

## Критерии качества (Definition of Done)

| # | Критерий | Статус |
|:--|:---------|:------:|
${dodTable}

> ✅ выполнено | ❌ не выполнено | ❓ требует проверки

---

## Артефакты

| Файл | Изменён |
|:-----|:--------|
${deliverablesTable}

---

## Ограничения

${constraintLines}

---

## История витков

| Виток | Результат | Причина |
|:------|:----------|:--------|
${historyTable}

---

## Вердикт

> **Заполняется валидатором (ИИ или человек):**
>
> - [ ] PASS — все критерии DoD выполнены
> - [ ] FAIL — указать какие критерии не выполнены
>
> **Комментарий:**
> _..._
`;
}

function toContextNode(node) {
    if (!node) return null;
    return {
        id: node.id,
        title: node.title,
        iteration: node.iteration,
        max_iterations: node.max_iterations,
        strategy: node.strategy,
        validation_type: node.validation_type,
        artifact_kind: node.artifact_kind,
        last_error: node.last_error
    };
}

async function main() {
    const options = parseArgs();
    if (!options.taskDir) {
        console.error(JSON.stringify({
            error: 'Укажите путь к директории задачи. Пример: node contextAssembler.js memory/tactical/TACT-045 --mode init'
        }));
        process.exit(1);
    }

    const validModes = ['init', 'step', 'status', 'validate'];
    if (!validModes.includes(options.mode)) {
        console.error(JSON.stringify({
            error: `Неизвестный режим: ${options.mode}. Допустимые: ${validModes.join(', ')}`
        }));
        process.exit(1);
    }

    try {
        if (options.mode === 'init' || options.mode === 'step') {
            const state = await readState(options.taskDir);
            if (state.stage && state.stage !== 'awaiting_context') {
                console.error(JSON.stringify({
                    error: 'GATE_FAILED',
                    gate: 'awaiting_context',
                    current_stage: state.stage,
                    message: 'Инициализация контекста допускается только из стадии awaiting_context.'
                }));
                process.exit(1);
            }
            // Drift-guard: контекст следующего узла заблокирован до сверки с ТЗ.
            if (state.sync_due) {
                console.error(JSON.stringify({
                    error: 'GATE_FAILED',
                    gate: 'sync_due',
                    message: 'Требуется сверка с исходным ТЗ. Выполните: node syncCheck.js <task_dir>'
                }));
                process.exit(1);
            }
        }

        if (options.mode === 'validate') {
            const state = await readState(options.taskDir);
            if (state.stage && state.stage !== 'context_served') {
                console.error(JSON.stringify({
                    error: 'GATE_FAILED',
                    gate: 'context_served',
                    current_stage: state.stage,
                    message: 'Сначала вызовите contextAssembler.js --mode init или --mode step'
                }));
                process.exit(1);
            }
        }

        let result;
        let constraints = null;

        switch (options.mode) {
            case 'init':
                constraints = await parseConstraints(options.taskDir);
                result = await modeInit(options.taskDir);
                // Preflight: опрос доступности CLI-судей ДО старта цикла, чтобы
                // валидация не висла на мёртвых бинарниках (HARNESS_PROBE_SKIP=1
                // отключает). Результат кэшируется в .harness/ai_probe.json.
                if (process.env.HARNESS_PROBE_SKIP !== '1') {
                    const probe = await runProbe();
                    const judgeInfo = await getAvailableJudgeChain({ autoProbe: false });
                    result.ai_judges = {
                        summary: probeSummary(probe),
                        available: judgeInfo.chain,
                        validation_mode: judgeInfo.fallback ? 'subagent_fallback' : 'external'
                    };
                }
                break;
            case 'step':
                constraints = await parseConstraints(options.taskDir);
                result = await modeStep(options.taskDir);
                break;
            case 'status':
                result = await modeStatus(options.taskDir);
                break;
            case 'validate':
                result = await modeValidate(options.taskDir, options.nodeId);
                break;
        }

        if (options.mode !== 'status') {
            await updateStateForContext(options.taskDir, options.mode, constraints);
        }

        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(JSON.stringify({
            error: error.message,
            stack: error.stack?.split('\n').slice(0, 3)
        }));
        process.exit(1);
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error(JSON.stringify({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) }));
    process.exit(1);
});
