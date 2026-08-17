import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { HarnessDiskCheckpointer } from './graph/harnessCheckpointer.js';
import { HarnessModelAdapter } from './graph/modelAdapter.js';
import { createTaskOrchestratorGraph } from './graph/taskOrchestratorGraph.js';
import { createRalphLoopSubgraph } from './graph/ralphLoopSubgraph.js';
import { writeRoadmap, writeState } from './harnessState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testTaskDir = path.resolve(__dirname, '../.harness_tmp/test_task_langgraph');

async function main() {
    console.log('🧪 Запуск сквозного интеграционного теста LangGraph StateGraph рантайма...');
    await fs.mkdir(testTaskDir, { recursive: true });

    // 1. Создаем синтетическую задачу с 3 узлами
    const mockRoadmap = {
        title: 'Тестовая задача интеграции LangGraph',
        status: 'IN_PROGRESS',
        nodes: [
            {
                id: 'TACT-01',
                title: 'Генерация структуры документа',
                artifact_kind: 'text',
                strategy: 'chaining',
                criticality: 'L1',
                validation_type: 'auto',
                status: 'PENDING',
                iteration: 1,
                max_iterations: 3,
                dod: [{ criterion: 'Сформировать структуру разделов' }]
            },
            {
                id: 'TACT-02',
                title: 'Синтез утилиты через LATM',
                artifact_kind: 'text',
                strategy: 'latm',
                criticality: 'L2',
                validation_type: 'auto',
                status: 'PENDING',
                iteration: 1,
                max_iterations: 3,
                dod: [{ criterion: 'Сгенерировать и выполнить скрипт' }]
            },
            {
                id: 'TACT-03',
                title: 'Системный инвариант L3',
                artifact_kind: 'text',
                strategy: 'evaluator_optimizer',
                criticality: 'L3',
                validation_type: 'auto',
                status: 'PENDING',
                iteration: 1,
                max_iterations: 3,
                dod: [{ criterion: 'Проверить архитектурное соответствие' }]
            }
        ]
    };

    await writeRoadmap(testTaskDir, mockRoadmap);
    await writeState(testTaskDir, { stage: 'awaiting_context', active_node: 'TACT-01' });

    const checkpointer = new HarnessDiskCheckpointer({ baseDir: testTaskDir });
    const modelAdapter = new HarnessModelAdapter({ baseDir: testTaskDir });
    const taskId = 'test_task_langgraph';
    const config = { configurable: { thread_id: taskId } };

    // 2. Тестируем RalphLoopSubgraph в изоляции
    console.log('\n1. Тестирование RalphLoopSubgraph...');
    const ralphSubgraph = createRalphLoopSubgraph({ modelAdapter, dryRun: true });
    const ralphResult = await ralphSubgraph.invoke({
        taskDir: testTaskDir,
        nodeId: 'TACT-01',
        node: mockRoadmap.nodes[0],
        iteration: 1,
        maxIterations: 3,
        context: { dryRun: true }
    });

    assert.strictEqual(ralphResult.action, 'ADVANCE_TO_NEXT', 'Ralph loop should advance on pass');
    assert.strictEqual(ralphResult.contract.nodeId, 'TACT-01');
    assert.strictEqual(ralphResult.syntaxCheck.ok, true);
    console.log('  ✅ RalphLoopSubgraph успешно продвинул узел и проверил контракт.');

    // 3. Тестируем полный TaskOrchestratorGraph
    console.log('\n2. Тестирование TaskOrchestratorGraph...');
    const orchestratorGraph = createTaskOrchestratorGraph({
        modelAdapter,
        checkpointer,
        dryRun: true
    });

    const taskOutput = await orchestratorGraph.invoke({
        taskDir: testTaskDir,
        taskId,
        roadmap: mockRoadmap,
        status: 'IN_PROGRESS'
    }, config);

    assert.strictEqual(taskOutput.status, 'COMPLETED', 'All 3 nodes should be completed');
    console.log('  ✅ TaskOrchestratorGraph успешно выполнил все 3 узла и закрыл задачу.');

    // 4. Проверяем чекпоинты и Event Stream на диске
    console.log('\n3. Проверка персистентности чекпоинтов и Event Stream...');
    const threadDir = checkpointer.getThreadDir(taskId);
    const eventStreamPath = path.join(threadDir, 'event_stream.jsonl');
    const eventStreamExists = await fs.stat(eventStreamPath).then(() => true).catch(() => false);
    assert.strictEqual(eventStreamExists, true, 'event_stream.jsonl must exist on disk');

    const eventContent = await fs.readFile(eventStreamPath, 'utf-8');
    const events = eventContent.trim().split('\n').map(l => JSON.parse(l));
    assert(events.length >= 3, 'Must have recorded multiple events');
    console.log(`  ✅ Event Stream зафиксировал ${events.length} событий на диске.`);

    // 5. Проверяем Time-Travel Rollback
    console.log('\n4. Проверка Time-Travel Rollback...');
    const firstCp = events[0].checkpoint_id;
    const rolledBack = await checkpointer.rollbackToCheckpoint(taskId, firstCp);
    assert.strictEqual(rolledBack.checkpoint.id, firstCp);
    console.log('  ✅ Time-Travel Rollback успешно откатил состояние к первому чекпоинту.');

    console.log('\n🎉 ВСЕ СКВОЗНЫЕ ИНТЕГРАЦИОННЫЕ ТЕСТЫ LANGGRAPH РАНТАЙМА УСПЕШНО ПРОЙДЕНЫ!');
}

main().catch(err => {
    console.error('❌ Ошибка интеграционного теста:', err);
    process.exit(1);
});
