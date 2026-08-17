import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { createTaskOrchestratorGraph } from './graph/taskOrchestratorGraph.js';
import { HarnessDiskCheckpointer } from './graph/harnessCheckpointer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_TASK_DIR = path.join(ROOT_DIR, 'Tasks', 'test_dynamic_fracturing_task');

async function testDynamicDecomposition() {
    console.log('🧪 Тестирование динамической декомпозиции узлов (ADR 0021)...');

    await fs.mkdir(TEST_TASK_DIR, { recursive: true });

    // Initial Roadmap with 1 large complex node having 4 DoD criteria
    const initialRoadmap = {
        version: 1,
        nodes: [
            {
                id: 'BIG-NODE-01',
                title: 'Комплексный стресс-тест физики и графики',
                strategy: 'evaluator_optimizer',
                criticality: 'L3',
                validation_type: 'hybrid',
                artifact_kind: 'code',
                status: 'PENDING',
                dod: [
                    'Проверить коллизии шаров',
                    'Проверить магнитный пулбек',
                    'Проверить WebGL рендеринг',
                    'Проверить частицы взрыва'
                ]
            }
        ],
        current_node_id: 'BIG-NODE-01',
        global_status: 'IN_PROGRESS'
    };

    await fs.writeFile(path.join(TEST_TASK_DIR, '.harness_roadmap.json'), JSON.stringify(initialRoadmap, null, 2), 'utf8');

    const graph = createTaskOrchestratorGraph({ dryRun: true });

    const finalState = await graph.invoke(
        {
            taskDir: TEST_TASK_DIR,
            roadmap: initialRoadmap,
            status: 'IN_PROGRESS'
        },
        { configurable: { thread_id: 'test-decomposition-thread' }, recursionLimit: 100 }
    );

    const savedRoadmap = JSON.parse(await fs.readFile(path.join(TEST_TASK_DIR, '.harness_roadmap.json'), 'utf8'));
    console.log(`📋 Итоговое количество узлов после динамического дробления: ${savedRoadmap.nodes.length}`);
    
    // Should have 4 child sub-nodes + 1 aggregator node = 5 nodes
    assert(savedRoadmap.nodes.length >= 4, 'Узел должен был динамически раздробиться на 4 под-узла');
    console.log('  ✅ Обнаружены дочерние суб-узлы:');
    savedRoadmap.nodes.forEach(n => console.log(`     - [${n.status}] ${n.id}: ${n.title}`));

    assert.strictEqual(finalState.status, 'COMPLETED', 'Граф должен успешно закрыть задачу после прогона всех под-узлов');
    console.log('🎉 ТЕСТ ДИНАМИЧЕСКОГО ДРОБЛЕНИЯ (ADR 0021) УСПЕШНО ПРОЙДЕН!\n');

    // Cleanup
    await fs.rm(TEST_TASK_DIR, { recursive: true, force: true });
}

testDynamicDecomposition().catch(err => {
    console.error('Ошибка в тесте динамического дробления:', err);
    process.exit(1);
});
