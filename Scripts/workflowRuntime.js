import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runWorkerTurn } from './cliTransport.js';
import { getNode, readRoadmap, writeRoadmap } from './harnessState.js';
import { DEFAULT_WORKFLOW_LIMITS } from './scaleGate.js';
import { resolveTaskDir } from './harnessPaths.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.resolve(scriptDir, '../Workflows/profiles');
// `agy` is enabled only after an explicit user choice and a workspace-scoped
// `read_file(...)` allow rule. Headless mode denies unapproved write requests.
const ALLOWED_BINS = new Set(['claude', 'codex', 'agy']);

export async function runWorkflowProfile({ taskDir, node, bin, dryRun = false, workerTurn = runWorkerTurn }) {
    if (workerTurn !== runWorkerTurn && !dryRun) {
        return { ok: false, status: 'UNSAFE_WORKER_TRANSPORT' };
    }
    const selection = node?.workflow;
    if (!selection || selection.mode !== 'workflow' || !selection.profile) {
        return { ok: false, status: 'WORKFLOW_NOT_SELECTED' };
    }
    if (!ALLOWED_BINS.has(bin)) return { ok: false, status: 'WORKER_BIN_REQUIRED' };

    const profile = await loadProfile(selection.profile);
    if (profile.writes_code) {
        return { ok: false, status: 'WRITE_PHASE_REQUIRES_SEQUENTIAL_IDE_AGENT', profile: profile.name };
    }

    const shards = (node.dod || []).map((item, index) => ({ index: index + 1, criterion: item.criterion }));
    if (shards.length === 0) return { ok: false, status: 'NO_WORKFLOW_SHARDS' };
    if (shards.length > profile.max_workers_per_run) {
        return { ok: false, status: 'WORKER_LIMIT_EXCEEDED', workers: shards.length, max_workers_per_run: profile.max_workers_per_run };
    }
    const phase = profile.worker_phase;
    const phaseTotalBudget = profile.phase_budgets[phase];
    const phaseBudget = Math.floor(phaseTotalBudget / shards.length);
    if (phaseBudget <= 0) return { ok: false, status: 'BUDGET_EXCEEDED', profile: profile.name };

    const runId = `${node.id}:workflow:${Date.now()}`;
    const runDir = path.resolve(taskDir, 'workflow_runs', runId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!dryRun) await fs.mkdir(runDir, { recursive: true });

    const systemText = 'Ты read-only worker. Не изменяй файлы, не выполняй команды записи и верни только проверяемые находки по своему фрагменту.';
    const makeUserText = shard => `Задача: ${node.title}\nФрагмент ${shard.index}: ${shard.criterion}\nВерни findings с путями и доказательствами.`;
    const results = await runLimited(shards, profile.max_concurrent_workers, async shard => {
        const result = await workerTurn({
            taskDir, bin, runId: `${runId}:${shard.index}`, systemText, userText: makeUserText(shard),
            tier: 'cheap', budgetTokens: phaseBudget, dryRun, role: 'worker'
        });
        const shardResult = { shard, ok: Boolean(result.ok), status: result.status || null, estTokens: result.estTokens || 0, text: result.text || null, error: result.error || null };
        if (!dryRun) await fs.writeFile(path.join(runDir, `shard-${shard.index}.json`), JSON.stringify(shardResult, null, 2), 'utf8');
        return shardResult;
    });
    const estimatedTokens = results.reduce((total, item) => total + item.estTokens, 0);
    const status = estimatedTokens > phaseTotalBudget ? 'BUDGET_EXCEEDED'
        : results.every(item => item.ok) ? 'READY_FOR_VALIDATION' : 'PARTIAL_FAILURE';
    const summary = { run_id: runId, profile: profile.name, phase, status, estimated_tokens: estimatedTokens, phase_token_budget: phaseTotalBudget, token_budget: profile.token_budget, results };
    if (!dryRun) await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    return { ok: status === 'READY_FOR_VALIDATION', ...summary, run_dir: dryRun ? null : runDir };
}

export async function runSelectedWorkflow(taskDir, nodeId, bin, dryRun = false) {
    const roadmap = await readRoadmap(taskDir);
    const node = getNode(roadmap, nodeId);
    if (!node) return { ok: false, status: 'NODE_NOT_FOUND' };
    const result = await runWorkflowProfile({ taskDir, node, bin, dryRun });
    if (!dryRun) {
        node.workflow = { ...node.workflow, last_run: { status: result.status, run_id: result.run_id || null, estimated_tokens: result.estimated_tokens || 0 } };
        await writeRoadmap(taskDir, roadmap, { syncMarkdown: true });
    }
    return result;
}

async function loadProfile(name) {
    const raw = await fs.readFile(path.join(profilesDir, `${name}.json`), 'utf8');
    const profile = JSON.parse(raw);
    if (!validateWorkflowProfile(profile, name)) {
        throw new Error(`Некорректный workflow-профиль: ${name}`);
    }
    return profile;
}

export function validateWorkflowProfile(profile, name) {
    const phaseBudgets = profile.phase_budgets && typeof profile.phase_budgets === 'object'
        ? Object.values(profile.phase_budgets) : [];
    const phaseKeys = profile.phase_budgets && typeof profile.phase_budgets === 'object'
        ? Object.keys(profile.phase_budgets) : [];
    const validPhaseBudgets = phaseBudgets.length === profile.phases?.length
        && phaseKeys.length === profile.phases?.length
        && phaseKeys.every(key => profile.phases.includes(key))
        && profile.phases.every(phase => Object.hasOwn(profile.phase_budgets, phase))
        && phaseBudgets.every(value => Number.isInteger(value) && value > 0)
        && phaseBudgets.reduce((sum, value) => sum + value, 0) <= profile.token_budget;
    return !(profile.name !== name || !Array.isArray(profile.phases) || !Array.isArray(profile.allowed_actions)
        || typeof profile.writes_code !== 'boolean' || !Number.isInteger(profile.max_concurrent_workers)
        || !Number.isInteger(profile.max_workers_per_run) || !Number.isInteger(profile.token_budget)
        || profile.max_concurrent_workers < 1 || profile.max_workers_per_run < 1 || profile.token_budget < 1
        || profile.max_concurrent_workers > DEFAULT_WORKFLOW_LIMITS.max_concurrent_workers
        || profile.max_workers_per_run > DEFAULT_WORKFLOW_LIMITS.max_workers_per_run
        || profile.token_budget > DEFAULT_WORKFLOW_LIMITS.token_budget
        || !profile.worker_phase || !profile.phases.includes(profile.worker_phase) || !validPhaseBudgets || !Number.isInteger(profile.phase_budgets[profile.worker_phase])
        || profile.phase_budgets[profile.worker_phase] < 1 || profile.phase_budgets[profile.worker_phase] > profile.token_budget);
}

async function runLimited(items, limit, worker) {
    const output = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            output[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return output;
}

async function main() {
    const [taskArg, flag, nodeId, binFlag, bin, dryFlag] = process.argv.slice(2);
    const taskDir = resolveTaskDir(taskArg);
    if (!taskDir || flag !== '--node' || !nodeId || binFlag !== '--bin' || !bin) {
        throw new Error('Использование: node workflowRuntime.js <task_dir> --node УЗЕЛ-01 --bin claude|agy|codex [--dry-run]');
    }
    console.log(JSON.stringify(await runSelectedWorkflow(taskDir, nodeId, bin, dryFlag === '--dry-run'), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exit(1); });
}
