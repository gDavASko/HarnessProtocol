import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Тесты герметичны: preflight-опрос CLI-ИИ отключён (без реальных вызовов).
process.env.HARNESS_PROBE_SKIP = '1';
// Этот smoke проверяет state machine, а не ручное заполнение отчёта;
// иначе новый summary-gate скрывает целевую проверку auto-validation.
process.env.HARNESS_REQUIRE_SUMMARY = '0';

const SCRIPTS_DIR = __dirname;
const TACTICAL_BASE_DIR = path.resolve(SCRIPTS_DIR, '../../../../..', 'memory/tactical');
const TEST_TASK_ID = 'TACT-TEST-SMOKE';
const TEST_TASK_DIR = path.join(TACTICAL_BASE_DIR, TEST_TASK_ID);

async function cleanTestTask() {
    try {
        await fs.rm(TEST_TASK_DIR, { recursive: true, force: true });
    } catch (err) {
        // ignore
    }
}

async function runScript(scriptName, args) {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    try {
        const { stdout } = await execFileAsync('node', [scriptPath, ...args]);
        return { success: true, data: JSON.parse(stdout.trim()) };
    } catch (error) {
        let errData = {};
        try {
            errData = JSON.parse(error.stdout || error.stderr || '{}');
        } catch {
            errData = { error: error.message };
        }
        return { success: false, error: errData };
    }
}

async function runSmokeTests() {
    console.log('=== Запуск Smoke-тестов жизненного цикла HarnessProtocol ===');
    await cleanTestTask();

    // ─── 1. ИНИЦИАЛИЗАЦИЯ ЗАДАЧИ ─────────────────────────────────────────────
    console.log('\n[Шаг 1] Инициализация задачи...');
    const initRes = await runScript('task_initializer.js', [TEST_TASK_ID, 'Smoke Test Task']);
    if (!initRes.success) {
        console.error('Ошибка инициализации:', initRes.error);
        process.exit(1);
    }
    console.log('OK: Каркас развернут.');

    // Проверяем наличие файлов
    const statePath = path.join(TEST_TASK_DIR, '.harness_state.json');
    const roadmapPath = path.join(TEST_TASK_DIR, '.harness_roadmap.json');
    
    const stateExist = await fs.access(statePath).then(() => true).catch(() => false);
    const roadmapExist = await fs.access(roadmapPath).then(() => true).catch(() => false);

    if (!stateExist || !roadmapExist) {
        console.error('Ошибка: Файлы состояния или роадмапа не созданы.');
        process.exit(1);
    }

    const initialState = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    if (initialState.stage !== 'awaiting_context') {
        console.error(`Ошибка: Неверная стартовая стадия: ${initialState.stage}`);
        process.exit(1);
    }
    console.log('OK: Стартовая стадия: awaiting_context.');

    // ─── 2. ГЕЙТЫ: ПРОВЕРКА ОТРИЦАТЕЛЬНЫХ ГЕЙТОВ ──────────────────────────────────
    console.log('\n[Шаг 2] Проверка отрицательных гейтов...');
    
    // Запуск validator.js без context init должен упасть с GATE_FAILED (report_ready)
    const valGateRes = await runScript('validator.js', [TEST_TASK_DIR, '--node', 'УЗЕЛ-01', '--type', 'ai', '--result', 'PASS']);
    if (valGateRes.success || valGateRes.error.error !== 'GATE_FAILED' || valGateRes.error.gate !== 'report_ready') {
        console.error('Ошибка гейта: Ожидался провал validator.js с gate: report_ready, получено:', valGateRes);
        process.exit(1);
    }
    console.log('OK: validator.js упал на гейте report_ready.');

    // Запуск loopAdvancer.js без валидации должен упасть с GATE_FAILED (validated)
    const advGateRes = await runScript('loopAdvancer.js', [TEST_TASK_DIR, '--node', 'УЗЕЛ-01', '--status', 'SUCCESS']);
    if (advGateRes.success || advGateRes.error.error !== 'GATE_FAILED' || advGateRes.error.gate !== 'validated') {
        console.error('Ошибка гейта: Ожидался провал loopAdvancer.js с gate: validated, получено:', advGateRes);
        process.exit(1);
    }
    console.log('OK: loopAdvancer.js упал на гейте validated.');

    // ─── 3. ИНИЦИАЛИЗАЦИЯ КОНТЕКСТА ──────────────────────────────────────────
    console.log('\n[Шаг 3] Сбор контекста (init)...');
    const contextRes = await runScript('contextAssembler.js', [TEST_TASK_DIR, '--mode', 'init']);
    if (!contextRes.success) {
        console.error('Ошибка сборки контекста:', contextRes.error);
        process.exit(1);
    }
    console.log('OK: Контекст собран.');

    // Проверяем стадию
    const stateAfterContext = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    if (stateAfterContext.stage !== 'context_served') {
        console.error(`Ошибка: После init стадия должна быть context_served, получено: ${stateAfterContext.stage}`);
        process.exit(1);
    }
    console.log('OK: Стадия обновлена на context_served.');

    // ─── 4. ГЕЙТ: ПОВТОРНЫЙ INIT ИЗ CONTEXT_SERVED ДОЛЖЕН ПАДАТЬ ─────────────────
    console.log('\n[Шаг 4] Проверка гейта повторной инициализации контекста...');
    const contextDoubleRes = await runScript('contextAssembler.js', [TEST_TASK_DIR, '--mode', 'init']);
    if (contextDoubleRes.success || contextDoubleRes.error.error !== 'GATE_FAILED' || contextDoubleRes.error.gate !== 'awaiting_context') {
        console.error('Ошибка гейта: Ожидался провал contextAssembler.js с gate: awaiting_context, получено:', contextDoubleRes);
        process.exit(1);
    }
    console.log('OK: Повторная инициализация упала на гейте awaiting_context.');

    // ─── 5. ГЕНЕРАЦИЯ ОТЧЕТА ВАЛИДАЦИИ ───────────────────────────────────────
    console.log('\n[Шаг 5] Генерация отчета валидации...');
    const reportRes = await runScript('contextAssembler.js', [TEST_TASK_DIR, '--mode', 'validate', '--node', 'УЗЕЛ-01']);
    if (!reportRes.success) {
        console.error('Ошибка генерации отчета:', reportRes.error);
        process.exit(1);
    }
    console.log('OK: Валидационный отчет сгенерирован.');

    // Проверяем стадию
    const stateAfterReport = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    if (stateAfterReport.stage !== 'report_ready') {
        console.error(`Ошибка: После validate стадия должна быть report_ready, получено: ${stateAfterReport.stage}`);
        process.exit(1);
    }
    console.log('OK: Стадия обновлена на report_ready.');

    // ─── 6. АВТО-ВАЛИДАЦИЯ БЕЗ КОМАНД (CONFIG ERROR) ─────────────────────────
    console.log('\n[Шаг 6] Авто-валидация без команд...');
    const autoValNoCmdRes = await runScript('validator.js', [TEST_TASK_DIR, '--node', 'УЗЕЛ-01', '--type', 'auto']);
    if (!autoValNoCmdRes.success || autoValNoCmdRes.data.overall !== 'FAIL' || !autoValNoCmdRes.data.config_error) {
        console.error('Ошибка валидации: Ожидался FAIL + config_error для auto-валидации без команд, получено:', autoValNoCmdRes);
        process.exit(1);
    }
    console.log('OK: Авто-валидация вернула FAIL с ошибкой конфигурации (config_error).');

    // ─── 7. УСПЕШНАЯ ВАЛИДАЦИЯ через human-approve ───────────────────────────
    // AI-валидация теперь ВСЕГДА идёт через внешнего судью (сеть/CLI), поэтому в
    // детерминированном офлайн-smoke используем human-путь: он же покрывает
    // human-гейт (awaiting_human_validation → approve → validated).
    console.log('\n[Шаг 7a] Запрос ручной валидации...');
    const humanReq = await runScript('validator.js', [TEST_TASK_DIR, '--node', 'УЗЕЛ-01', '--type', 'human']);
    if (!humanReq.success || humanReq.data.status !== 'AWAITING_HUMAN') {
        console.error('Ошибка: Ожидался статус AWAITING_HUMAN, получено:', humanReq.error || humanReq.data);
        process.exit(1);
    }
    const stateAwaiting = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    if (stateAwaiting.stage !== 'awaiting_human_validation') {
        console.error(`Ошибка: стадия должна быть awaiting_human_validation, получено: ${stateAwaiting.stage}`);
        process.exit(1);
    }
    console.log('OK: Стадия awaiting_human_validation.');

    console.log('\n[Шаг 7b] Одобрение человеком...');
    const valPassRes = await runScript('validator.js', [TEST_TASK_DIR, '--node', 'УЗЕЛ-01', '--type', 'human', '--approve', '--comment', 'DoD completed successfully.']);
    if (!valPassRes.success || valPassRes.data.result !== 'PASS') {
        console.error('Ошибка валидации:', valPassRes.error || valPassRes.data);
        process.exit(1);
    }
    console.log('OK: Валидация пройдена (PASS).');

    // Проверяем стадию
    const stateAfterVal = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    if (stateAfterVal.stage !== 'validated') {
        console.error(`Ошибка: После успешной валидации стадия должна быть validated, получено: ${stateAfterVal.stage}`);
        process.exit(1);
    }
    console.log('OK: Стадия обновлена на validated.');

    // ─── 8. ПРОДВИЖЕНИЕ ЦИКЛА (ADVANCE / TASK COMPLETE) ──────────────────────
    console.log('\n[Шаг 8] Продвижение цикла...');
    const advRes = await runScript('loopAdvancer.js', [TEST_TASK_DIR, '--node', 'УЗЕЛ-01', '--status', 'SUCCESS', '--insight', 'Task complete smoke test successfully.']);
    if (!advRes.success || advRes.data.action !== 'TASK_COMPLETE') {
        console.error('Ошибка продвижения цикла:', advRes.error || advRes.data);
        process.exit(1);
    }
    console.log('OK: Продвижение завершено с action: TASK_COMPLETE.');

    // Проверяем финальную стадию и файлы
    const finalState = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    const finalRoadmap = JSON.parse(await fs.readFile(roadmapPath, 'utf-8'));

    if (finalState.stage !== 'awaiting_context' || finalRoadmap.status !== 'DONE') {
        console.error('Ошибка: Финальное состояние некорректно:', { finalState, finalRoadmap });
        process.exit(1);
    }
    console.log('OK: Финальное состояние роадмапа: status = DONE, stage = awaiting_context.');

    // ─── 9. ТЕСТ selectStrategy (без LLM) ────────────────────────────────────
    console.log('\n[Шаг 9] Проверка авто-выбора стратегий...');
    const { selectStrategy } = await import('./strategyEngine.js');
    const ctx = { constraints_digest: '', tools_available: [], dod: [] };

    const testCases = [
        { node: { strategy: 'Map-Reduce', title: 'x', dod: [{ criterion: 'x' }] }, expected: 'Map-Reduce', label: 'Override' },
        { node: { strategy: 'None', title: 'Метод', dod: [{ criterion: 'Написать' }] }, expected: 'Prompt Chaining', label: '1 DoD simple' },
        { node: { strategy: 'None', title: 'UI и sfx', dod: [{ criterion: 'Сделать' }] }, expected: 'Routing', label: 'Mixed domains' },
        { node: { strategy: 'None', title: 'Скрипт парсинга', dod: [{ criterion: 'Парс' }] }, expected: 'LATM / Tool Maker', label: 'Tool gap' },
        { node: { strategy: 'None', title: 'Код', dod: [{ criterion: 'OK' }] }, expected: 'Evaluator-Optimizer', label: 'Auto test', ctx: { ...ctx, tools_available: ['npm test'] } },
        { node: { strategy: 'None', title: 'Документация', dod: [{ criterion: 'A' }, { criterion: 'B' }, { criterion: 'C' }] }, expected: 'Parallelization', label: '>2 DoD independent' },
        { node: { strategy: 'None', title: 'Рефакторинг всех файлов', dod: [{ criterion: 'A' }, { criterion: 'B' }, { criterion: 'C' }] }, expected: 'Map-Reduce', label: '>2 DoD data heavy' },
    ];

    let stratPassed = 0;
    for (const tc of testCases) {
        const result = await selectStrategy('', tc.node, tc.ctx || ctx);
        if (result === tc.expected) {
            console.log(`  ✅ ${tc.label}: ${result}`);
            stratPassed++;
        } else {
            console.error(`  ❌ ${tc.label}: ожидалось '${tc.expected}', получено '${result}'`);
        }
    }
    console.log(`OK: selectStrategy ${stratPassed}/${testCases.length} тестов.`);
    if (stratPassed < testCases.length) {
        console.error('Некоторые тесты selectStrategy не пройдены!');
        process.exit(1);
    }

    // Чистим временные файлы
    await cleanTestTask();
    console.log('\n=== Smoke-тесты успешно пройдены! Все гейты, переходы и стратегии подтверждены. ===');
}

runSmokeTests().catch(err => {
    console.error('Непредвиденная ошибка в тестах:', err);
    process.exit(1);
});
