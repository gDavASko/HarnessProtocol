import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { findRepoRoot } from './harnessPaths.js';

// ─── СТРЕСС-ТЕСТ HARNESS PROTOCOL ────────────────────────────────────────────
// Реально прогоняет все механизмы через настоящие скрипты (как это делал бы
// агент), проверяет позитивные и негативные гейты, замеряет токен-политику и
// пишет отчёт о проблемах. Каждый сценарий изолирован в своей задаче.

const execFileAsync = promisify(execFile);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = findRepoRoot();
const NODE = process.execPath;
const TACTICAL = path.join(REPO, 'memory', 'tactical');
const REPORT_PATH = path.join(SCRIPTS, '..', 'STRESS_TEST_REPORT.md');

const findings = [];   // { mechanism, expectation, observed, pass, severity, notes }
const tokenLog = [];   // { phase, payload, chars, tokens }

function tok(text) { return Math.ceil((text || '').length / 4); }
function logToken(phase, payload, text) {
    tokenLog.push({ phase, payload, chars: (text || '').length, tokens: tok(text) });
}
function record(mechanism, expectation, observed, pass, severity = 'MEDIUM', notes = '') {
    findings.push({ mechanism, expectation, observed, pass, severity, notes });
    const icon = pass ? '✅' : '❌';
    console.log(`${icon} [${mechanism}] ${observed}`);
}

async function run(script, args, opts = {}) {
    const scriptPath = path.join(SCRIPTS, script);
    try {
        const { stdout, stderr } = await execFileAsync(NODE, [scriptPath, ...args], {
            cwd: opts.cwd || REPO,
            env: { ...process.env, ...(opts.env || {}) },
            maxBuffer: 32 * 1024 * 1024
        });
        return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' };
    } catch (e) {
        return { ok: false, code: e.code, stdout: e.stdout || '', stderr: e.stderr || '', message: e.message };
    }
}

function parseJson(s) {
    try { const m = (s || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
    catch { return null; }
}

async function initTask(id, title) {
    const dir = path.join(TACTICAL, id);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await run('task_initializer.js', [id, title]);
    return dir;
}

async function readState(dir) {
    try { return JSON.parse((await fs.readFile(path.join(dir, '.harness_state.json'), 'utf-8')).replace(/^﻿/, '')); }
    catch { return {}; }
}

// ─── Сценарий 1: устойчивость путей (запуск из чужого cwd) ────────────────────
async function scPaths() {
    const id = 'TACT-STRESS-PATHS';
    const dir = path.join(TACTICAL, id);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    const foreignCwd = os.tmpdir();
    const res = await run('task_initializer.js', [id, 'Path test'], { cwd: foreignCwd });
    const created = await fs.access(path.join(dir, '.harness_roadmap.json')).then(() => true).catch(() => false);
    record('harnessPaths (чужой cwd)', 'Файлы созданы в repo/memory/tactical независимо от cwd',
        created ? 'Каркас создан в корне репо из tmpdir' : 'Каркас НЕ найден в ожидаемом месте',
        created && res.ok, 'HIGH');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 2: негативные гейты ─────────────────────────────────────────────
async function scGates() {
    const dir = await initTask('TACT-STRESS-GATES', 'Gate test');

    const g1 = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'ai']);
    const g1j = parseJson(g1.stderr) || parseJson(g1.stdout);
    record('Гейт report_ready (validator до контекста)', 'GATE_FAILED gate=report_ready',
        `${g1j?.error}/${g1j?.gate}`, g1j?.error === 'GATE_FAILED' && g1j?.gate === 'report_ready', 'HIGH');

    const g2 = await run('loopAdvancer.js', [dir, '--node', 'УЗЕЛ-01', '--status', 'SUCCESS']);
    const g2j = parseJson(g2.stderr) || parseJson(g2.stdout);
    record('Гейт validated (loopAdvancer до валидации)', 'GATE_FAILED gate=validated',
        `${g2j?.error}/${g2j?.gate}`, g2j?.error === 'GATE_FAILED' && g2j?.gate === 'validated', 'HIGH');

    const c1 = await run('contextAssembler.js', [dir, '--mode', 'init']);
    logToken('gates', 'contextAssembler init', c1.stdout);
    const s1 = await readState(dir);
    record('contextAssembler init → context_served', 'stage=context_served',
        `stage=${s1.stage}`, s1.stage === 'context_served', 'HIGH');

    const c2 = await run('contextAssembler.js', [dir, '--mode', 'init']);
    const c2j = parseJson(c2.stderr) || parseJson(c2.stdout);
    record('Гейт awaiting_context (двойной init)', 'GATE_FAILED gate=awaiting_context',
        `${c2j?.error}/${c2j?.gate}`, c2j?.error === 'GATE_FAILED' && c2j?.gate === 'awaiting_context', 'MEDIUM');

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 3: полный жизненный цикл (auto PASS) + токен-замеры ─────────────
async function scLifecycleAutoPass() {
    const dir = await initTask('TACT-STRESS-LIFE', 'Lifecycle auto pass');
    // Настроим узел-01 как code+auto
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'auto', '--kind', 'code']);

    const init = await run('contextAssembler.js', [dir, '--mode', 'init']);
    logToken('lifecycle', 'contextAssembler init', init.stdout);
    const status = await run('contextAssembler.js', [dir, '--mode', 'status']);
    logToken('lifecycle', 'contextAssembler status', status.stdout);

    const report = await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);
    logToken('lifecycle', 'contextAssembler validate (JSON ответ)', report.stdout);
    const st = await readState(dir);
    record('validate → report_ready', 'stage=report_ready', `stage=${st.stage}`, st.stage === 'report_ready', 'HIGH');

    const passCmd = `${JSON.stringify(NODE)} -e "process.exit(0)"`;
    const val = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'auto', '--cmd', passCmd]);
    logToken('lifecycle', 'validator auto (ответ)', val.stdout);
    const valj = parseJson(val.stdout);
    const st2 = await readState(dir);
    record('validator auto (PASS cmd)', 'overall=PASS, stage=validated',
        `overall=${valj?.overall}, stage=${st2.stage}`, valj?.overall === 'PASS' && st2.stage === 'validated', 'HIGH');

    const adv = await run('loopAdvancer.js', [dir, '--node', 'УЗЕЛ-01', '--status', 'SUCCESS', '--insight', 'stress ok']);
    logToken('lifecycle', 'loopAdvancer (ответ)', adv.stdout);
    const advj = parseJson(adv.stdout);
    record('loopAdvancer SUCCESS (единственный узел)', 'action=TASK_COMPLETE',
        `action=${advj?.action}`, advj?.action === 'TASK_COMPLETE', 'HIGH');

    return dir; // оставим для measureTokens
}

// ─── Сценарий 4: auto FAIL → RETRY → CRITICAL_FAIL ───────────────────────────
async function scCriticalFail() {
    const dir = await initTask('TACT-STRESS-CRIT', 'Critical fail path');
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'auto', '--kind', 'code', '--max', '2']);
    const failCmd = `${JSON.stringify(NODE)} -e "process.exit(1)"`;

    let action = null;
    for (let i = 0; i < 5; i++) {
        await run('contextAssembler.js', [dir, '--mode', 'init']);
        await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);
        await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'auto', '--cmd', failCmd]);
        // auto FAIL оставляет stage report_ready → loopAdvancer FAIL допустим
        const adv = await run('loopAdvancer.js', [dir, '--node', 'УЗЕЛ-01', '--status', 'FAIL', '--error', `fail ${i}`]);
        const advj = parseJson(adv.stdout);
        action = advj?.action;
        if (action === 'CRITICAL_FAIL') break;
    }
    record('Лимит витков → CRITICAL_FAIL', 'action=CRITICAL_FAIL при max_iterations=2',
        `action=${action}`, action === 'CRITICAL_FAIL', 'HIGH');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 5: human approve и reject ──────────────────────────────────────
async function scHuman() {
    const dir = await initTask('TACT-STRESS-HUMAN', 'Human validation');
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'human', '--kind', 'text']);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);

    const req = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'human']);
    const reqj = parseJson(req.stdout);
    const s1 = await readState(dir);
    record('human → awaiting_human_validation', 'status=AWAITING_HUMAN',
        `status=${reqj?.status}, stage=${s1.stage}`, reqj?.status === 'AWAITING_HUMAN' && s1.stage === 'awaiting_human_validation', 'HIGH');

    const rej = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'human', '--reject', '--comment', 'no']);
    const rejj = parseJson(rej.stdout);
    record('human --reject → FAIL', 'result=FAIL',
        `result=${rejj?.result}`, rejj?.result === 'FAIL', 'MEDIUM');

    // повторный запрос и approve
    await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'human']);
    const app = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'human', '--approve', '--comment', 'ok']);
    const appj = parseJson(app.stdout);
    const s2 = await readState(dir);
    record('human --approve → validated', 'result=PASS, stage=validated',
        `result=${appj?.result}, stage=${s2.stage}`, appj?.result === 'PASS' && s2.stage === 'validated', 'HIGH');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 6: гейт структуры субагентов (мультиагентная стратегия) ─────────
async function scSubagentGate() {
    const dir = await initTask('TACT-STRESS-SUB', 'Subagent structure gate');
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'human', '--strategy', 'Orchestrator-Workers']);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);
    await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'human']);
    const app = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'human', '--approve']);
    const j = parseJson(app.stderr) || parseJson(app.stdout);
    record('Гейт subagent_files_check', 'GATE_FAILED gate=subagent_files_check (нет op_memory.json)',
        `${j?.error}/${j?.gate}`, j?.error === 'GATE_FAILED' && j?.gate === 'subagent_files_check', 'MEDIUM');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 7: внешний ИИ-судья (ai) с капнутым таймаутом ───────────────────
async function scAiJudge() {
    const dir = await initTask('TACT-STRESS-AI', 'External AI judge');
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'ai', '--kind', 'text']);
    // создаём deliverable-артефакт, чтобы судье было что оценивать
    await fs.writeFile(path.join(dir, 'artifact.md'), '# Сценарий\nАкт 1. Акт 2 (кульминация). Акт 3.\n', 'utf-8');
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--deliverable', 'artifact.md']);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);

    const t0 = Date.now();
    const val = await run('validator.js', [dir, '--node', 'УЗЕЛ-01', '--type', 'ai'],
        { env: { HARNESS_JUDGE_TIMEOUT_MS: '15000' } });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const j = parseJson(val.stdout);
    logToken('ai-judge', 'validator ai (ответ)', val.stdout);
    const noCrash = !!j && (j.result === 'PASS' || j.result === 'FAIL' || j.action === 'NEEDS_SUBAGENT_JUDGE');
    const enametoolong = /ENAMETOOLONG/i.test(val.stdout + val.stderr);
    record('AI внешний судья (без ENAMETOOLONG)', 'Структурный вердикт PASS/FAIL, без ENAMETOOLONG',
        `result=${j?.result || j?.action} за ${dt}s${enametoolong ? ' (ENAMETOOLONG!)' : ''}; ${(j?.comment || j?.message || '').slice(0, 80)}`,
        noCrash && !enametoolong, 'HIGH',
        (j?.result === 'FAIL' || j?.action === 'NEEDS_SUBAGENT_JUDGE') && /недоступен|недоступны/i.test(j?.comment || j?.message || '') ? 'Внешние CLI недоступны/таймаут — деградация корректна' : '');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 8: оркестратор пропускает code-узел ────────────────────────────
async function scOrchestratorNeedsIde() {
    const dir = await initTask('TACT-STRESS-ORCH', 'Orchestrator code skip');
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--kind', 'code']);
    const res = await run('harness-orchestrator.js', [dir]);
    const out = res.stdout + res.stderr;
    record('Оркестратор: code → NEEDS_IDE_AGENT', 'Выводит NEEDS_IDE_AGENT и останавливается',
        /NEEDS_IDE_AGENT/.test(out) ? 'Оркестратор корректно передал управление IDE-агенту' : 'Оркестратор НЕ распознал code-узел',
        /NEEDS_IDE_AGENT/.test(out), 'HIGH');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 9: bootstrap-guard (JSON = источник, без обратного парсинга) ────
async function scBootstrapGuard() {
    const dir = await initTask('TACT-STRESS-BOOT', 'Bootstrap guard');
    await fs.rm(path.join(dir, '.harness_roadmap.json'), { force: true }).catch(() => {});
    const hsUrl = pathToFileURL(path.join(SCRIPTS, 'harnessState.js')).href;
    const probe = `import(${JSON.stringify(hsUrl)}).then(async m => { const r = await m.readRoadmap(${JSON.stringify(dir)}); console.log(JSON.stringify({nodes:r.nodes.length, first:r.nodes[0].title})); }).catch(e => console.log('ERR', e.message));`;
    // Прямой запуск node -e для проверки поведения readRoadmap с HARNESS_NO_BOOTSTRAP=1
    let out = '';
    try {
        const r = await execFileAsync(NODE, ['--input-type=module', '-e', probe], {
            cwd: REPO, env: { ...process.env, HARNESS_NO_BOOTSTRAP: '1' }, maxBuffer: 8 * 1024 * 1024
        });
        out = r.stdout;
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    const j = parseJson(out);
    const regen = await fs.access(path.join(dir, '.harness_roadmap.json')).then(() => true).catch(() => false);
    record('Bootstrap guard (HARNESS_NO_BOOTSTRAP=1)', 'readRoadmap регенерирует JSON без обратного парсинга Markdown',
        `nodes=${j?.nodes}, json_regenerated=${regen}`, !!j && regen, 'MEDIUM');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 10: roadmapEdit round-trip (JSON→MD) ───────────────────────────
async function scRoadmapEdit() {
    const dir = await initTask('TACT-STRESS-EDIT', 'Roadmap edit');
    await run('roadmapEdit.js', [dir, 'add-node', '--id', 'УЗЕЛ-02', '--title', 'Текстовый узел', '--kind', 'text', '--validation', 'ai', '--dod', 'A', '--dod', 'B']);
    const list = await run('roadmapEdit.js', [dir, 'list']);
    const lj = parseJson(list.stdout);
    const md = await fs.readFile(path.join(dir, 'forks', 'tactical_ralph_loop.md'), 'utf-8');
    const mdHasKind = /artifact_kind:\*\*\s*`text`/.test(md) && /УЗЕЛ-02/.test(md);
    const jsonOk = lj?.nodes?.length === 2 && lj.nodes[1].artifact_kind === 'text';
    record('roadmapEdit round-trip (JSON→MD)', 'JSON обновлён + Markdown регенерирован с artifact_kind',
        `nodes=${lj?.nodes?.length}, md_has_kind=${mdHasKind}`, jsonOk && mdHasKind, 'MEDIUM');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 10b: drift-guard (SYNC_DUE → гейт → acknowledge) ───────────────
async function scDriftGuard() {
    const dir = await initTask('TACT-STRESS-DRIFT', 'Drift guard');
    await run('roadmapEdit.js', [dir, 'set-config', '--sync-interval', '3']);
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'auto', '--kind', 'code']);
    for (const id of ['УЗЕЛ-02', 'УЗЕЛ-03', 'УЗЕЛ-04']) {
        await run('roadmapEdit.js', [dir, 'add-node', '--id', id, '--title', `Узел ${id}`, '--validation', 'auto', '--kind', 'code', '--dod', 'ok']);
    }
    const passCmd = `${JSON.stringify(NODE)} -e "process.exit(0)"`;

    async function driveNode(id) {
        await run('contextAssembler.js', [dir, '--mode', 'init']);
        await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', id]);
        await run('validator.js', [dir, '--node', id, '--type', 'auto', '--cmd', passCmd]);
        const adv = await run('loopAdvancer.js', [dir, '--node', id, '--status', 'SUCCESS', '--insight', 'ok']);
        return parseJson(adv.stdout);
    }

    await driveNode('УЗЕЛ-01');
    await driveNode('УЗЕЛ-02');
    const third = await driveNode('УЗЕЛ-03');
    record('Drift-guard: SYNC_DUE после порога', 'action=SYNC_DUE на 3-м узле (interval=3)',
        `action=${third?.action}`, third?.action === 'SYNC_DUE', 'HIGH');

    const gate = await run('contextAssembler.js', [dir, '--mode', 'init']);
    const gj = parseJson(gate.stderr) || parseJson(gate.stdout);
    record('Drift-guard: гейт sync_due', 'GATE_FAILED gate=sync_due (контекст заблокирован)',
        `${gj?.error}/${gj?.gate}`, gj?.error === 'GATE_FAILED' && gj?.gate === 'sync_due', 'HIGH');

    const ack = await run('syncCheck.js', [dir, '--acknowledge']);
    const aj = parseJson(ack.stdout);
    record('Drift-guard: acknowledge снимает блок', 'action=CONTINUE, переход к следующему узлу',
        `action=${aj?.action}, next=${aj?.next_node?.id}`, aj?.action === 'CONTINUE' && aj?.next_node?.id === 'УЗЕЛ-04', 'HIGH');

    const after = await run('contextAssembler.js', [dir, '--mode', 'init']);
    const okAfter = !!parseJson(after.stdout) && !/GATE_FAILED/.test(after.stderr);
    record('Drift-guard: контекст разблокирован', 'contextAssembler init работает после сверки',
        okAfter ? 'Контекст выдан' : 'Всё ещё заблокирован', okAfter, 'MEDIUM');

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ─── Сценарий 11: selectStrategy — покрытие 7 стратегий ──────────────────────
async function scStrategies() {
    const { selectStrategy } = await import('./strategyEngine.js');
    const base = { constraints_digest: '', tools_available: [], dod: [] };
    const cases = [
        [{ strategy: 'None', title: 'метод', dod: [{ criterion: 'a' }] }, base, 'Prompt Chaining'],
        [{ strategy: 'None', title: 'ui и звук', dod: [{ criterion: 'a' }] }, base, 'Routing'],
        [{ strategy: 'None', title: 'скрипт парсинга', dod: [{ criterion: 'парс' }] }, base, 'LATM / Tool Maker'],
        [{ strategy: 'None', title: 'код', dod: [{ criterion: 'a' }] }, { ...base, tools_available: ['npm test'] }, 'Evaluator-Optimizer'],
        [{ strategy: 'None', title: 'док', dod: [{ criterion: 'a' }, { criterion: 'b' }, { criterion: 'c' }] }, base, 'Parallelization'],
        [{ strategy: 'None', title: 'рефакторинг всех файлов', dod: [{ criterion: 'a' }, { criterion: 'b' }, { criterion: 'c' }] }, base, 'Map-Reduce'],
        [{ strategy: 'None', title: 'сборка', dod: [{ criterion: 'после шага' }, { criterion: 'на основе' }, { criterion: 'c' }] }, base, 'Orchestrator-Workers']
    ];
    let ok = 0;
    for (const [node, ctx, exp] of cases) {
        const got = await selectStrategy('', node, ctx);
        if (got === exp) ok++;
        else console.log(`   ⚠️ selectStrategy: '${node.title}' → ${got}, ожидалось ${exp}`);
    }
    record('selectStrategy (7 стратегий)', 'Все 7 маппингов детерминированы',
        `${ok}/7 совпало`, ok === 7, 'MEDIUM');
}

// ─── Сценарий 12: транспорт — большой payload не даёт ENAMETOOLONG ────────────
async function scTransport() {
    const { runCliModel, isBinLikelyAvailable } = await import('./cliTransport.js');
    const HUGE = 'diff\n+' + 'x'.repeat(400000);
    let bad = false, tested = 0;
    for (const bin of ['codex', 'agy']) {
        if (!isBinLikelyAvailable(bin)) continue;
        tested++;
        const res = await runCliModel({ bin, workDir: REPO, systemText: 'judge', userText: HUGE, timeoutMs: 5000 });
        if (/ENAMETOOLONG|E2BIG/i.test(res.error || '')) bad = true;
    }
    record('CLI-транспорт: большой payload', 'Нет ENAMETOOLONG (контент вне argv)',
        `проверено бинарников: ${tested}, ENAMETOOLONG=${bad}`, !bad, 'HIGH',
        tested === 0 ? 'CLI не установлены — регрессия argv не проверена вживую' : '');
}

// ─── Сценарий 13: measureTokens на реальной задаче ───────────────────────────
async function scMeasure(lifecycleDir) {
    const res = await run('measureTokens.js', [lifecycleDir]);
    const j = parseJson(res.stdout);
    if (j) {
        tokenLog.push({ phase: 'measure', payload: 'naive_read_all_L2', chars: j.naive_read.chars, tokens: j.naive_read.tokens });
        tokenLog.push({ phase: 'measure', payload: 'assembler_init', chars: j.context_assembler.init.chars, tokens: j.context_assembler.init.tokens });
        tokenLog.push({ phase: 'measure', payload: 'assembler_step', chars: j.context_assembler.step.chars, tokens: j.context_assembler.step.tokens });
    }
    record('measureTokens', 'Отчёт экономии сгенерирован',
        j ? `init экономия ${j.context_assembler.init.saving_vs_naive_percent}%, step ${j.context_assembler.step.saving_vs_naive_percent}%` : 'нет отчёта',
        !!j, 'LOW');
    return j;
}

// ─── Отчёт ───────────────────────────────────────────────────────────────────
async function writeReport(measure) {
    const passed = findings.filter(f => f.pass).length;
    const failed = findings.filter(f => !f.pass);
    const totalHarnessTokens = tokenLog.filter(t => t.phase === 'lifecycle').reduce((s, t) => s + t.tokens, 0);

    const lines = [];
    lines.push('# Отчёт стресс-теста Harness Protocol');
    lines.push('');
    lines.push(`**Дата:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')}  `);
    lines.push(`**Результат:** ${passed}/${findings.length} проверок пройдено, ${failed.length} проблем.`);
    lines.push('');
    lines.push('## 1. Покрытие механизмов');
    lines.push('');
    lines.push('| Механизм | Ожидание | Наблюдение | Итог | Важность |');
    lines.push('|:---------|:---------|:-----------|:----:|:--------:|');
    for (const f of findings) {
        lines.push(`| ${f.mechanism} | ${f.expectation} | ${f.observed} | ${f.pass ? '✅' : '❌'} | ${f.severity} |`);
    }
    lines.push('');
    lines.push('## 2. Проблемы (к решению)');
    lines.push('');
    if (failed.length === 0) {
        lines.push('_Проблем не выявлено — все механизмы отработали как ожидалось._');
    } else {
        for (const f of failed) {
            lines.push(`- **[${f.severity}] ${f.mechanism}** — ожидалось: ${f.expectation}; получено: ${f.observed}. ${f.notes || ''}`);
        }
    }
    lines.push('');
    lines.push('### Примечания (деградации/оговорки)');
    const notes = findings.filter(f => f.pass && f.notes);
    if (notes.length === 0) lines.push('_нет_');
    else for (const f of notes) lines.push(`- **${f.mechanism}:** ${f.notes}`);
    lines.push('');
    lines.push('## 3. Токен-политика (замеры)');
    lines.push('');
    lines.push('Приближение: 1 токен ≈ 4 символа. Замеры — реальные размеры полезной нагрузки, которую агент получает от скриптов.');
    lines.push('');
    lines.push('| Фаза | Полезная нагрузка | Символы | ≈ Токены |');
    lines.push('|:-----|:------------------|--------:|---------:|');
    for (const t of tokenLog) {
        lines.push(`| ${t.phase} | ${t.payload} | ${t.chars} | ${t.tokens} |`);
    }
    lines.push('');
    lines.push(`**Суммарно за жизненный цикл узла (harness-served):** ~${totalHarnessTokens} токенов.`);
    if (measure) {
        const naive = measure.naive_read.tokens;
        lines.push(`**Наивное чтение всех L2 (один раз):** ~${naive} токенов.`);
        lines.push(`**Экономия contextAssembler:** init ${measure.context_assembler.init.saving_vs_naive_percent}%, step ${measure.context_assembler.step.saving_vs_naive_percent}%.`);
        lines.push('');
        lines.push('**Вывод по экономии:** агент, ведущий цикл через harness (init один раз + step на узел + компактные ответы валидатора/loopAdvancer), тратит на контекст на порядок меньше, чем при наивном перечитывании всех L2-файлов на каждом шаге.');
    }
    lines.push('');
    lines.push('## 4. Рекомендации');
    lines.push('');
    // Кандидаты на оптимизацию — только реальные harness-нагрузки (не наивный baseline).
    const big = tokenLog.filter(t => t.phase !== 'measure' && t.tokens > 400).sort((a, b) => b.tokens - a.tokens);
    if (big.length > 0) {
        lines.push('Нагрузки-кандидаты на оптимизацию (>400 токенов на вызов):');
        for (const t of big) lines.push(`- \`${t.payload}\` (${t.phase}): ~${t.tokens} токенов`);
    } else {
        lines.push('- Все полезные нагрузки укладываются в бюджет (<400 токенов на вызов). Дополнительная оптимизация не требуется.');
    }
    if (failed.length > 0) {
        lines.push('');
        lines.push('Приоритет починки — проблемы с важностью HIGH из раздела 2.');
    }
    lines.push('');

    await fs.writeFile(REPORT_PATH, '﻿' + lines.join('\n'), 'utf-8');
    console.log(`\n📄 Отчёт: ${path.resolve(REPORT_PATH)}`);
    console.log(`Итог: ${passed}/${findings.length} пройдено, ${failed.length} проблем.`);
}

async function main() {
    console.log('=== СТРЕСС-ТЕСТ HARNESS PROTOCOL ===\n');
    await scPaths();
    await scGates();
    const lifeDir = await scLifecycleAutoPass();
    await scCriticalFail();
    await scHuman();
    await scSubagentGate();
    await scAiJudge();
    await scOrchestratorNeedsIde();
    await scBootstrapGuard();
    await scRoadmapEdit();
    await scDriftGuard();
    await scStrategies();
    await scTransport();
    const measure = await scMeasure(lifeDir);
    await writeReport(measure);
    // финальная чистка
    await fs.rm(lifeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(REPO, '.harness_tmp'), { recursive: true, force: true }).catch(() => {});
}

main().catch(err => { console.error('Стресс-тест упал:', err); process.exit(1); });
