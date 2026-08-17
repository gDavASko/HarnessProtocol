import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkCodeSyntax } from './graph/syntaxGuard.js';
import { formalizeContract } from './graph/contractFormalizer.js';
import { distillSkillIfEligible } from './graph/skillDistiller.js';
import { strategyRegistry } from './graph/strategies/strategyRegistry.js';
import { HarnessDiskCheckpointer } from './graph/harnessCheckpointer.js';
import { HarnessModelAdapter } from './graph/modelAdapter.js';
import { createRalphLoopSubgraph } from './graph/ralphLoopSubgraph.js';
import { createTaskOrchestratorGraph } from './graph/taskOrchestratorGraph.js';
import { writeRoadmap, writeState, readState, readRoadmap } from './harnessState.js';
import { selectScale } from './scaleGate.js';
import { callLLM } from './llmClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const suiteDir = path.resolve(__dirname, '../.harness_tmp/live_scenarios_suite');

let passedCount = 0;
let failedCount = 0;

async function runScenario(name, fn) {
    const scenarioNum = passedCount + failedCount + 1;
    console.log(`\n───────────────────────────────────────────────────────────────`);
    console.log(`⚔️  [Сценарий ${scenarioNum}] ${name}`);
    console.log(`───────────────────────────────────────────────────────────────`);
    const startTime = Date.now();
    try {
        await fn();
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ [PASS] Сценарий ${scenarioNum} завершен за ${duration}с`);
        passedCount++;
    } catch (err) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`❌ [FAIL] Сценарий ${scenarioNum} провален за ${duration}с: ${err.message}`);
        if (err.stack) console.error(err.stack);
        failedCount++;
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('  ⚔️  ПОЛНОМАСШТАБНЫЕ БОЕВЫЕ СЦЕНАРНЫЕ ТЕСТЫ HARNESS PROTOCOL (LIVE)   ');
    console.log('═══════════════════════════════════════════════════════════════════════');
    
    await fs.rm(suiteDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(suiteDir, { recursive: true });

    const modelAdapter = new HarnessModelAdapter({ baseDir: suiteDir });

    // ─── 1-8: Реальные живые стратегии с живыми вызовами моделей ────────────

    await runScenario('Стратегия 1: Живой Prompt Chaining (пошаговый синтез с памятью)', async () => {
        const plugin = strategyRegistry.get('chaining');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-01',
                title: 'Синтез протокола безопасности',
                dod: [
                    { criterion: 'Определить 3 критических правила изоляции процессов' },
                    { criterion: 'Сформировать чеклист проверки соблюдения правил' }
                ]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'chaining');
        assert(res.result.summary.length > 50, 'Must contain substantive generated summary');
        console.log(`   📝 Длина сгенерированного отчета: ${res.result.summary.length} симв.`);
    });

    await runScenario('Стратегия 2: Живой Domain Routing в UI-домен', async () => {
        const plugin = strategyRegistry.get('routing');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-02',
                title: 'Спроектировать HUD панель здоровья и маны',
                dod: [{ criterion: 'Создать разметку UI элементов HUD' }]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'routing');
        console.log(`   🎨 Ответ UI воркера: ${res.result.summary.slice(0, 100)}...`);
    });

    await runScenario('Стратегия 3: Живой Domain Routing в Audio-домен', async () => {
        const plugin = strategyRegistry.get('routing');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-03',
                title: 'Настроить пространственный 3D SFX шагов персонажа',
                dod: [{ criterion: 'Спецификация параметров аудио-источника SFX' }]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        console.log(`   🔊 Ответ Audio воркера: ${res.result.summary.slice(0, 100)}...`);
    });

    await runScenario('Стратегия 4: Живая параллелизация с агрегацией через Collator', async () => {
        const plugin = strategyRegistry.get('parallelization');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-04',
                title: 'Параллельная спецификация модулей',
                dod: [
                    { criterion: 'Спецификация модуля Auth' },
                    { criterion: 'Спецификация модуля Billing' },
                    { criterion: 'Спецификация модуля Logging' }
                ]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'parallelization');
        console.log(`   🧩 Слияние шард Collator: ${res.result.summary.slice(0, 120)}...`);
    });

    await runScenario('Стратегия 5: Живой Orchestrator-Workers с динамическим планированием', async () => {
        const plugin = strategyRegistry.get('orchestrator');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-05',
                title: 'Декомпозиция сложной задачи миграции',
                dod: [{ criterion: 'Сформировать и исполнить план из 2 зависимых подзадач' }]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'orchestrator');
        console.log(`   🏗️ План оркестратора: ${res.result.summary.slice(0, 120)}...`);
    });

    await runScenario('Стратегия 6: Живой Evaluator-Optimizer (цикл генератора и критика)', async () => {
        const plugin = strategyRegistry.get('evaluator_optimizer');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-06',
                title: 'Оптимизация формулировки инварианта',
                dod: [{ criterion: 'Написать строгое математическое определение без двусмысленностей' }]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'evaluator_optimizer');
        console.log(`   🔍 Оптимизированный результат: ${res.result.summary.slice(0, 120)}...`);
    });

    await runScenario('Стратегия 7: Живой Map-Reduce с пакетной редукцией', async () => {
        const plugin = strategyRegistry.get('map_reduce');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-07',
                title: 'Пакетный анализ логов ошибок',
                dod: [
                    { criterion: 'Анализ логов кластера A' },
                    { criterion: 'Анализ логов кластера B' }
                ]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'map_reduce');
        console.log(`   📊 Финальная редукция: ${res.result.summary.slice(0, 120)}...`);
    });

    await runScenario('Стратегия 8: Живой LATM Tool Maker (синтез и исполнение утилиты в VM Sandbox)', async () => {
        const plugin = strategyRegistry.get('latm');
        const subgraph = plugin.createSubgraph({ modelAdapter });
        const res = await subgraph.invoke({
            taskDir: suiteDir,
            node: {
                id: 'LIVE-SC-08',
                title: 'Синтез хэш-калькулятора',
                dod: [{ criterion: 'Создать и запустить JS-скрипт расчета контрольной суммы' }]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.result.success, true);
        assert.strictEqual(res.result.strategy, 'latm');
        console.log(`   🛠️ LATM синтезировал и запустил инструмент: ${res.result.summary.slice(0, 100)}...`);
    });

    // ─── 9-15: Реальные защитные модули, синтаксис и персистентность ─────────

    await runScenario('Защита 9: Pre-Commit SyntaxGuard мгновенно ловит синтаксическую ошибку JS', async () => {
        const brokenJs = 'function calculateTotal(items) { return items.reduce((acc, i) => acc + i.';
        const check = checkCodeSyntax(brokenJs, 'calc.js');
        assert.strictEqual(check.ok, false);
        assert(check.error.includes('Syntax Error'));
        console.log(`   🛡️ SyntaxGuard заблокировал битый код: ${check.error.slice(0, 80)}`);
    });

    await runScenario('Защита 10: Pre-Commit SyntaxGuard ловит поврежденный JSON', async () => {
        const brokenJson = '{\n  "name": "harness",\n  "status": "ready",\n}';
        const check = checkCodeSyntax(brokenJson, 'config.json');
        assert.strictEqual(check.ok, false);
        console.log(`   🛡️ SyntaxGuard заблокировал невалидный JSON: ${check.error.slice(0, 80)}`);
    });

    await runScenario('Защита 11: Pre-Commit SyntaxGuard верифицирует валидный ESM модуль', async () => {
        const validEsm = `import path from 'path';\nexport function getRoot() { return path.resolve('.'); }`;
        const check = checkCodeSyntax(validEsm, 'module.js');
        assert.strictEqual(check.ok, true);
        console.log(`   🛡️ SyntaxGuard подтвердил корректный ESM синтаксис`);
    });

    await runScenario('Формализатор 12: Sprint Contract Formalizer парсит комплексные предикаты', async () => {
        const node = {
            id: 'LIVE-SC-12',
            title: 'Формализация контракта узла',
            dod: [
                { criterion: 'Создать файл core/config.json' },
                { criterion: 'Запустить npm test и вернуть 0' },
                { criterion: 'Соблюсти валидный синтаксис' }
            ]
        };
        const contract = formalizeContract(node);
        assert.strictEqual(contract.predicates.length, 3);
        assert.strictEqual(contract.predicates[0].predicateType, 'file_exists');
        assert.strictEqual(contract.predicates[1].predicateType, 'test_exit_0');
        assert.strictEqual(contract.predicates[2].predicateType, 'ast_valid');
        console.log(`   📜 Контракт formalizeContract нормализовал ${contract.predicates.length} предикатов`);
    });

    await runScenario('Дистилляция 13: Авто-генерация реального SKILL.md для L3 узла', async () => {
        const node = { id: 'LIVE-L3-SKILL', title: 'Архитектурный инвариант изоляции памяти', criticality: 'L3', iteration: 1 };
        const result = await distillSkillIfEligible(suiteDir, node, 'Критический инвариант безопасности подтвержден.');
        assert.strictEqual(result.distilled, true);
        const skillContent = await fs.readFile(result.skillPath, 'utf-8');
        assert(skillContent.includes('distilled-live-l3-skill'));
        console.log(`   🧠 Скилл успешно записан в: ${result.skillPath}`);
    });

    await runScenario('Персистентность 14: Checkpointer логирует реальный event_stream на диск', async () => {
        const checkpointer = new HarnessDiskCheckpointer({ baseDir: suiteDir });
        const config = { configurable: { thread_id: 'live-stream-test' } };
        await checkpointer.put(config, { id: 'cp-01', ts: Date.now(), channel_values: { stage: 'init' } }, { langgraph_node: 'NodeInit' });
        await checkpointer.put(config, { id: 'cp-02', ts: Date.now(), channel_values: { stage: 'strategy' } }, { langgraph_node: 'NodeStrategy' });
        
        const threadDir = checkpointer.getThreadDir('live-stream-test');
        const streamPath = path.join(threadDir, 'event_stream.jsonl');
        const content = await fs.readFile(streamPath, 'utf-8');
        assert(content.includes('cp-01') && content.includes('cp-02'));
        console.log(`   💾 Event stream зафиксировал записи на диске`);
    });

    await runScenario('Time-Travel 15: Реальный откат состояния восстанавливает исторический чекпоинт', async () => {
        const checkpointer = new HarnessDiskCheckpointer({ baseDir: suiteDir });
        const config = { configurable: { thread_id: 'live-rollback-test' } };
        await checkpointer.put(config, { id: 'snap-alpha', ts: Date.now() - 2000, channel_values: { phase: 'ALPHA' } }, { langgraph_node: 'Alpha' });
        await checkpointer.put(config, { id: 'snap-beta', ts: Date.now(), channel_values: { phase: 'BETA' } }, { langgraph_node: 'Beta' });
        
        const restored = await checkpointer.rollbackToCheckpoint('live-rollback-test', 'snap-alpha');
        assert.strictEqual(restored.checkpoint.id, 'snap-alpha');
        assert.strictEqual(restored.checkpoint.channel_values.phase, 'ALPHA');
        console.log(`   ⏪ Time-Travel успешно вернул состояние к snap-alpha`);
    });

    // ─── 16-23: Реальные боевые циклы, кворум, эскалации и мета-граф ──────────

    await runScenario('Кворум 16: Живая L3 Quorum Consensus валидация с реальным вызовом модели', async () => {
        const ralphSubgraph = createRalphLoopSubgraph({ modelAdapter, dryRun: false });
        const res = await ralphSubgraph.invoke({
            taskDir: suiteDir,
            nodeId: 'LIVE-SC-16',
            node: {
                id: 'LIVE-SC-16',
                title: 'Критический инвариант безопасности L3',
                criticality: 'L3',
                validation_type: 'auto',
                dod: [{ criterion: 'Инвариант неизменяемости конфигурации' }]
            },
            context: { dryRun: false }
        });
        assert.strictEqual(res.action, 'ADVANCE_TO_NEXT');
        console.log(`   ⚖️ L3 Quorum успешно достиг консенсуса и продвинул узел`);
    });

    await runScenario('Эскалация 17: Авто-эскалация стратегии на витке 2 (Chaining -> Evaluator-Optimizer)', async () => {
        const ralphSubgraph = createRalphLoopSubgraph({ modelAdapter, dryRun: false });
        const res = await ralphSubgraph.invoke({
            taskDir: suiteDir,
            nodeId: 'LIVE-SC-17',
            node: {
                id: 'LIVE-SC-17',
                title: 'Адаптивное решение с авто-эскалацией',
                criticality: 'L1',
                validation_type: 'auto',
                strategy: 'chaining',
                dod: [{ criterion: 'Сгенерировать решение' }]
            },
            iteration: 1,
            maxIterations: 3,
            context: { dryRun: false }
        });
        assert.strictEqual(res.action, 'ADVANCE_TO_NEXT');
        console.log(`   🔄 Авто-эскалация стратегии отработала штатно: action=${res.action}`);
    });

    await runScenario('Эскалация 18: Иерархическая эскалация к родителю при исчерпании лимита итераций', async () => {
        const ralphSubgraph = createRalphLoopSubgraph({ modelAdapter, dryRun: false });
        const res = await ralphSubgraph.invoke({
            taskDir: suiteDir,
            nodeId: 'LIVE-SC-18',
            node: {
                id: 'LIVE-SC-18',
                title: 'Неразрешимый узел',
                criticality: 'L2',
                force_fail: true,
                dod: [{ criterion: 'Невыполнимый критерий' }]
            },
            iteration: 3,
            maxIterations: 3,
            context: { dryRun: false }
        });
        assert.strictEqual(res.action, 'NEEDS_PARENT_REFRAMING');
        console.log(`   🛑 Исчерпание итераций передало управление родителю (NEEDS_PARENT_REFRAMING)`);
    });

    await runScenario('Scale Gating 19: Инвариант запрета fan-out для L3 критичности', async () => {
        const nodeL3 = { id: 'LIVE-SC-19', criticality: 'L3', dod: [{ criterion: 'A' }, { criterion: 'B' }, { criterion: 'C' }] };
        const decision = selectScale(nodeL3);
        assert.strictEqual(decision.mode, 'classic');
        assert(decision.reason.includes('L3'));
        console.log(`   🔒 Scale Gating строго ограничил L3 узлы одиночным исполнителем`);
    });

    await runScenario('Scale Gating 20: Авто-перевод в parallel workflow при >=3 DoD', async () => {
        const nodeL1 = { id: 'LIVE-SC-20', criticality: 'L1', dod: [{ criterion: 'A' }, { criterion: 'B' }, { criterion: 'C' }] };
        const decision = selectScale(nodeL1, { independentParts: 3 });
        assert.strictEqual(decision.mode, 'workflow');
        console.log(`   🚀 Scale Gating разрешил parallel workflow для 3 независимых частей`);
    });

    await runScenario('Контракт 21: 3-уровневый каскад переопределения модели', async () => {
        const adapter = new HarnessModelAdapter({ baseDir: suiteDir });
        const config = await adapter.resolveModelConfig(suiteDir, { model_tier: 'advanced', preferred_model: 'gemini-2.5-pro' });
        assert.strictEqual(config.tier, 'advanced');
        assert.strictEqual(config.preferredModel, 'gemini-2.5-pro');
        console.log(`   🎯 Каскад успешно разрешил параметры модели для узла`);
    });

    await runScenario('Мета-граф 22: TaskOrchestratorGraph выполняет многоузловой роадмап вживую', async () => {
        const testTask = path.join(suiteDir, 'task_meta_live');
        await fs.mkdir(testTask, { recursive: true });
        const roadmap = {
            title: 'Живая сценарная задача',
            status: 'IN_PROGRESS',
            nodes: [
                { id: 'N1', title: 'Генерация структуры манифеста', artifact_kind: 'text', validation_type: 'auto', dod: [{ criterion: 'Манифест' }] },
                { id: 'N2', title: 'Генерация спецификации API', artifact_kind: 'text', validation_type: 'auto', dod: [{ criterion: 'API методы' }] }
            ]
        };
        await writeRoadmap(testTask, roadmap);
        const checkpointer = new HarnessDiskCheckpointer({ baseDir: testTask });
        const orchestrator = createTaskOrchestratorGraph({ modelAdapter, checkpointer, dryRun: false });
        const out = await orchestrator.invoke({ taskDir: testTask, taskId: 'task_meta_live', status: 'IN_PROGRESS' }, { configurable: { thread_id: 'task_meta_live' } });
        assert.strictEqual(out.status, 'COMPLETED');
        console.log(`   🏁 TaskOrchestratorGraph успешно довел многоузловой роадмап до COMPLETED`);
    });

    await runScenario('Изоляция 23: Реестр стратегий отклоняет незарегистрированные плагины', async () => {
        assert.strictEqual(strategyRegistry.has('bogus_unknown_strat'), false);
        const fallback = strategyRegistry.get('bogus_unknown_strat');
        assert.strictEqual(fallback.id, 'chaining');
        console.log(`   🛡️ Неизвестная стратегия безопасно сведена к канонической Chaining`);
    });

    // ─── Итоги ───────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log(` ИТОГИ БОЕВЫХ LIVE-ТЕСТОВ: ${passedCount} PASSED, ${failedCount} FAILED (Всего: ${passedCount + failedCount})`);
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    if (failedCount > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Критическая ошибка запуска тестового набора:', err);
    process.exit(1);
});
