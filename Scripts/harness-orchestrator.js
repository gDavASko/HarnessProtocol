import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { callLLM } from './llmClient.js';
import { selectStrategy, executeStrategy } from './strategyEngine.js';
import { readState, readRoadmap, getCurrentNode, fileExists, readClean } from './harnessState.js';

const execAsync = promisify(exec);

async function runScript(scriptName, args, taskDir) {
    const scriptPath = path.resolve(import.meta.dirname || __dirname, scriptName);
    try {
        const { stdout } = await execAsync(`node "${scriptPath}" "${taskDir}" ${args.join(' ')}`);
        return { success: true, data: JSON.parse(stdout.trim()) };
    } catch (error) {
        return { success: false, error: error.stdout || error.stderr || error.message };
    }
}

async function getFileContent(taskDir, relativePath) {
    const fullPath = path.resolve(taskDir, relativePath);
    if (await fileExists(fullPath)) {
        return await readClean(fullPath);
    }
    return '';
}

async function orchestrateNode(taskDir, node) {
    console.log(`\n=== 🚀 Запуск узла: ${node.id} (${node.title}) ===`);
    console.log(`Виток: #${node.iteration}/${node.max_iterations}`);

    // ─── WS-5: гибрид «двух мозгов» по типу узла ──────────────────────────────
    // Автономный движок (этот оркестратор) обрабатывает ТОЛЬКО не-кодовые узлы
    // (сценарии/ГДД/тексты). Кодовые узлы исполняет IDE-агент в рабочем дереве,
    // потому что стратегии пишут op_*.json-блобы, а не правки репозитория.
    if ((node.artifact_kind || 'code') === 'code') {
        console.log(`⏸️ Узел ${node.id} имеет artifact_kind=code → исполнитель IDE-агент, не автономный движок.`);
        console.log(`   Автономный оркестратор пропускает кодовые узлы (Вариант 3).`);
        return { success: true, action: 'NEEDS_IDE_AGENT' };
    }

    // 1. Собираем контекст для стратегического движка
    const constraints = await getFileContent(taskDir, 'forks/tactical_constraints.md');
    const toolsRegistry = await getFileContent(taskDir, 'forks/tactical_tools_registry.md');

    // Извлекаем список доступных инструментов из Форка-4
    const toolsAvailable = [];
    const toolMatches = toolsRegistry.match(/\*\s*\*\*\[(?:SKILL|TOOL)\]\*\*\s*`([^`]+)`/g);
    if (toolMatches) {
        for (const m of toolMatches) {
            const nameMatch = m.match(/`([^`]+)`/);
            if (nameMatch) toolsAvailable.push(nameMatch[1]);
        }
    }

    const context = {
        constraints_digest: constraints.slice(0, 1500),
        tools_available: toolsAvailable,
        dod: node.dod
    };

    // 2. Выбор стратегии (детерминированный)
    const strategyName = await selectStrategy(taskDir, node, context);
    console.log(`📋 Стратегия: ${strategyName}`);
    node.strategy = strategyName;

    // 3. Исполнение стратегии
    console.log(`Исполнение стратегии '${strategyName}'...`);
    let stratResult;
    try {
        stratResult = await executeStrategy(strategyName, taskDir, node, context);
        console.log(`${stratResult.success ? '✅' : '❌'} ${stratResult.summary}`);
    } catch (err) {
        console.error(`❌ Ошибка стратегии: ${err.message}`);
        return { success: false, action: 'RETRY_LLM', error: err.message };
    }

    if (!stratResult.success) {
        console.error(`❌ Стратегия '${strategyName}' завершилась с ошибкой: ${stratResult.error}`);
    }

    // 4. Сохраняем артефакт узла (summary)
    const artifactName = `result_${node.id}.md`;
    await fs.writeFile(path.resolve(taskDir, artifactName),
        `# ${node.id}: ${node.title}\n\n**Стратегия:** ${strategyName}\n\n${stratResult.summary}\n\n**Файлы:** ${stratResult.files_written.join(', ')}`,
        'utf-8'
    );
    console.log(`💾 Решение сохранено в ${artifactName}`);

    // 3. Формируем отчет (contextAssembler --mode validate)
    console.log(`Генерация отчета валидации...`);
    const reportRes = await runScript('contextAssembler.js', ['--mode', 'validate', '--node', node.id], taskDir);
    if (!reportRes.success) {
        console.error(`❌ Ошибка генерации отчета:`, reportRes.error);
        return { success: false, action: 'FAIL_REPORT' };
    }

    // 4. Валидация (validator.js)
    console.log(`Запуск валидатора (тип: ${node.validation_type})...`);
    let valArgs = ['--node', node.id, '--type', node.validation_type];
    if (node.validation_type === 'auto') {
        // Заглушка: для auto нужно передавать --cmd
        valArgs.push('--cmd', 'npm test');
    }

    const valRes = await runScript('validator.js', valArgs, taskDir);
    if (!valRes.success && node.validation_type !== 'human') {
        console.log(`❌ Валидация не пройдена (или ошибка скрипта).`);
    } else {
        console.log(`✅ Результат валидации: ${valRes.data?.result || valRes.data?.overall || 'AWAITING_HUMAN'}`);
    }

    if (node.validation_type === 'human') {
        console.log(`⏸️ Остановка для ручной валидации. Отчет готов.`);
        return { success: true, action: 'AWAITING_HUMAN' };
    }

    if (valRes.data?.action === 'NEEDS_SUBAGENT_JUDGE') {
        console.log('🧑‍⚖️ Внешние CLI-судьи недоступны — валидацию выполняет независимый субагент IDE-агента (см. ai_judge_task.md). Автономный прогон остановлен.');
        return { success: true, action: 'NEEDS_SUBAGENT_JUDGE' };
    }

    const isPass = (valRes.data?.result === 'PASS' || valRes.data?.overall === 'PASS');
    const comment = valRes.data?.comment || 'Неизвестная ошибка';

    // 5. Продвижение (loopAdvancer)
    console.log(`Продвижение цикла...`);
    const status = isPass ? 'SUCCESS' : 'FAIL';
    const advRes = await runScript('loopAdvancer.js', ['--node', node.id, '--status', status, '--insight', `"${comment}"`], taskDir);
    
    if (!advRes.success) {
        console.error(`❌ Ошибка loopAdvancer:`, advRes.error);
        return { success: false, action: 'FAIL_ADVANCE' };
    }

    console.log(`🔄 Действие: ${advRes.data.action}`);
    return { success: true, action: advRes.data.action };
}

async function main() {
    const taskDir = process.argv[2];
    if (!taskDir) {
        console.error('Использование: node harness-orchestrator.js <task_dir>');
        process.exit(1);
    }

    console.log(`Запуск Harness Orchestrator для задачи: ${taskDir}`);

    let isRunning = true;
    while (isRunning) {
        const state = await readState(taskDir);
        const roadmap = await readRoadmap(taskDir);
        
        if (state.stage === 'awaiting_human_validation') {
            console.log('Ожидается ручная валидация. Завершение работы оркестратора.');
            break;
        }

        if (state.stage === 'awaiting_subagent_validation') {
            console.log('Ожидается вердикт субагента-судьи (fallback). Передайте управление IDE-агенту: он запускает независимого субагента по ai_judge_task.md и вызывает validator.js --judge-file.');
            break;
        }

        if (roadmap.status === 'DONE') {
            console.log('Задача успешно завершена!');
            break;
        }

        if (state.stage === 'awaiting_context') {
            console.log('Сборка контекста (init)...');
            await runScript('contextAssembler.js', ['--mode', 'init'], taskDir);
        } else if (state.stage === 'validated') {
            console.log('Сборка контекста (step)...');
            await runScript('contextAssembler.js', ['--mode', 'step'], taskDir);
        }

        // Заново читаем roadmap после возможных изменений
        const freshRoadmap = await readRoadmap(taskDir);
        const currentNode = getCurrentNode(freshRoadmap);
        if (!currentNode) {
            console.log('Нет активных узлов для выполнения.');
            break;
        }

        const result = await orchestrateNode(taskDir, currentNode);
        
        if (result.action === 'TASK_COMPLETE') {
            console.log('🏁 Задача выполнена.');
            isRunning = false;
        } else if (result.action === 'AWAITING_HUMAN') {
            isRunning = false;
        } else if (result.action === 'NEEDS_IDE_AGENT') {
            console.log('🧠 action=NEEDS_IDE_AGENT — узел кодовый. Передайте управление IDE-агенту (skill davasko-harness-dispatcher). Автономный прогон остановлен.');
            isRunning = false;
        } else if (result.action === 'NEEDS_SUBAGENT_JUDGE') {
            isRunning = false;
        } else if (result.action === 'CRITICAL_FAIL') {
            console.error('🛑 Критическая ошибка. Лимит итераций исчерпан.');
            isRunning = false;
        }
        // Если action === 'ADVANCE_TO_NEXT' или 'RETRY', цикл продолжается
    }
}

main().catch(err => {
    console.error('Непредвиденная ошибка:', err);
    process.exit(1);
});
