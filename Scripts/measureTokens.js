import fs from 'fs/promises';
import path from 'path';
import { resolveTaskDir, findRepoRoot } from './harnessPaths.js';
import {
    readMasterInfo,
    readRoadmap,
    parseConstraints,
    parseTools,
    parseLastInsight,
    getCurrentNode,
    getNode,
    fileExists
} from './harnessState.js';
import { getLimits } from './harnessConfig.js';

// ─── Измеритель токеновой экономии contextAssembler ──────────────────────────
// Сравнивает объём контекста, который агент получил бы «наивно» (прочитав все
// L2-файлы), против компактного JSON от contextAssembler (init/step/status).
// Приближение: 1 токен ≈ 4 символа (грубая, но стабильная оценка для сравнения).

const CHARS_PER_TOKEN = 4;

function approxTokens(text) {
    return Math.round((text || '').length / CHARS_PER_TOKEN);
}

// Повторяет полезную нагрузку contextAssembler --mode init без гейтов состояния.
function buildInitPayload({ master, roadmap, constraints, tools, lastInsight }) {
    const current = getCurrentNode(roadmap);
    return {
        mode: 'init',
        task: { id: roadmap.task_id || master.id, title: roadmap.title || master.title, status: roadmap.status || master.status },
        roadmap: roadmap.nodes.map(n => ({ id: n.id, title: n.title, status: n.status })),
        current_node: current ? {
            id: current.id, title: current.title, iteration: current.iteration,
            max_iterations: current.max_iterations, strategy: current.strategy,
            validation_type: current.validation_type, artifact_kind: current.artifact_kind,
            last_error: current.last_error
        } : null,
        dod: current ? current.dod : [],
        constraints_digest: constraints.digest,
        tools_available: tools,
        human_notes: master.humanNotes,
        last_insight: lastInsight
    };
}

function buildStepPayload({ roadmap }) {
    const current = getCurrentNode(roadmap);
    return {
        mode: 'step',
        current_node: current ? { id: current.id, title: current.title, iteration: current.iteration, validation_type: current.validation_type } : null,
        dod: current ? current.dod : [],
        remaining_nodes: roadmap.nodes.filter(n => n.status === 'PENDING' || n.status === 'IN_PROGRESS').length
    };
}

async function readIfExists(filePath) {
    if (await fileExists(filePath)) {
        try { return (await fs.readFile(filePath, 'utf-8')).replace(/^﻿/, ''); }
        catch { return ''; }
    }
    return '';
}

async function measureNaive(taskDir) {
    // Что агент прочитал бы «в лоб» без contextAssembler.
    const files = [
        'tactical_master.md',
        'forks/tactical_ralph_loop.md',
        'forks/tactical_work_log.md',
        'forks/tactical_constraints.md',
        'forks/tactical_tools_registry.md',
        '.harness_roadmap.json'
    ];
    let total = 0;
    const breakdown = [];
    for (const rel of files) {
        const content = await readIfExists(path.resolve(taskDir, rel));
        total += content.length;
        breakdown.push({ file: rel, chars: content.length });
    }
    return { chars: total, breakdown };
}

// ─── Per-node token usage log (B3) ───────────────────────────────────────────
// Appends one record per node execution to the local session-log dir (non-submodule),
// so budgets/tiering can be audited. Best-effort, never throws.
export function usageLogPath() {
    return path.join(findRepoRoot(), '.harness_logs', 'usage.jsonl');
}
export async function recordNodeUsage({ taskId = null, node, tier = null, model = null, estTokens = null, actualTokens = null, status = 'OK', role = 'worker' }) {
    try {
        const file = usageLogPath();
        await fs.mkdir(path.dirname(file), { recursive: true });
        // Phase-2 wiring: per-role budget is sourced from harness.config.json.
        // We tag the record with the budget so audits can see whether a node blew it.
        let budget = null;
        try { budget = getBudgetForRole(role); } catch { /* config broken → no tag */ }
        const rec = { at: new Date().toISOString(), task_id: taskId, node, role, tier, model, est_tokens: estTokens, actual_tokens: actualTokens, budget_tokens: budget, status };
        await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf-8');
        return rec;
    } catch { return null; }
}

/**
 * Phase-2: returns the per-role token budget from harness.config.json. Callers
 * should use this instead of a hard-coded constant so machine-local overrides in
 * harness.config.local.json take effect. Returns null if the config is broken.
 */
export function getBudgetForRole(role = 'worker') {
    const lim = getLimits(role);
    if (lim && Number.isFinite(lim.budget_tokens) && lim.budget_tokens > 0) return lim.budget_tokens;
    return null;
}

function parseRecordArgs(args) {
    const o = { node: null, tier: null, model: null, estTokens: null, actualTokens: null, status: 'OK', taskId: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--node' && args[i + 1]) o.node = args[++i];
        else if (args[i] === '--tier' && args[i + 1]) o.tier = args[++i];
        else if (args[i] === '--model' && args[i + 1]) o.model = args[++i];
        else if (args[i] === '--tokens' && args[i + 1]) o.actualTokens = parseInt(args[++i], 10);
        else if (args[i] === '--est-tokens' && args[i + 1]) o.estTokens = parseInt(args[++i], 10);
        else if (args[i] === '--status' && args[i + 1]) o.status = args[++i];
        else if (args[i] === '--task-id' && args[i + 1]) o.taskId = args[++i];
    }
    return o;
}

async function main() {
    // Record mode: `node measureTokens.js --record --node УЗЕЛ-01 --tier mechanical --tokens 1234`
    if (process.argv.includes('--record')) {
        const rec = await recordNodeUsage(parseRecordArgs(process.argv.slice(2)));
        console.log(JSON.stringify({ recorded: rec, log: usageLogPath().replace(/\\/g, '/') }, null, 2));
        return;
    }

    const taskDir = resolveTaskDir(process.argv[2]);
    if (!taskDir) {
        console.error(JSON.stringify({ error: 'Использование: node measureTokens.js <task_dir> | --record --node <id> --tier <t> --tokens <n>' }));
        process.exit(1);
    }

    const [master, roadmap, constraints, tools, lastInsight] = await Promise.all([
        readMasterInfo(taskDir),
        readRoadmap(taskDir),
        parseConstraints(taskDir),
        parseTools(taskDir),
        parseLastInsight(taskDir)
    ]);

    const initJson = JSON.stringify(buildInitPayload({ master, roadmap, constraints, tools, lastInsight }), null, 2);
    const stepJson = JSON.stringify(buildStepPayload({ roadmap }), null, 2);
    const naive = await measureNaive(taskDir);

    const initTokens = approxTokens(initJson);
    const stepTokens = approxTokens(stepJson);
    const naiveTokens = approxTokens('x'.repeat(naive.chars));

    const savingInit = naiveTokens > 0 ? Math.round((1 - initTokens / naiveTokens) * 100) : 0;
    const savingStep = naiveTokens > 0 ? Math.round((1 - stepTokens / naiveTokens) * 100) : 0;

    const report = {
        task_dir: taskDir.replace(/\\/g, '/'),
        naive_read: { chars: naive.chars, tokens: naiveTokens, breakdown: naive.breakdown },
        context_assembler: {
            init: { chars: initJson.length, tokens: initTokens, saving_vs_naive_percent: savingInit },
            step: { chars: stepJson.length, tokens: stepTokens, saving_vs_naive_percent: savingStep }
        },
        note: `Приближение 1 токен ≈ ${CHARS_PER_TOKEN} символа. Экономия измерена относительно наивного чтения всех L2-файлов.`
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
});
