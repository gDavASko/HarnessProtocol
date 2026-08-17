import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_SUITES = [
    { name: '1. Модули эффективности (SyntaxGuard, ContractFormalizer, SkillDistiller, Checkpointer)', file: 'test_efficiency_modules.js' },
    { name: '2. Изолированные сабграфы 7 канонических стратегий LangGraph', file: 'test_strategies_subgraphs.js' },
    { name: '3. Сквозной интеграционный тест LangGraph StateGraph рантайма', file: 'test_langgraph_flow.js' },
    { name: '4. Набор 23 боевых сценарных тестов алгоритмов, гейтов и кворумов', file: 'test_scenarios_suite.js' },
    { name: '5. Пять сложнейших живых задач стресс-теста (Графы, Монте-Карло, CRDT, ZK-SNARK, Rate-Limiter)', file: 'run_heavy_stresstest.js' },
    { name: '6. Чек-лист функционала полномасштабного приложения Harness Nexus (27 функций + Web UI)', file: '../Apps/harness-nexus/test/checklist_verifier.js' },
    { name: '7. Репликация игры Zuma Deluxe (10 канонических инвариантов, 5 уровней, Web Audio)', file: '../Apps/zuma-game/test/zuma_canonical_test.js' },
    { name: '8. Детерминированная классификация и выбор стратегий', file: 'test_strategy_selection.js' },
    { name: '9. CLI-транспорт, безопасность и устойчивость к длинным payload', file: 'test_cli_transport.js' },
    { name: '10. Смоук-тесты жизненного цикла и отрицательных гейтов', file: 'test_harness_flow.js' },
    { name: '11. Динамическая декомпозиция узлов в рантайме и адаптивное ветвление графа (ADR 0021)', file: 'test_dynamic_decomposition.js' }
];

async function main() {
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('       🛡️  HARNESS PROTOCOL — MASTER TEST RUNNER & VERIFIER           ');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    let totalPassed = 0;
    let totalFailed = 0;
    const startTime = Date.now();

    for (const suite of TEST_SUITES) {
        console.log(`▶️ Запуск: ${suite.name}...`);
        const filePath = path.resolve(__dirname, suite.file);
        try {
            const { stdout, stderr } = await execAsync(`node "${filePath}"`, {
                cwd: path.resolve(__dirname, '..'),
                timeout: 180000
            });
            console.log(stdout.trim());
            if (stderr && stderr.trim()) console.error(stderr.trim());
            console.log(`✅ [УСПЕХ] ${suite.name}\n`);
            totalPassed++;
        } catch (error) {
            console.error(`❌ [ОШИБКА] ${suite.name}:`);
            console.error(error.stdout || error.stderr || error.message);
            totalFailed++;
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`ИТОГИ ВСЕГО ТЕСТОВОГО СЬЮТА: ${totalPassed}/${TEST_SUITES.length} сьютов успешно пройдено за ${duration}с`);
    console.log(`Сбоев: ${totalFailed}`);
    console.log('═══════════════════════════════════════════════════════════════════════');

    if (totalFailed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Критический сбой мастер-тестера:', err);
    process.exit(1);
});
