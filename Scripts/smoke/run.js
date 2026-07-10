import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectStrategy, executeStrategy } from '../strategyEngine.js';
import { tacticalBase } from '../harnessPaths.js';

// ─── Harness regression smoke suite (Stage D) ────────────────────────────────
// Offline & deterministic: no live LLM calls. Exercises the state-machine
// mechanics that break most often. Each check prints PASS/FAIL; the suite exits
// nonzero if any check fails.
//
//   node smoke/run.js

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRATEGIES = [
    'Prompt Chaining', 'Routing', 'Parallelization', 'Orchestrator-Workers',
    'Map-Reduce', 'LATM / Tool Maker', 'Evaluator-Optimizer'
];
const ENV = { ...process.env, HARNESS_PROBE_SKIP: '1', HARNESS_REQUIRE_SUMMARY: '0', CI: '1' };

// Run a harness script; capture stdout even when it exits nonzero.
function run(script, args) {
    try {
        const out = execFileSync('node', [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: ENV });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
    }
}
function json(out) { try { return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch { return {}; } }

function freshTask(id) {
    const dir = path.join(tacticalBase(), id);
    fs.rmSync(dir, { recursive: true, force: true });
    run('task_initializer.js', [id, `smoke ${id}`]);
    return dir;
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function readRoadmap(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.harness_roadmap.json'), 'utf8')); }

// Drive one FAIL cycle: serve context -> generate report -> advance FAIL.
function failCycle(dir, node, first) {
    run('contextAssembler.js', [dir, '--mode', first ? 'init' : 'step']);
    run('contextAssembler.js', [dir, '--mode', 'validate', '--node', node]);
    return json(run('loopAdvancer.js', [dir, '--node', node, '--status', 'FAIL', '--error', 'smoke-fail']).out);
}

const results = [];
function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── Check 1: all 7 strategies wired (selection + dispatch) ───────────────────
async function check1() {
    const dir = freshTask('__smoke_strat');
    try {
        let msg = '';
        try { await executeStrategy('__invalid__', dir, { dod: [] }, {}); }
        catch (e) { msg = e.message; }
        const dispatchOk = STRATEGIES.every(s => msg.includes(s));
        const sel = await selectStrategy(dir, { dod: [{ criterion: 'do x' }], title: 'x' }, { tools_available: [] });
        const selectOk = STRATEGIES.includes(sel);
        record('1_strategies_wired', dispatchOk && selectOk,
            `dispatch=${dispatchOk} select=${selectOk}(${sel})`);
    } finally { cleanup(dir); }
}

// ── Check 2: RETRY then CRITICAL_FAIL ────────────────────────────────────────
async function check2() {
    const dir = freshTask('__smoke_retry');
    try {
        fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'artifacts', 'x.js'), 'export const x=1;\n');
        run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--kind', 'code', '--validation', 'auto', '--max', '2', '--deliverable', 'artifacts/x.js']);
        const a1 = failCycle(dir, 'УЗЕЛ-01', true).action;
        const a2 = failCycle(dir, 'УЗЕЛ-01', false).action;
        record('2_retry_then_critical_fail', a1 === 'RETRY' && a2 === 'CRITICAL_FAIL', `${a1} -> ${a2}`);
    } finally { cleanup(dir); }
}

// ── Check 3: sawtooth history compaction (>=6 entries) ────────────────────────
async function check3() {
    const dir = freshTask('__smoke_sawtooth');
    try {
        fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'artifacts', 'x.js'), 'export const x=1;\n');
        run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--kind', 'code', '--validation', 'auto', '--max', '20', '--deliverable', 'artifacts/x.js']);
        for (let i = 0; i < 6; i++) failCycle(dir, 'УЗЕЛ-01', i === 0);
        const node = readRoadmap(dir).nodes.find(n => n.id === 'УЗЕЛ-01');
        const compacted = node.history.some(h => h.result === 'FAIL_COMPACTED_SUMMARY');
        record('3_sawtooth_compaction', compacted, `history=${node.history.length} compacted=${compacted}`);
    } finally { cleanup(dir); }
}

// ── Check 4: --judge-file verdict acceptance (subagent fallback) ──────────────
async function check4() {
    const dir = freshTask('__smoke_judgefile');
    try {
        fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'artifacts', 'x.js'), 'export const x=1;\n');
        run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--kind', 'code', '--validation', 'ai', '--deliverable', 'artifacts/x.js']);
        run('contextAssembler.js', [dir, '--mode', 'init']);
        run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);
        // Simulate the state the validator sets when no external judge is alive.
        const st = JSON.parse(fs.readFileSync(path.join(dir, '.harness_state.json'), 'utf8'));
        st.stage = 'awaiting_subagent_validation'; st.validation_type = 'ai'; st.current_node = 'УЗЕЛ-01';
        fs.writeFileSync(path.join(dir, '.harness_state.json'), JSON.stringify(st, null, 2));
        fs.writeFileSync(path.join(dir, 'ai_judge_verdict.json'),
            JSON.stringify({ pass: true, dod_results: [{ index: 0, pass: true }], evidence: ['export const x=1'], errors: [] }));
        const res = json(run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'ai', '--judge-file', 'ai_judge_verdict.json']).out);
        record('4_judge_file_acceptance', res.result === 'PASS' && res.judge === 'subagent_fallback', `result=${res.result} judge=${res.judge}`);
    } finally { cleanup(dir); }
}

async function main() {
    console.log('=== Harness smoke suite ===');
    await check1();
    await check2();
    await check3();
    await check4();
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed.`);
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(err => { console.error('SUITE ERROR:', err.message); process.exit(1); });
