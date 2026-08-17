import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkCodeSyntax } from './graph/syntaxGuard.js';
import { formalizeContract } from './graph/contractFormalizer.js';
import { distillSkillIfEligible } from './graph/skillDistiller.js';
import { HarnessDiskCheckpointer } from './graph/harnessCheckpointer.js';
import { HarnessModelAdapter } from './graph/modelAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDir = path.resolve(__dirname, '../.harness_tmp/test_efficiency');

async function main() {
    console.log('🧪 Запуск тестов модулей эффективности...');
    await fs.mkdir(testDir, { recursive: true });

    // 1. SyntaxGuard Tests
    console.log('1. Тестирование SyntaxGuard...');
    const validJson = JSON.stringify({ name: 'test', count: 123 });
    const invalidJson = '{ name: test, count: 123 }';
    assert.strictEqual(checkCodeSyntax(validJson, 'test.json').ok, true, 'Valid JSON should pass');
    assert.strictEqual(checkCodeSyntax(invalidJson, 'test.json').ok, false, 'Invalid JSON should fail');

    const validJs = 'const x = 10; function add(a, b) { return a + b; }';
    const invalidJs = 'const x = 10; function add(a, b) { return a + ';
    assert.strictEqual(checkCodeSyntax(validJs, 'script.js').ok, true, 'Valid JS should pass');
    assert.strictEqual(checkCodeSyntax(invalidJs, 'script.js').ok, false, 'Invalid JS should fail');
    console.log('  ✅ SyntaxGuard: все проверки пройдены.');

    // 2. ContractFormalizer Tests
    console.log('2. Тестирование ContractFormalizer...');
    const mockNode = {
        id: 'TACT-01',
        title: 'Создать модуль авторизации',
        artifact_kind: 'code',
        criticality: 'L2',
        dod: [
            { criterion: 'Создать файл src/auth.js с функциями login/logout' },
            { criterion: 'Запустить npm test и убедиться, что тесты зеленые' },
            { criterion: 'Проверить корректность синтаксиса AST' }
        ]
    };
    const contract = formalizeContract(mockNode);
    assert.strictEqual(contract.nodeId, 'TACT-01');
    assert.strictEqual(contract.predicates.length, 3);
    assert.strictEqual(contract.predicates[0].predicateType, 'file_exists');
    assert.strictEqual(contract.predicates[0].target, 'src/auth.js');
    assert.strictEqual(contract.predicates[1].predicateType, 'test_exit_0');
    assert.strictEqual(contract.predicates[2].predicateType, 'ast_valid');
    console.log('  ✅ ContractFormalizer: все предикаты успешно сопоставлены.');

    // 3. SkillDistiller Tests
    console.log('3. Тестирование SkillDistiller...');
    const nonEligible = await distillSkillIfEligible(testDir, { id: 'TACT-01', criticality: 'L1', iteration: 1 }, 'Done');
    assert.strictEqual(nonEligible.distilled, false, 'L1 at iter 1 should not distill');

    const eligibleL3 = await distillSkillIfEligible(testDir, { id: 'TACT-02', criticality: 'L3', iteration: 1, title: 'Архитектурный инвариант' }, 'Verified invariant');
    assert.strictEqual(eligibleL3.distilled, true, 'L3 node should distill');
    assert(eligibleL3.skillPath.endsWith('SKILL.md'));
    console.log('  ✅ SkillDistiller: синтез скилла работает корректно.');

    // 4. HarnessDiskCheckpointer Tests
    console.log('4. Тестирование HarnessDiskCheckpointer...');
    const checkpointer = new HarnessDiskCheckpointer({ baseDir: testDir });
    const testConfig = { configurable: { thread_id: 'task-test-1' } };
    const checkpoint = { id: 'cp-001', ts: Date.now(), channel_values: { status: 'IN_PROGRESS', nodeId: 'TACT-01' } };
    const savedConfig = await checkpointer.put(testConfig, checkpoint, { step: 1, langgraph_node: 'InitNode' });
    assert.strictEqual(savedConfig.configurable.checkpoint_id, 'cp-001');

    const tuple = await checkpointer.getTuple({ configurable: { thread_id: 'task-test-1', checkpoint_id: 'cp-001' } });
    assert.strictEqual(tuple.checkpoint.id, 'cp-001');
    assert.strictEqual(tuple.checkpoint.channel_values.nodeId, 'TACT-01');

    // Test Time-Travel Rollback
    const rolledBack = await checkpointer.rollbackToCheckpoint('task-test-1', 'cp-001');
    assert.strictEqual(rolledBack.checkpoint.id, 'cp-001');
    console.log('  ✅ HarnessDiskCheckpointer: чекпоинтинг, event stream и Time-Travel работают безупречно.');

    // 5. HarnessModelAdapter Tests
    console.log('5. Тестирование HarnessModelAdapter...');
    const adapter = new HarnessModelAdapter({ baseDir: testDir });
    const dryRunResult = await adapter.call({ taskDir: testDir, node: mockNode, dryRun: true });
    assert.strictEqual(dryRunResult.tokens, 50);
    assert(dryRunResult.text.includes('Simulated'));
    console.log('  ✅ HarnessModelAdapter: конфигуратор и dryRun работают корректно.');

    console.log('\n🎉 ВСЕ ТЕСТЫ МОДУЛЕЙ ЭФФЕКТИВНОСТИ УСПЕШНО ПРОЙДЕНЫ!');
}

main().catch(err => {
    console.error('❌ Ошибка теста:', err);
    process.exit(1);
});
