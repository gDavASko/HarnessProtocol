import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { strategyRegistry } from './graph/strategies/strategyRegistry.js';
import { HarnessModelAdapter } from './graph/modelAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDir = path.resolve(__dirname, '../.harness_tmp/test_strategies');

async function main() {
    console.log('🧪 Запуск изолированных тестов всех 7 сабграфов стратегий...');
    await fs.mkdir(testDir, { recursive: true });

    const modelAdapter = new HarnessModelAdapter({ baseDir: testDir });
    const strategies = strategyRegistry.list();
    assert.strictEqual(strategies.length, 7, 'Should have exactly 7 registered strategies');

    const mockNode = {
        id: 'TACT-01',
        title: 'Тестовая обработка данных',
        dod: [
            { criterion: 'Собрать входные параметры' },
            { criterion: 'Трансформировать данные и вернуть JSON' }
        ]
    };

    for (const stratInfo of strategies) {
        console.log(`\nTesting strategy: ${stratInfo.name} (${stratInfo.id})...`);
        const plugin = strategyRegistry.get(stratInfo.id);
        assert(plugin, `Plugin ${stratInfo.id} must exist`);

        const subgraph = plugin.createSubgraph({ modelAdapter });
        assert(subgraph, `Compiled subgraph for ${stratInfo.id} must exist`);

        const initialState = {
            taskDir: testDir,
            node: mockNode,
            context: { dryRun: true, constraints_digest: 'Тестовые ограничения' }
        };

        const finalState = await subgraph.invoke(initialState);
        assert(finalState.result, `Strategy ${stratInfo.id} must produce a result`);
        assert.strictEqual(finalState.result.success, true, `Strategy ${stratInfo.id} execution must succeed`);
        assert.strictEqual(finalState.result.strategy, stratInfo.id);
        console.log(`  ✅ Strategy ${stratInfo.id}: subgraph compiled and invoked successfully. Summary length: ${finalState.result.summary?.length || 0}`);
    }

    console.log('\n🎉 ВСЕ 7 САБГРАФОВ СТРАТЕГИЙ УСПЕШНО ПРОТЕСТИРОВАНЫ В ИЗОЛЯЦИИ!');
}

main().catch(err => {
    console.error('❌ Ошибка теста сабграфов стратегий:', err);
    process.exit(1);
});
