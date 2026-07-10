import {
    readRoadmap,
    writeRoadmap,
    getNode,
    normalizeNodeId
} from './harnessState.js';
import { resolveTaskDir } from './harnessPaths.js';

// ─── Редактор роадмапа (JSON = источник истины) ──────────────────────────────
// Человек и ИИ-агент правят роадмап ТОЛЬКО через этот CLI. Он изменяет
// .harness_roadmap.json и регенерирует Markdown (одностороннее JSON→MD).
// Ручная правка Markdown в обратную сторону больше не является источником истины.
//
// Использование:
//   node roadmapEdit.js <task_dir> add-node    --id УЗЕЛ-03 --title "..." [--validation ai|auto|human] [--kind code|text] [--strategy X] [--dod "..." ...] [--deliverable path ...]
//   node roadmapEdit.js <task_dir> set-status  --node УЗЕЛ-02 --status PENDING|IN_PROGRESS|DONE|BLOCKED
//   node roadmapEdit.js <task_dir> set-dod     --node УЗЕЛ-02 --dod "..." [--dod "..."]
//   node roadmapEdit.js <task_dir> set-field   --node УЗЕЛ-02 [--validation ai] [--kind text] [--strategy X] [--max 5]
//   node roadmapEdit.js <task_dir> set-current --node УЗЕЛ-02
//   node roadmapEdit.js <task_dir> list

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        taskDir: args[0],
        command: args[1],
        id: null, node: null, title: null, status: null,
        validation: null, kind: null, strategy: null, max: null, syncInterval: null,
        workerFamily: null, tier: null, mode: null,
        dod: [], deliverables: []
    };
    for (let i = 2; i < args.length; i++) {
        const a = args[i];
        if (a === '--id' && args[i + 1]) opts.id = args[++i];
        else if (a === '--node' && args[i + 1]) opts.node = args[++i];
        else if (a === '--title' && args[i + 1]) opts.title = args[++i];
        else if (a === '--status' && args[i + 1]) opts.status = args[++i].toUpperCase();
        else if (a === '--validation' && args[i + 1]) opts.validation = args[++i].toLowerCase();
        else if (a === '--kind' && args[i + 1]) opts.kind = args[++i].toLowerCase();
        else if (a === '--strategy' && args[i + 1]) opts.strategy = args[++i];
        else if (a === '--max' && args[i + 1]) opts.max = parseInt(args[++i], 10);
        else if (a === '--sync-interval' && args[i + 1]) opts.syncInterval = parseInt(args[++i], 10);
        else if (a === '--worker-family' && args[i + 1]) opts.workerFamily = args[++i].toLowerCase();
        else if (a === '--tier' && args[i + 1]) opts.tier = args[++i].toLowerCase();
        else if (a === '--mode' && args[i + 1]) opts.mode = args[++i].toLowerCase();
        else if (a === '--dod' && args[i + 1]) opts.dod.push(args[++i]);
        else if (a === '--deliverable' && args[i + 1]) opts.deliverables.push(args[++i]);
    }
    return opts;
}

function fail(message) {
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
}

async function main() {
    const opts = parseArgs();
    const taskDir = resolveTaskDir(opts.taskDir);
    if (!taskDir || !opts.command) {
        fail('Использование: node roadmapEdit.js <task_dir> <add-node|set-status|set-dod|set-field|set-current|list> [опции]');
    }

    const roadmap = await readRoadmap(taskDir);

    switch (opts.command) {
        case 'add-node': {
            if (!opts.id || !opts.title) fail('add-node требует --id и --title');
            const id = normalizeNodeId(opts.id);
            if (getNode(roadmap, id)) fail(`Узел ${id} уже существует`);
            roadmap.nodes.push({
                id,
                title: opts.title,
                status: 'PENDING',
                iteration: 0,
                max_iterations: opts.max || 5,
                strategy: opts.strategy || 'None',
                // F4: default new nodes to the cheap deterministic path (auto/classic);
                // mark --validation ai / --mode harness explicitly for subjective work.
                validation_type: opts.validation || 'auto',
                mode: opts.mode || null,
                artifact_kind: opts.kind || 'code',
                worker_family: opts.workerFamily || null,
                tier: opts.tier || null,
                deliverables: opts.deliverables,
                dod: opts.dod.length > 0
                    ? opts.dod.map(c => ({ criterion: c, done: false }))
                    : [{ criterion: 'Критерий качества не задан.', done: false }],
                history: []
            });
            break;
        }

        case 'set-status': {
            const node = requireNode(roadmap, opts.node);
            if (!opts.status) fail('set-status требует --status');
            node.status = opts.status;
            break;
        }

        case 'set-dod': {
            const node = requireNode(roadmap, opts.node);
            if (opts.dod.length === 0) fail('set-dod требует хотя бы один --dod');
            node.dod = opts.dod.map(c => ({ criterion: c, done: false }));
            break;
        }

        case 'set-field': {
            const node = requireNode(roadmap, opts.node);
            if (opts.validation) node.validation_type = opts.validation;
            if (opts.kind) node.artifact_kind = opts.kind;
            if (opts.strategy) node.strategy = opts.strategy;
            if (opts.title) node.title = opts.title;
            if (Number.isFinite(opts.max)) node.max_iterations = opts.max;
            if (opts.workerFamily) node.worker_family = opts.workerFamily;
            if (opts.tier) node.tier = opts.tier;
            if (opts.mode) node.mode = opts.mode;
            if (opts.deliverables.length > 0) node.deliverables = opts.deliverables;
            break;
        }

        case 'set-current': {
            const node = requireNode(roadmap, opts.node);
            roadmap.current_node_id = node.id;
            break;
        }

        case 'set-config': {
            if (!Number.isFinite(opts.syncInterval)) fail('set-config требует --sync-interval N (3-5)');
            roadmap.sync_interval = opts.syncInterval;
            break;
        }

        case 'list': {
            console.log(JSON.stringify({
                task_id: roadmap.task_id,
                status: roadmap.status,
                current_node_id: roadmap.current_node_id,
                sync_interval: roadmap.sync_interval,
                nodes_since_sync: roadmap.nodes_since_sync,
                nodes: roadmap.nodes.map(n => ({
                    id: n.id, title: n.title, status: n.status,
                    validation_type: n.validation_type, mode: n.mode, artifact_kind: n.artifact_kind,
                    strategy: n.strategy, dod_count: n.dod.length
                }))
            }, null, 2));
            return;
        }

        default:
            fail(`Неизвестная команда: ${opts.command}`);
    }

    const saved = await writeRoadmap(taskDir, roadmap, { syncMarkdown: true });
    console.log(JSON.stringify({
        status: 'OK',
        command: opts.command,
        nodes: saved.nodes.length,
        current_node_id: saved.current_node_id
    }, null, 2));
}

function requireNode(roadmap, nodeArg) {
    if (!nodeArg) fail('Требуется --node <ID>');
    const node = getNode(roadmap, nodeArg);
    if (!node) fail(`Узел ${nodeArg} не найден в роадмапе`);
    return node;
}

main().catch(err => {
    console.error(JSON.stringify({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) }));
    process.exit(1);
});
