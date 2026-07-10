/**
 * Unit-тесты для selectStrategy() из strategyEngine.js
 * Запуск: node test_strategy_selection.js
 */
import { selectStrategy } from './strategyEngine.js';

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
    if (actual === expected) {
        console.log(`✅ ${name}: ${actual}`);
        passed++;
    } else {
        console.error(`❌ ${name}: ожидалось '${expected}', получено '${actual}'`);
        failed++;
    }
}

async function runTests() {
    console.log('=== Тесты selectStrategy ===\n');
    const baseContext = { constraints_digest: '', tools_available: [], dod: [] };

    // 1. Manual override — стратегия уже задана в roadmap
    assert('Override: сохранить заданную стратегию',
        await selectStrategy('', { strategy: 'Map-Reduce', title: 'Любая задача', dod: [{ criterion: 'x' }] }, baseContext),
        'Map-Reduce'
    );

    // 2. Prompt Chaining — 1 DoD, простая линейная задача
    assert('Prompt Chaining: 1 DoD, простая задача',
        await selectStrategy('', { strategy: 'None', title: 'Написать метод Calculate', dod: [{ criterion: 'Метод Calculate реализован' }] }, baseContext),
        'Prompt Chaining'
    );

    // 3. Routing — 1 DoD, смешанные домены (UI + Audio)
    assert('Routing: 1 DoD, смешанные домены (UI + Audio)',
        await selectStrategy('', { strategy: 'None', title: 'Интеграция экрана UI со звуком sfx', dod: [{ criterion: 'Экран и звук интегрированы' }] }, baseContext),
        'Routing'
    );

    // 4. LATM — 1 DoD, нужен новый скрипт/утилита
    assert('LATM: 1 DoD, нужен скрипт',
        await selectStrategy('', { strategy: 'None', title: 'Написать скрипт парсинга логов', dod: [{ criterion: 'Скрипт парсит логи' }] }, baseContext),
        'LATM / Tool Maker'
    );

    // 5. Evaluator-Optimizer — 1 DoD, есть автотесты
    assert('Evaluator-Optimizer: 1 DoD, есть npm test',
        await selectStrategy('', { strategy: 'None', title: 'Написать метод', dod: [{ criterion: 'Метод работает' }] }, { ...baseContext, tools_available: ['npm test'] }),
        'Evaluator-Optimizer'
    );

    // 6. Parallelization — 4 DoD, независимые критерии
    assert('Parallelization: 4 DoD, независимые',
        await selectStrategy('', { strategy: 'None', title: 'Документировать 4 класса', dod: [
            { criterion: 'Класс A документирован' },
            { criterion: 'Класс B документирован' },
            { criterion: 'Класс C документирован' },
            { criterion: 'Класс D документирован' }
        ] }, baseContext),
        'Parallelization'
    );

    // 7. Map-Reduce — 4 DoD, массивные данные (рефакторинг)
    assert('Map-Reduce: 4 DoD, массивные данные',
        await selectStrategy('', { strategy: 'None', title: 'Массовый рефакторинг всех файлов', dod: [
            { criterion: 'Файлы A обработаны' },
            { criterion: 'Файлы B обработаны' },
            { criterion: 'Файлы C обработаны' },
            { criterion: 'Файлы D обработаны' }
        ] }, baseContext),
        'Map-Reduce'
    );

    // 8. Orchestrator-Workers — 4 DoD, зависимые задачи
    assert('Orchestrator-Workers: 4 DoD, зависимые',
        await selectStrategy('', { strategy: 'None', title: 'Разработать игровой модуль', dod: [
            { criterion: 'Написать интерфейс' },
            { criterion: 'Реализовать на основе интерфейса' },
            { criterion: 'Затем написать тесты' },
            { criterion: 'Далее интегрировать' }
        ] }, baseContext),
        'Orchestrator-Workers'
    );

    // 9. Edge case: пустой DoD → Prompt Chaining (fallback)
    assert('Edge: пустой DoD → Prompt Chaining',
        await selectStrategy('', { strategy: 'None', title: 'Простая задача', dod: [] }, baseContext),
        'Prompt Chaining'
    );

    // 10. Edge case: strategy === undefined → автоклассификация
    assert('Edge: strategy=undefined → автоклассификация',
        await selectStrategy('', { title: 'Написать код', dod: [{ criterion: 'Код написан' }] }, baseContext),
        'Prompt Chaining'
    );

    // 11. Edge case: 2 DoD + mixed domains → Routing
    assert('Edge: 2 DoD + mixed domains → Routing',
        await selectStrategy('', { strategy: 'None', title: 'UI экран с частицами VFX', dod: [
            { criterion: 'Экран создан' },
            { criterion: 'Частицы добавлены' }
        ] }, baseContext),
        'Routing'
    );

    // 12. Edge case: 3 DoD + data heavy → Map-Reduce
    assert('Edge: 3 DoD + bulk → Map-Reduce',
        await selectStrategy('', { strategy: 'None', title: 'Миграция всех файлов', dod: [
            { criterion: 'Batch 1' },
            { criterion: 'Batch 2' },
            { criterion: 'Batch 3' }
        ] }, baseContext),
        'Map-Reduce'
    );

    console.log(`\n=== Результат: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
