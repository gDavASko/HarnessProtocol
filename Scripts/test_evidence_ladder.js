// ─────────────────────────────────────────────────────────────────────────────
// Evidence Ladder eval (Levers 1′–4). 10 сценариев; последние 3 — комплексные
// многоузловые сборки мини-приложений через полную машину состояний харнеса с
// РЕАЛЬНЫМИ файлами и РЕАЛЬНЫМИ оракулами. Цель — нагрузить новую логику: пол
// доказательства, классы артефактов, свежесть рецептов, ratchet, состязательный
// судья. Тест герметичен: пишет только в .harness_tmp/eval, чистит за собой.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import {
    classifyNode, requiredRungs, evaluateFloor, recordRung, floorEnforced
} from './evidenceLadder.js';

const execFileAsync = promisify(execFile);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, '..');
const EVAL_BASE = path.join(ROOT, '.harness_tmp', 'eval', 'tac');

process.env.TACTICAL_DIR = EVAL_BASE;
process.env.HARNESS_PROBE_SKIP = '1';
process.env.HARNESS_REQUIRE_SUMMARY = '0';
// Тест драйвит машину состояний/лестницу, а не живого исполнителя прозы —
// self-review-гейт (требующий заполненной ## SELF-REVIEW) здесь выключен.
process.env.HARNESS_REQUIRE_SELFREVIEW = '0';

let PASS = 0, FAIL = 0;
const fails = [];
function ok(name) { PASS++; console.log(`  ✅ ${name}`); }
function bad(name, detail) { FAIL++; fails.push(name); console.log(`  ❌ ${name}\n      → ${detail}`); }
function check(name, cond, detail = '') { cond ? ok(name) : bad(name, detail || 'assertion false'); }

async function run(script, args, envOverride = null) {
    const opts = { maxBuffer: 32 * 1024 * 1024 };
    if (envOverride) opts.env = { ...process.env, ...envOverride };
    try {
        const { stdout } = await execFileAsync('node', [path.join(SCRIPTS, script), ...args], opts);
        let data = null; try { data = JSON.parse(stdout.trim()); } catch { /* non-json */ }
        return { success: true, data, raw: stdout };
    } catch (e) {
        let data = null; try { data = JSON.parse((e.stdout || e.stderr || '').trim()); } catch { /* */ }
        return { success: false, data, raw: e.stdout || e.stderr || e.message };
    }
}
async function readState(dir) { return JSON.parse((await fs.readFile(path.join(dir, '.harness_state.json'), 'utf-8')).replace(/^﻿/, '')); }
async function readRoadmap(dir) { return JSON.parse((await fs.readFile(path.join(dir, '.harness_roadmap.json'), 'utf-8')).replace(/^﻿/, '')); }

// Разворачивает задачу, доводит первый узел до стадии report_ready.
async function setupNode(id, { kind = 'code', cls = null, validation = 'ai' } = {}) {
    const dir = path.join(EVAL_BASE, id);
    await fs.rm(dir, { recursive: true, force: true });
    await run('task_initializer.js', [id, `eval ${id}`]);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    const N = 'УЗЕЛ-01';
    const fieldArgs = [dir, 'set-field', '--node', N, '--validation', validation, '--kind', kind];
    if (cls) fieldArgs.push('--class', cls);
    await run('roadmapEdit.js', fieldArgs);
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', N]);
    return { dir, N };
}
async function armHuman(dir, N) { await run('validator.js', [dir, '--node', N, '--type', 'human']); }
async function approve(dir, N) { return run('validator.js', [dir, '--node', N, '--type', 'human', '--approve', '--comment', 'ok']); }
async function oracle(dir, N, rung, cmd) { return run('validator.js', [dir, '--node', N, '--type', 'oracle', '--rung', rung, '--cmd', cmd]); }
async function waive(dir, N, rung, reason) { return run('validator.js', [dir, '--node', N, '--type', 'oracle', '--rung', rung, '--waive', reason]); }

const wsFile = (dir, rel) => path.join(dir, rel);
async function writeWs(dir, rel, content) {
    const p = wsFile(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf-8');
}
// Реальный (не-тривиальный) оракул: настоящий файл + команды, прогоняющие его.
const REAL = {
    compile: 'node --check workspace/ok.mjs',
    tests: 'node workspace/ok.test.mjs',
    console_clean: 'node workspace/ok.mjs'
};
async function writeRealOracle(dir) {
    await writeWs(dir, 'workspace/ok.mjs', `export const ok=()=>42;\nif(process.argv[1]&&process.argv[1].endsWith('ok.mjs'))console.log('SIM OK');\n`);
    await writeWs(dir, 'workspace/ok.test.mjs', `import {ok} from './ok.mjs';\nif(ok()!==42)throw new Error('ok');\nconsole.log('tests ok');\n`);
}

// ═════════════════════════════════════════════════════════════════════════════
async function scenario1_classify() {
    console.log('\n[1] Классификация узла по классу артефакта (unit)');
    check('code → code.testable', classifyNode({ artifact_kind: 'code' }) === 'code.testable');
    check('text → text', classifyNode({ artifact_kind: 'text' }) === 'text');
    check('явный code.behavioral сохраняется', classifyNode({ artifact_kind: 'code', artifact_class: 'code.behavioral' }) === 'code.behavioral');
    check('дефолт (пусто) → code.testable', classifyNode({}) === 'code.testable');
}

async function scenario2_policy() {
    console.log('\n[2] Обязательные рунги пола по классу (unit)');
    check('code.testable = compile+tests+security', JSON.stringify(requiredRungs('code.testable')) === JSON.stringify(['compile', 'tests', 'security']));
    check('code.behavioral = compile+console_clean+tests+security', JSON.stringify(requiredRungs('code.behavioral')) === JSON.stringify(['compile', 'console_clean', 'tests', 'security']));
    check('text = пол не энфорсится', floorEnforced('text') === false && requiredRungs('text').length === 0);
}

async function scenario3_stale() {
    console.log('\n[3] Свежесть рецептов: смена итерации протухляет пол (unit)');
    const id = 'EV-STALE'; const dir = path.join(EVAL_BASE, id);
    await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
    const node = { id: 'УЗЕЛ-01', artifact_kind: 'code', iteration: 0 };
    await recordRung(dir, node, 'compile', 'PASS');
    await recordRung(dir, node, 'tests', 'PASS');
    await recordRung(dir, node, 'security', 'PASS');
    let f = await evaluateFloor(dir, node);
    check('iter0: пол выполнен', f.floorMet === true, JSON.stringify(f));
    node.iteration = 1; // работа изменилась после ретрая
    f = await evaluateFloor(dir, node);
    check('iter1: рецепты протухли → пол НЕ выполнен', f.floorMet === false && f.missing.length === 3, JSON.stringify(f));
}

async function scenario4_waive() {
    console.log('\n[4] WAIVED-рунг засчитывается как met, но виден в аудите (unit)');
    const id = 'EV-WAIVE'; const dir = path.join(EVAL_BASE, id);
    await fs.rm(dir, { recursive: true, force: true }); await fs.mkdir(dir, { recursive: true });
    const node = { id: 'УЗЕЛ-01', artifact_kind: 'code', artifact_class: 'code.behavioral', iteration: 0 };
    await recordRung(dir, node, 'compile', 'PASS');
    await recordRung(dir, node, 'tests', 'PASS');
    await recordRung(dir, node, 'security', 'PASS');
    await recordRung(dir, node, 'console_clean', 'WAIVED', 'чисто-визуальный слой, headless не проверяется');
    const f = await evaluateFloor(dir, node);
    check('пол выполнен через waiver', f.floorMet === true, JSON.stringify(f));
    check('waiver залогирован (аудит)', f.waived.includes('console_clean'), JSON.stringify(f.waived));
}

async function scenario5_floorGate() {
    console.log('\n[5] E2E: code-узел — сертификация блокируется без оракула, проходит с ним');
    const { dir, N } = await setupNode('EV-FLOOR', { kind: 'code', validation: 'ai' });
    await writeRealOracle(dir);
    await armHuman(dir, N);
    const blocked = await approve(dir, N);
    check('approve без оракула → GATE_FAILED oracle_floor',
        !blocked.success && blocked.data?.gate === 'oracle_floor', blocked.raw?.slice(0, 200));
    check('стадия осталась report_ready (не сертифицировано)', (await readState(dir)).stage === 'report_ready');
    await oracle(dir, N, 'compile', REAL.compile);
    await oracle(dir, N, 'tests', REAL.tests);
    await armHuman(dir, N);
    const passed = await approve(dir, N);
    check('approve с зелёными рунгами → PASS', passed.success && passed.data?.result === 'PASS', passed.raw?.slice(0, 200));
    check('стадия стала validated', (await readState(dir)).stage === 'validated');
}

async function scenario6_behavioral() {
    console.log('\n[6] E2E: behavioral-узел требует ВСЕ 3 рунга (compile/console_clean/tests)');
    const { dir, N } = await setupNode('EV-BEHAV', { kind: 'code', cls: 'code.behavioral', validation: 'ai' });
    await writeRealOracle(dir);
    await oracle(dir, N, 'compile', REAL.compile);
    await oracle(dir, N, 'tests', REAL.tests);
    await armHuman(dir, N);
    const partial = await approve(dir, N);
    check('без console_clean → всё ещё блок',
        !partial.success && partial.data?.gate === 'oracle_floor' && partial.data?.missing?.includes('console_clean'),
        partial.raw?.slice(0, 200));
    await oracle(dir, N, 'console_clean', REAL.console_clean);
    await armHuman(dir, N);
    const full = await approve(dir, N);
    check('со всеми 3 рунгами → PASS', full.success && full.data?.result === 'PASS', full.raw?.slice(0, 200));
}

async function scenario7_text() {
    console.log('\n[7] E2E: text-узел — детерминированный пол не энфорсится (судья главный)');
    const { dir, N } = await setupNode('EV-TEXT', { kind: 'text', validation: 'human' });
    await armHuman(dir, N);
    const passed = await approve(dir, N);
    check('text approve БЕЗ оракула → PASS (пол пуст)', passed.success && passed.data?.result === 'PASS', passed.raw?.slice(0, 200));
}

// ── Комплекс A: CLI-калькулятор. Оракул (tests) ловит внедрённый баг → фикс → pass.
async function complexA() {
    console.log('\n[8] КОМПЛЕКС A: модуль-калькулятор — оракул ловит баг, ratchet-фикс, затем PASS');
    const { dir, N } = await setupNode('APP-A', { kind: 'code', validation: 'ai' });
    // Баг: деление на ноль возвращает Infinity вместо выброса.
    await writeWs(dir, 'workspace/calc.js', `export const add=(a,b)=>a+b;\nexport const div=(a,b)=>a/b;\n`);
    await writeWs(dir, 'workspace/test.mjs', `import {add,div} from './calc.js';\nif(add(2,3)!==5)throw new Error('add');\nlet threw=false;try{div(1,0);}catch{threw=true;}\nif(!threw)throw new Error('div by zero must throw');\nconsole.log('ok');\n`);
    await oracle(dir, N, 'compile', 'node --check workspace/calc.js');
    const buggy = await oracle(dir, N, 'tests', 'node workspace/test.mjs');
    check('оракул tests ловит баг (FAIL)', buggy.data?.result === 'FAIL', buggy.raw?.slice(0, 160));
    await armHuman(dir, N);
    const blocked = await approve(dir, N);
    check('сертификация заблокирована (tests не зелёный)',
        !blocked.success && blocked.data?.missing?.includes('tests'), blocked.raw?.slice(0, 160));
    // Ratchet: фиксируем баг + добавляем защищающий критерий.
    await run('roadmapEdit.js', [dir, 'add-dod', '--node', N, '--dod', 'div на ноль выбрасывает ошибку']);
    await writeWs(dir, 'workspace/calc.js', `export const add=(a,b)=>a+b;\nexport const div=(a,b)=>{if(b===0)throw new Error('div by zero');return a/b;};\n`);
    const fixed = await oracle(dir, N, 'tests', 'node workspace/test.mjs');
    check('после фикса оракул tests зелёный', fixed.data?.result === 'PASS', fixed.raw?.slice(0, 160));
    await armHuman(dir, N);
    const passed = await approve(dir, N);
    check('узел сертифицирован после реального зелёного прогона', passed.data?.result === 'PASS', passed.raw?.slice(0, 160));
    const rm = await readRoadmap(dir);
    check('ratchet: критерий DoD добавлен (не затёрт)', rm.nodes[0].dod.length >= 2, `dod=${rm.nodes[0].dod.length}`);
}

// ── Комплекс B: многоузловая сборка (2 узла), floor на каждом узле.
async function complexB() {
    console.log('\n[9] КОМПЛЕКС B: многоузловое приложение (TTL-хранилище) — floor держит каждый узел');
    const id = 'APP-B'; const dir = path.join(EVAL_BASE, id);
    await fs.rm(dir, { recursive: true, force: true });
    await run('task_initializer.js', [id, 'ttl kv store']);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    // Узел 1 (движок) — код; узел 2 (доки) — текст.
    await run('roadmapEdit.js', [dir, 'set-field', '--node', 'УЗЕЛ-01', '--validation', 'ai', '--kind', 'code']);
    await run('roadmapEdit.js', [dir, 'add-node', '--id', 'NODE-02', '--title', 'docs', '--validation', 'human', '--kind', 'text', '--dod', 'README описывает API']);
    await writeWs(dir, 'workspace/store.mjs', `export class Store{constructor(){this.m=new Map();}set(k,v,ttl){this.m.set(k,{v,exp:Date.now()+ttl});}get(k){const e=this.m.get(k);if(!e)return null;if(Date.now()>e.exp){this.m.delete(k);return null;}return e.v;}}\n`);
    await writeWs(dir, 'workspace/store.test.mjs', `import {Store} from './store.mjs';const s=new Store();s.set('a',1,10000);if(s.get('a')!==1)throw new Error('get');s.set('b',2,-1);if(s.get('b')!==null)throw new Error('ttl expiry');console.log('ok');\n`);
    // Узел 1: работа → отчёт → оракулы → сертификация.
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'УЗЕЛ-01']);
    await oracle(dir, 'УЗЕЛ-01', 'compile', 'node --check workspace/store.mjs');
    await oracle(dir, 'УЗЕЛ-01', 'tests', 'node workspace/store.test.mjs');
    await armHuman(dir, 'УЗЕЛ-01');
    const n1 = await approve(dir, 'УЗЕЛ-01');
    check('узел-1 (code) сертифицирован с реальным оракулом', n1.data?.result === 'PASS', n1.raw?.slice(0, 160));
    await run('loopAdvancer.js', [dir, '--node', 'УЗЕЛ-01', '--status', 'SUCCESS', '--insight', 'TTL store green']);
    // Узел 2 (text): проходит без оракула (пол текста пуст).
    await run('contextAssembler.js', [dir, '--mode', 'step']);
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', 'NODE-02']);
    await armHuman(dir, 'NODE-02');
    const n2 = await approve(dir, 'NODE-02');
    check('узел-2 (text) сертифицирован без code-оракула', n2.data?.result === 'PASS', n2.raw?.slice(0, 160));
}

// ── Комплекс C: behavioral игровая логика (Zuma-подобная) — все 3 рунга на реальных файлах.
async function complexC() {
    console.log('\n[10] КОМПЛЕКС C: behavioral игровая логика — 3-рунговая лестница на реальном коде');
    const { dir, N } = await setupNode('APP-C', { kind: 'code', cls: 'code.behavioral', validation: 'ai' });
    // Логика: очередь шаров, матч ≥3 одного цвета лопается и даёт очки.
    await writeWs(dir, 'workspace/game.mjs', `export function resolve(chain){let score=0;let i=0;const out=[...chain];while(i<out.length){let j=i;while(j<out.length&&out[j]===out[i])j++;const run=j-i;if(run>=3){score+=run*10;out.splice(i,run);i=0;continue;}i=j;}return{board:out,score};}\n`);
    // Тест (headless-логика).
    await writeWs(dir, 'workspace/game.test.mjs', `import {resolve} from './game.mjs';const r=resolve(['R','R','R','B']);if(r.score!==30)throw new Error('score '+r.score);if(r.board.join('')!=='B')throw new Error('board '+r.board.join(''));console.log('ok');\n`);
    // Скриптовая симуляция: бросает при нарушении инварианта → нечистая консоль = ненулевой код.
    await writeWs(dir, 'workspace/sim.mjs', `import {resolve} from './game.mjs';const {board,score}=resolve(['G','G','R','R','R']);if(score<0)throw new Error('neg score');if(board.length>5)throw new Error('board grew');console.log('SIM OK score='+score);\n`);
    const c = await oracle(dir, N, 'compile', 'node --check workspace/game.mjs');
    const cc = await oracle(dir, N, 'console_clean', 'node workspace/sim.mjs');
    const t = await oracle(dir, N, 'tests', 'node workspace/game.test.mjs');
    check('compile зелёный', c.data?.result === 'PASS', c.raw?.slice(0, 160));
    check('console_clean зелёный (симуляция без исключений)', cc.data?.result === 'PASS', cc.raw?.slice(0, 160));
    check('tests зелёный (комбо-скоринг верен)', t.data?.result === 'PASS', t.raw?.slice(0, 160));
    await armHuman(dir, N);
    const passed = await approve(dir, N);
    check('behavioral-узел сертифицирован по всем 3 рунгам', passed.data?.result === 'PASS', passed.raw?.slice(0, 160));
    const st = await readState(dir);
    check('в state зафиксирован класс + met-рунги (compile/console_clean/tests/security)',
        st.evidence_floor?.class === 'code.behavioral' && st.evidence_floor?.met?.length === 4 && st.evidence_floor?.met?.includes('security'),
        JSON.stringify(st.evidence_floor));
}

// ── Волна 2B: turnkey-оракулы + секции отчёта (self-review / oracle block).
async function scenario11_wave2b() {
    console.log('\n[11] Волна 2B: turnkey-оракулы + секции отчёта');
    const { detectProjectType, suggestOracles } = await import('./oracleSuggest.js');
    const t = detectProjectType(ROOT);
    check('детект типа проекта: node (в репо есть package.json)', t === 'node' || t === 'node-ts', `got ${t}`);
    const s = suggestOracles({ id: 'УЗЕЛ-01', artifact_kind: 'code', artifact_class: 'code.behavioral' }, t);
    check('behavioral → предложены 4 рунга (вкл. security) с командами',
        s.rungs.length === 4 && s.rungs.some(r => r.rung === 'security') && s.rungs.every(r => r.suggested_cmd && r.cli.includes('--type oracle')),
        JSON.stringify(s.rungs.map(r => r.rung)));
    // Отчёт code-узла содержит секции ОРАКУЛ и SELF-REVIEW.
    const { dir, N } = await setupNode('EV-REPORT', { kind: 'code', validation: 'ai' });
    const report = await fs.readFile(path.join(dir, 'validation_report.md'), 'utf-8');
    check('отчёт содержит ## ОРАКУЛ (ранний сигнал пола)', report.includes('## ОРАКУЛ'), report.slice(0, 120));
    check('отчёт содержит ## SELF-REVIEW (Lever 4)', report.includes('## SELF-REVIEW'));
    check('отчёт показывает недостающие рунги', /не хватает|не зелёный/i.test(report));
    // Text-узел: секций code-оракула/self-review быть НЕ должно.
    const t2 = await setupNode('EV-REPORT-TXT', { kind: 'text', validation: 'human' });
    const rep2 = await fs.readFile(path.join(t2.dir, 'validation_report.md'), 'utf-8');
    check('text-отчёт БЕЗ ## SELF-REVIEW', !rep2.includes('## SELF-REVIEW'));

    // Unity NUnit-парсер (рунг tests для behavioral): реальный скрипт, честные коды выхода.
    const xdir = path.join(EVAL_BASE, 'EV-UNITY');
    await fs.mkdir(xdir, { recursive: true });
    await fs.writeFile(path.join(xdir, 'pass.xml'), '<test-run result="Passed" total="3" passed="3" failed="0"></test-run>', 'utf-8');
    await fs.writeFile(path.join(xdir, 'fail.xml'), '<test-run result="Failed" total="3" passed="1" failed="2"></test-run>', 'utf-8');
    const rp = await run('parseUnityTestResults.mjs', [path.join(xdir, 'pass.xml')]);
    const rf = await run('parseUnityTestResults.mjs', [path.join(xdir, 'fail.xml')]);
    check('Unity-парсер: все прошли → ok=true, exit 0', rp.success && rp.data?.ok === true, rp.raw?.slice(0, 120));
    check('Unity-парсер: есть провал → ok=false, exit 1', !rf.success && rf.data?.ok === false, rf.raw?.slice(0, 120));
}

// ── Волна: фиктивный оракул (no-op) не засчитывается в пол.
async function scenario12_trivial() {
    console.log('\n[12] No-op оракул отклоняется (пол не обмануть `node -e 0`/`echo`/`true`)');
    const { isTrivialOracleCommand } = await import('./evidenceLadder.js');
    check('детектор: node -e 0 тривиален', isTrivialOracleCommand('node -e 0') === true);
    check('детектор: echo ok тривиален', isTrivialOracleCommand('echo ok') === true);
    check('детектор: true тривиален', isTrivialOracleCommand('true') === true);
    check('детектор: реальная команда НЕ тривиальна', isTrivialOracleCommand('node --check workspace/ok.mjs') === false);
    check('детектор: node -e "assert(...)" НЕ тривиальна', isTrivialOracleCommand('node -e "if(f()!==1)throw 0"') === false);

    const { dir, N } = await setupNode('EV-TRIVIAL', { kind: 'code', validation: 'ai' });
    await writeRealOracle(dir);
    const rej = await oracle(dir, N, 'compile', 'node -e 0');
    check('oracle с no-op → TRIVIAL_ORACLE (ненулевой выход)',
        !rej.success && rej.data?.error === 'TRIVIAL_ORACLE', rej.raw?.slice(0, 160));
    // Даже если модель попробует протащить no-op — рунг записан как TRIVIAL, пол не выполнен.
    await oracle(dir, N, 'tests', REAL.tests);
    await armHuman(dir, N);
    const blocked = await approve(dir, N);
    check('пол не выполнен: compile всё ещё не зелёный (no-op не засчитан)',
        !blocked.success && blocked.data?.missing?.includes('compile'), blocked.raw?.slice(0, 160));
    // Реальная compile-команда закрывает пол.
    await oracle(dir, N, 'compile', REAL.compile);
    await armHuman(dir, N);
    const passed = await approve(dir, N);
    check('после реального compile → PASS', passed.data?.result === 'PASS', passed.raw?.slice(0, 160));
}

// ── Гейт финальной интеграции: набор зелёных узлов ещё не значит рабочую систему.
async function advance(dir, N, status = 'SUCCESS') {
    return run('loopAdvancer.js', [dir, '--node', N, '--status', status, '--insight', 'done']);
}
async function scenario13_integration() {
    console.log('\n[13] Гейт финальной интеграции перед TASK_COMPLETE');
    const { dir, N } = await setupNode('EV-INTEG', { kind: 'code', validation: 'ai' });
    await writeRealOracle(dir);
    // Закрываем единственный узел честно (реальные рунги).
    await oracle(dir, N, 'compile', REAL.compile);
    await oracle(dir, N, 'tests', REAL.tests);
    await armHuman(dir, N);
    await approve(dir, N);
    // Продвижение без интеграции → NEEDS_FINAL_INTEGRATION, задача НЕ закрыта.
    const noInteg = await advance(dir, N);
    check('без интеграции → NEEDS_FINAL_INTEGRATION (не TASK_COMPLETE)',
        noInteg.data?.action === 'NEEDS_FINAL_INTEGRATION', noInteg.raw?.slice(0, 160));
    // Тривиальная интеграция отклоняется.
    const triv = await run('validator.js', [dir, '--node', '__TASK__', '--type', 'oracle', '--rung', 'integration', '--cmd', 'echo ok']);
    check('интеграция с no-op → TRIVIAL_ORACLE', !triv.success && triv.data?.error === 'TRIVIAL_ORACLE', triv.raw?.slice(0, 120));
    // Реальный зелёный интеграционный прогон.
    const integ = await run('validator.js', [dir, '--node', '__TASK__', '--type', 'oracle', '--rung', 'integration', '--cmd', 'node workspace/ok.test.mjs']);
    check('интеграционный оракул зелёный (PASS)', integ.success && integ.data?.result === 'PASS', integ.raw?.slice(0, 120));
    // Теперь задача закрывается.
    const done = await advance(dir, N);
    check('после интеграции → TASK_COMPLETE', done.data?.action === 'TASK_COMPLETE', done.raw?.slice(0, 160));
}

// ── Deliverables должны существовать; self-review должен быть содержательным.
async function scenario14_deliverables_selfreview() {
    console.log('\n[14] Существование deliverables + содержательность self-review');
    // Узел объявляет deliverable, которого НЕТ на диске.
    const id = 'EV-DELIV'; const dir = path.join(EVAL_BASE, id); const N = 'УЗЕЛ-01';
    await fs.rm(dir, { recursive: true, force: true });
    await run('task_initializer.js', [id, 'deliv']);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    await run('roadmapEdit.js', [dir, 'set-field', '--node', N, '--validation', 'ai', '--kind', 'code', '--deliverable', 'workspace/must_exist.mjs']);
    await writeRealOracle(dir);
    await run('contextAssembler.js', [dir, '--mode', 'validate', '--node', N]);
    await oracle(dir, N, 'compile', REAL.compile);
    await oracle(dir, N, 'tests', REAL.tests);
    await armHuman(dir, N);
    const noDeliv = await approve(dir, N);
    check('заявленный, но отсутствующий deliverable → пол не выполнен',
        !noDeliv.success && noDeliv.data?.missing_deliverables?.includes('workspace/must_exist.mjs'), noDeliv.raw?.slice(0, 160));
    // Создаём deliverable → пол закрывается.
    await writeWs(dir, 'workspace/must_exist.mjs', 'export const x=1;\n');
    await armHuman(dir, N);
    const withDeliv = await approve(dir, N);
    check('после создания deliverable → PASS', withDeliv.data?.result === 'PASS', withDeliv.raw?.slice(0, 160));

    // Self-review структурная проверка (гейт включён только для этого сценария).
    const { dir: d2, N: N2 } = await setupNode('EV-SR', { kind: 'code', validation: 'ai' });
    await writeRealOracle(d2);
    await oracle(d2, N2, 'compile', REAL.compile);
    await oracle(d2, N2, 'tests', REAL.tests);
    const SR_ON = { HARNESS_REQUIRE_SELFREVIEW: '1' };
    // Отписка «ok» — гейт должен отклонить.
    const rep = path.join(d2, 'validation_report.md');
    let content = await fs.readFile(rep, 'utf-8');
    content = content.replace(/## SELF-REVIEW\n\n[^\n]*/, '## SELF-REVIEW\n\nok');
    await fs.writeFile(rep, content, 'utf-8');
    await run('validator.js', [d2, '--node', N2, '--type', 'human'], SR_ON); // взвести awaiting_human
    const flimsy = await run('validator.js', [d2, '--node', N2, '--type', 'human', '--approve'], SR_ON);
    check('отписка «ok» в self-review → GATE_FAILED self_review_required',
        !flimsy.success && flimsy.data?.gate === 'self_review_required', flimsy.raw?.slice(0, 160));
    // Содержательный self-review — проходит.
    content = content.replace(/## SELF-REVIEW\n\nok/, '## SELF-REVIEW\n\n- DoD#0 закрыт функцией ok() в workspace/ok.mjs\n- Может сломаться: (1) null-вход, (2) переполнение, (3) гонка при параллельном вызове\n- Оракул: compile ✅ и tests ✅ прогнаны зелёными');
    await fs.writeFile(rep, content, 'utf-8');
    await run('validator.js', [d2, '--node', N2, '--type', 'human'], SR_ON);
    const solid = await run('validator.js', [d2, '--node', N2, '--type', 'human', '--approve'], SR_ON);
    check('содержательный self-review → PASS', solid.data?.result === 'PASS', solid.raw?.slice(0, 160));
}

// ── Security-рунг: скан секретов/опасных паттернов (auto-FAIL).
async function scenario15_security() {
    console.log('\n[15] Security-рунг: утечка секрета роняет пол');
    const { scanText } = await import('./securityScan.js');
    const { requiredRungs } = await import('./evidenceLadder.js');
    check('code.testable теперь требует рунг security', requiredRungs('code.testable').includes('security'));
    check('скан ловит приватный ключ', scanText('-----BEGIN RSA PRIVATE KEY-----\nMII...').clean === false);
    check('скан ловит захардкоженный пароль', scanText('const password = "hunter2secret"').clean === false);
    check('скан ловит AWS-ключ', scanText('AKIAIOSFODNN7EXAMPLE').clean === false);
    check('скан ловит auth-bypass', scanText('isAdmin = true // temp').clean === false);
    check('чистый код проходит', scanText('export const add=(a,b)=>a+b;').clean === true);

    // E2E через security-оракул на артефакте с секретом (text: сканируется содержимое файла).
    const id = 'EV-SEC'; const dir = path.join(EVAL_BASE, id); const N = 'УЗЕЛ-01';
    await fs.rm(dir, { recursive: true, force: true });
    await run('task_initializer.js', [id, 'sec']);
    await run('contextAssembler.js', [dir, '--mode', 'init']);
    await run('roadmapEdit.js', [dir, 'set-field', '--node', N, '--validation', 'human', '--kind', 'text', '--deliverable', 'workspace/config.txt']);
    await writeWs(dir, 'workspace/config.txt', 'db_password = "S3cr3tP@ssw0rd!!"\nAKIAIOSFODNN7EXAMPLE\n');
    const leaked = await run('validator.js', [dir, '--node', N, '--type', 'oracle', '--rung', 'security']);
    check('security-оракул: секрет → FAIL (ненулевой выход)',
        !leaked.success && leaked.data?.result === 'FAIL' && leaked.data?.findings?.length >= 1, leaked.raw?.slice(0, 160));
    await writeWs(dir, 'workspace/config.txt', 'db_host = "localhost"\ndb_port = 5432\n');
    const clean = await run('validator.js', [dir, '--node', N, '--type', 'oracle', '--rung', 'security']);
    check('security-оракул: после чистки → PASS', clean.success && clean.data?.result === 'PASS', clean.raw?.slice(0, 160));
}

// ── Взвешенная рубрика судьи (functionality/quality/security/edge_cases).
async function scenario16_rubric() {
    console.log('\n[16] Взвешенная рубрика судьи может понизить формальный PASS');
    const { evaluateRubric } = await import('./rubric.js');
    check('нет рубрики → ok (backward-compat)', evaluateRubric(undefined).ok === true);
    check('высокие measures → ok', evaluateRubric({ functionality: 9, quality: 8, security: 9, edge_cases: 8 }).ok === true);
    check('низкий взвешенный балл → not ok', evaluateRubric({ functionality: 5, quality: 5, security: 6, edge_cases: 5 }).ok === false);
    check('низкий security → security-floor авто-FAIL', evaluateRubric({ functionality: 10, quality: 10, security: 3, edge_cases: 10 }).ok === false);

    // E2E через subagent-судью: pass=true, но security-измерение низкое → FAIL.
    const { dir, N } = await setupNode('EV-RUBRIC', { kind: 'code', validation: 'ai' });
    await run('roadmapEdit.js', [dir, 'set-field', '--node', N, '--worker-family', 'openai']); // cross-family субагент валиден
    await writeRealOracle(dir);
    await oracle(dir, N, 'compile', REAL.compile);
    await oracle(dir, N, 'tests', REAL.tests);
    const trig = await run('validator.js', [dir, '--node', N, '--type', 'ai']);
    check('offline → NEEDS_SUBAGENT_JUDGE', trig.data?.action === 'NEEDS_SUBAGENT_JUDGE', trig.raw?.slice(0, 140));
    if (trig.data?.action === 'NEEDS_SUBAGENT_JUDGE') {
        await fs.writeFile(path.join(dir, 'ai_judge_verdict.json'),
            JSON.stringify({ pass: true, dod_results: [{ index: 0, pass: true }], rubric: { functionality: 9, quality: 8, security: 2, edge_cases: 8 } }), 'utf8');
        const bad = await run('validator.js', [dir, '--node', N, '--type', 'ai', '--judge-file', 'ai_judge_verdict.json']);
        check('pass=true, но security=2 → рубрика понижает до FAIL', bad.data?.result === 'FAIL', bad.raw?.slice(0, 180));
        // Повторный заход + хорошая рубрика → PASS.
        await run('validator.js', [dir, '--node', N, '--type', 'ai']); // снова awaiting_subagent
        await fs.writeFile(path.join(dir, 'ai_judge_verdict.json'),
            JSON.stringify({ pass: true, dod_results: [{ index: 0, pass: true }], rubric: { functionality: 9, quality: 8, security: 9, edge_cases: 8 } }), 'utf8');
        const good = await run('validator.js', [dir, '--node', N, '--type', 'ai', '--judge-file', 'ai_judge_verdict.json']);
        check('хорошая рубрика → PASS', good.data?.result === 'PASS', good.raw?.slice(0, 180));
    }
}

// ── harness_dream: самоулучшение процесса из провалов.
async function scenario17_dream() {
    console.log('\n[17] harnessDream: уроки из повторяющихся провалов');
    const { signature, extractFailures, clusterFailures } = await import('./harnessDream.js');
    check('сигнатура схлопывает числа/пути',
        signature('Error at line 42 in /a/b/c.js') === signature('Error at line 99 in /x/y/z.js'),
        signature('Error at line 42 in /a/b/c.js'));
    const roadmap = { nodes: [
        { id: 'N1', history: [{ result: 'FAIL', detail: 'timeout after 30s calling external judge' }], last_error: null },
        { id: 'N2', history: [{ result: 'FAIL', detail: 'timeout after 45s calling external judge' }], last_error: null },
        { id: 'N3', history: [{ result: 'SUCCESS', detail: 'ok' }], last_error: null }
    ] };
    const fails = extractFailures(roadmap, {});
    check('extractFailures берёт только FAIL', fails.length === 2, `got ${fails.length}`);
    const lessons = clusterFailures(fails, 2);
    check('повторяющийся паттерн кластеризован (×2)', lessons.length === 1 && lessons[0].count === 2, JSON.stringify(lessons.map(l => ({ p: l.pattern, c: l.count }))));
    check('урок несёт ratchet-предложение', lessons.length > 0 && !!lessons[0].suggestion, lessons[0]?.suggestion);
    check('единичный провал ниже порога → не урок', clusterFailures([{ source: 'x', detail: 'lonely fail 1' }], 2).length === 0);
    // CLI-смоук на реальном task-каталоге (без паттернов — валидный JSON, не падает).
    const { dir } = await setupNode('EV-DREAM', { kind: 'code', validation: 'ai' });
    const cli = await run('harnessDream.js', [dir]);
    check('CLI harnessDream отрабатывает и отдаёт JSON', cli.success && typeof cli.data?.failures_scanned === 'number', cli.raw?.slice(0, 120));
}

// ── Линтер бюджета инструментов (Plugin Weapon Manifest ≤ N).
async function scenario18_toolbudget() {
    console.log('\n[18] Линтер бюджета инструментов стратегий');
    const { lintToolBudgets } = await import('./toolBudgetLint.js');
    const over = lintToolBudgets([{ id: 's1', weapons: Array.from({ length: 12 }, (_, i) => 't' + i) }], 10);
    check('превышение бюджета → violation over_budget', !over.ok && over.violations[0].kind === 'over_budget', JSON.stringify(over.violations));
    const dup = lintToolBudgets([{ id: 's2', weapons: ['a', 'b', 'a'] }], 10);
    check('дубликаты инструментов → violation', !dup.ok && dup.violations.some(v => v.kind === 'duplicate_tools'), JSON.stringify(dup.violations));
    const okr = lintToolBudgets([{ id: 's3', weapons: ['a', 'b'] }], 10);
    check('в бюджете и без дублей → ok', okr.ok === true);
    // CLI на реальном реестре стратегий — все 7 сейчас в бюджете.
    const cli = await run('toolBudgetLint.js', []);
    check('CLI линтер: реальные 7 стратегий в бюджете (≤10)', cli.success && cli.data?.ok === true, cli.raw?.slice(0, 140));
}

async function main() {
    console.log('═══ EVIDENCE LADDER EVAL (Levers 1′–4) ═══');
    await fs.rm(EVAL_BASE, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(EVAL_BASE, { recursive: true });
    try {
        await scenario1_classify();
        await scenario2_policy();
        await scenario3_stale();
        await scenario4_waive();
        await scenario5_floorGate();
        await scenario6_behavioral();
        await scenario7_text();
        await complexA();
        await complexB();
        await complexC();
        await scenario11_wave2b();
        await scenario12_trivial();
        await scenario13_integration();
        await scenario14_deliverables_selfreview();
        await scenario15_security();
        await scenario16_rubric();
        await scenario17_dream();
        await scenario18_toolbudget();
    } catch (e) {
        bad('НЕОЖИДАННОЕ ИСКЛЮЧЕНИЕ', e.stack || e.message);
    }
    console.log(`\n═══ ИТОГ: ${PASS} passed, ${FAIL} failed ═══`);
    if (FAIL) console.log('Провалено: ' + fails.join(' | '));
    process.exit(FAIL ? 1 : 0);
}
main();
