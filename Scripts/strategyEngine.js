import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { callLLMWithFallback } from './llmClient.js';

const execAsync = promisify(exec);

// ─── Константы детекции ──────────────────────────────────────────────────────

const DOMAIN_KEYWORDS = {
    ui:    ['ui', 'экран', 'окно', 'popup', 'кнопк', 'layout', 'canvas', 'uipbase', 'uivbase', 'textmeshpro', 'интерфейс'],
    audio: ['звук', 'sfx', 'музык', 'audio', 'isoundsystem', 'voicesystem', 'озвучк'],
    logic: ['логик', 'алгоритм', 'систем', 'logicsystem', 'gamecomponent', 'модуль'],
    data:  ['данн', 'json', 'парс', 'импорт', 'экспорт', 'конверт', 'csv', 'лог', 'аналитик'],
    vfx:   ['vfx', 'частиц', 'particle', 'эффект', 'шейдер', 'shader', 'материал']
};

const TOOL_GAP_KEYWORDS = ['скрипт', 'утилит', 'конверт', 'автоматиз', 'парс', 'генерат', 'script', 'tool'];
const DATA_HEAVY_KEYWORDS = ['масс', 'bulk', '100+', 'все файлы', 'все классы', 'весь проект', 'рефакторинг', 'миграц'];
const DEP_KEYWORDS = ['после', 'на основе', 'используя результат', 'затем', 'далее', 'по итогам'];

// ─── Промпты для всех ролей ──────────────────────────────────────────────────

const PROMPTS = {
    chaining: {
        system: `Ты ИИ-исполнитель (Maker). Выполни ОДИН конкретный шаг задачи.
Верни ТОЛЬКО результат (код, текст, JSON) без вводных слов.
Не объясняй что ты делаешь — просто сделай.`,
        user: (step, previousOutput, context) =>
            `ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}

ПРЕДЫДУЩИЙ РЕЗУЛЬТАТ (если есть):
${previousOutput || '(первый шаг)'}

ТЕКУЩИЙ ШАГ #${step.index + 1}:
${step.criterion}

Выполни этот шаг. Верни только результат.`
    },

    routing: {
        system: `Ты маршрутизатор. Классифицируй задачу по домену.
Верни JSON: { "route_selected": "ui"|"audio"|"logic"|"data"|"vfx", "reasoning": "..." }
СТРОГО один домен. Не выполняй задачу, только классифицируй.`,
        user: (node, context) =>
            `ЗАДАЧА: ${node.title}
КРИТЕРИИ: ${(node.dod || []).map(d => d.criterion).join('; ')}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}`,
        workerSystem: (route) =>
            `Ты специализированный исполнитель домена "${route}".
Выполни задачу строго в рамках своего домена. Верни ТОЛЬКО результат.`,
        workerUser: (node, narrowContext) =>
            `ЗАДАЧА: ${node.title}
КОНТЕКСТ: ${narrowContext}
КРИТЕРИИ: ${(node.dod || []).map(d => d.criterion).join('; ')}

Выполни задачу.`
    },

    parallelization: {
        system: `Ты воркер. Выполни ОДНУ изолированную часть задачи.
Тебе дан только твой фрагмент. Другие части задачи решают другие воркеры.
Верни ТОЛЬКО результат.`,
        user: (part, node, context) =>
            `ОБЩАЯ ЗАДАЧА: ${node.title}
ТВОЙ ФРАГМЕНТ (#${part.index}): ${part.criterion}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}

Выполни свой фрагмент.`,
        collatorSystem: `Ты агрегатор результатов. Объедини результаты нескольких воркеров
в единое целостное решение. Устрани дублирование и конфликты.
Верни ТОЛЬКО объединённый результат.`,
        collatorUser: (results, node) =>
            `ЗАДАЧА: ${node.title}

РЕЗУЛЬТАТЫ ВОРКЕРОВ:
${results.map((r, i) => `--- Часть ${i} ---\n${r.result}\n`).join('\n')}

Объедини в единый результат.`
    },

    orchestrator: {
        system: `Ты оркестратор. Декомпозируй задачу на последовательные шаги.
Верни JSON:
{
  "steps": [
    { "id": "step_1", "task": "описание", "depends_on": [] },
    { "id": "step_2", "task": "описание", "depends_on": ["step_1"] }
  ]
}
Шагов: от 2 до 10. Каждый шаг — атомарная работа для одного воркера.`,
        user: (node, context) =>
            `ЗАДАЧА: ${node.title}
КРИТЕРИИ DoD: ${(node.dod || []).map(d => d.criterion).join('; ')}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}
ИНСТРУМЕНТЫ: ${(context.tools_available || []).join(', ') || 'нет'}`,
        workerSystem: `Ты воркер-исполнитель. Выполни ОДИН конкретный шаг плана.
Верни ТОЛЬКО результат (код, текст, JSON).`,
        workerUser: (step, depsContext, context) =>
            `ЗАДАНИЕ: ${step.task}
РЕЗУЛЬТАТЫ ПРЕДЫДУЩИХ ШАГОВ:
${depsContext || '(нет зависимостей)'}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}

Выполни задание.`,
        replanSystem: `Ты оркестратор. Предыдущий план провалился на одном из шагов.
Проанализируй ошибки и предложи НОВЫЙ план в том же JSON-формате.`,
        replanUser: (failedStep, opMemory, context) =>
            `ПРОВАЛИВШИЙСЯ ШАГ: ${failedStep.id} — ${failedStep.task}
ОШИБКА: ${opMemory.workers[failedStep.id]?.error || 'неизвестно'}
ТЕКУЩЕЕ СОСТОЯНИЕ: ${JSON.stringify(opMemory.workers, null, 2)}

Предложи исправленный план.`
    },

    mapReduce: {
        mapSystem: `Ты Map-воркер. Обработай ОДИН фрагмент данных.
Извлеки ключевую информацию и верни структурированный результат.`,
        mapUser: (dodItem, node, context) =>
            `ОБЩАЯ ЗАДАЧА: ${node.title}
ТВОЙ ФРАГМЕНТ: ${dodItem.criterion}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}

Обработай фрагмент.`,
        reduceSystem: `Ты Reduce-агрегатор. Объедини два фрагмента в один.
Сохрани всю информацию, устрани дублирование.`,
        reduceUser: (pair) =>
            `ФРАГМЕНТ A:\n${pair[0]}\n\nФРАГМЕНТ B:\n${pair[1] || '(нет)'}\n\nОбъедини.`
    },

    latm: {
        makerSystem: `Ты Tool Maker. Спроектируй и напиши Node.js скрипт-утилиту.
Верни JSON:
{
  "script_name": "tool_name.js",
  "language": "javascript",
  "code": "...(полный код скрипта)...",
  "test_cases": ["описание теста 1", "описание теста 2"]
}
Скрипт должен быть самодостаточным (ESM, без внешних зависимостей).`,
        makerUser: (node, context) =>
            `ЗАДАЧА: ${node.title}
КРИТЕРИИ: ${(node.dod || []).map(d => d.criterion).join('; ')}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}`,
        fixSystem: `Ты Tool Maker. Скрипт упал при тестировании. Исправь код.
Верни ТОЛЬКО исправленный код скрипта (без JSON-обёртки).`,
        fixUser: (spec, testResult) =>
            `ОРИГИНАЛЬНЫЙ КОД:\n${spec.code}\n\nОШИБКА:\n${testResult.errors}\n\nВЫВОД:\n${testResult.output}\n\nИсправь.`
    },

    evaluator: {
        planSystem: `Ты AI-Судья. Определи оптимальный способ валидации для задачи.
Верни JSON:
{
  "validation_method": "compile" | "test" | "lint" | "ai_review",
  "commands": ["команда 1", "команда 2"] | null,
  "reasoning": "почему выбран этот метод"
}
Используй "ai_review" только если нет доступных автоматических средств.`,
        planUser: (node, context) =>
            `ЗАДАЧА: ${node.title}
КРИТЕРИИ DoD: ${(node.dod || []).map(d => d.criterion).join('; ')}
ДОСТУПНЫЕ ИНСТРУМЕНТЫ: ${(context.tools_available || []).join(', ') || 'нет'}`,
        generatorSystem: `Ты генератор решений. Создай или исправь код/текст по задаче.
Если есть ошибки с прошлой итерации — исправь их.
Верни ТОЛЬКО результат.`,
        generatorUser: (node, context, lastErrors) =>
            `ЗАДАЧА: ${node.title}
КРИТЕРИИ: ${(node.dod || []).map(d => d.criterion).join('; ')}
ОГРАНИЧЕНИЯ: ${context.constraints_digest || 'нет'}
${lastErrors ? `\nОШИБКИ ПРОШЛОЙ ИТЕРАЦИИ:\n${lastErrors.join('\n')}` : ''}

${lastErrors ? 'Исправь ошибки и верни обновлённый результат.' : 'Создай решение.'}`,
        reviewSystem: `Ты строгий AI-Судья. Оцени решение по критериям DoD.
Верни JSON: { "pass": boolean, "errors": ["ошибка 1", ...] }`,
        reviewUser: (node, solution) =>
            `КРИТЕРИИ DoD:\n${(node.dod || []).map((d, i) => `${i + 1}. ${d.criterion}`).join('\n')}

РЕШЕНИЕ:\n${solution}

Оцени строго.`
    }
};

// ─── Детекция характеристик задачи ───────────────────────────────────────────

function detectDomains(text) {
    const detected = [];
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        if (keywords.some(kw => text.includes(kw))) {
            detected.push(domain);
        }
    }
    return detected;
}

function detectToolGap(text, availableTools) {
    const toolNames = availableTools.map(t => t.toLowerCase());
    return TOOL_GAP_KEYWORDS.some(kw => text.includes(kw)) &&
           !toolNames.some(t => text.includes(t));
}

function detectAutoTestCapability(tools) {
    const testIndicators = ['npm test', 'dotnet build', 'unity', 'jest', 'nunit', 'compile', 'lint'];
    return tools.some(t => testIndicators.some(ind => t.toLowerCase().includes(ind)));
}

function areSubtasksIndependent(dod) {
    const texts = dod.map(d => (d.criterion || '').toLowerCase());
    return !texts.some(text => DEP_KEYWORDS.some(kw => text.includes(kw)));
}

function buildNarrowContext(route, node, context) {
    return `Домен: ${route}\nЗадача: ${node.title}\nОграничения: ${context.constraints_digest || 'нет'}`;
}

// ─── selectStrategy ──────────────────────────────────────────────────────────

/**
 * Детерминированный выбор оптимальной стратегии на основе метрик задачи.
 * Не использует LLM — чистая логика.
 *
 * @param {string} taskDir
 * @param {object} node - узел из roadmap (title, dod, strategy)
 * @param {object} context - { constraints_digest, tools_available, dod }
 * @returns {Promise<string>} имя стратегии
 */
export async function selectStrategy(taskDir, node, context) {
    // 1. Если стратегия уже задана (Override Protocol)
    if (node.strategy && node.strategy !== 'None') {
        return node.strategy;
    }

    const title = `${node.title || ''} ${(node.dod || []).map(d => d.criterion).join(' ')}`.toLowerCase();
    const subtaskCount = (node.dod || []).length;

    // 2. Определяем характеристики
    const detectedDomains = detectDomains(title);
    const hasMixedDomains = detectedDomains.length >= 2;
    const needsNewTool = detectToolGap(title, context.tools_available || []);
    const hasAutoTests = detectAutoTestCapability(context.tools_available || []);
    const isDataHeavy = DATA_HEAVY_KEYWORDS.some(kw => title.includes(kw));
    const subtasksIndependent = areSubtasksIndependent(node.dod || []);

    // 3. Decision matrix (from RalphLoopPrinciples.md §2)
    if (subtaskCount <= 2) {
        if (hasMixedDomains) return 'Routing';
        if (needsNewTool) return 'LATM / Tool Maker';
        if (hasAutoTests) return 'Evaluator-Optimizer';
        return 'Prompt Chaining';
    } else {
        if (subtasksIndependent && !isDataHeavy) return 'Parallelization';
        if (isDataHeavy) return 'Map-Reduce';
        return 'Orchestrator-Workers';
    }
}

// ─── executeStrategy ─────────────────────────────────────────────────────────

/**
 * Исполняет выбранную стратегию.
 *
 * @param {string} name - имя стратегии
 * @param {string} taskDir - путь к директории задачи
 * @param {object} node - узел из roadmap
 * @param {object} context - контекст { constraints_digest, tools_available }
 * @returns {Promise<StrategyResult>}
 */
export async function executeStrategy(name, taskDir, node, context) {
    const executors = {
        'Prompt Chaining':       executePromptChaining,
        'Routing':               executeRouting,
        'Parallelization':       executeParallelization,
        'Orchestrator-Workers':  executeOrchestratorWorkers,
        'Map-Reduce':            executeMapReduce,
        'LATM / Tool Maker':     executeLATM,
        'Evaluator-Optimizer':   executeEvaluatorOptimizer
    };

    const executor = executors[name];
    if (!executor) {
        throw new Error(`Неизвестная стратегия: ${name}. Допустимые: ${Object.keys(executors).join(', ')}`);
    }

    try {
        return await executor(taskDir, node, context);
    } catch (err) {
        return {
            strategy: name,
            files_written: [],
            summary: `Ошибка стратегии ${name}: ${err.message}`,
            success: false,
            error: err.message
        };
    }
}

// ─── Стратегия 1: Prompt Chaining ────────────────────────────────────────────

async function executePromptChaining(taskDir, node, context) {
    const steps = (node.dod || []).map((d, i) => ({
        index: i,
        criterion: d.criterion
    }));

    // Если DoD пуст, создаём один шаг из title
    if (steps.length === 0) {
        steps.push({ index: 0, criterion: node.title });
    }

    const opMemory = { strategy: 'Prompt Chaining', iterations: [] };
    let previousOutput = '';

    for (const step of steps) {
        const result = await callLLMWithFallback('maker',
            PROMPTS.chaining.system,
            PROMPTS.chaining.user(step, previousOutput, context)
        );

        opMemory.iterations.push({
            step: step.index,
            criterion: step.criterion,
            output: result,
            timestamp: new Date().toISOString()
        });

        previousOutput = result;
    }

    const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
    await fs.writeFile(opMemoryPath, JSON.stringify(opMemory, null, 2), 'utf-8');

    return {
        strategy: 'Prompt Chaining',
        files_written: ['op_memory.json'],
        summary: `Выполнено ${steps.length} шагов цепочки. Все шаги записаны в op_memory.json.`,
        success: true,
        error: null
    };
}

// ─── Стратегия 2: Routing ────────────────────────────────────────────────────

async function executeRouting(taskDir, node, context) {
    // 1. Классификация маршрута
    const routeResult = await callLLMWithFallback('router',
        PROMPTS.routing.system,
        PROMPTS.routing.user(node, context),
        { jsonMode: true }
    );

    let route;
    try { route = JSON.parse(routeResult); }
    catch {
        const jsonMatch = routeResult.match(/\{[\s\S]*\}/);
        route = JSON.parse(jsonMatch ? jsonMatch[0] : '{"route_selected":"logic","reasoning":"fallback"}');
    }

    const routeSelected = route.route_selected || 'logic';

    // Записываем решение маршрутизации
    const routePath = path.resolve(taskDir, 'op_route.json');
    await fs.writeFile(routePath, JSON.stringify({
        strategy: 'Routing',
        route_selected: routeSelected,
        reasoning: route.reasoning || '',
        available_routes: Object.keys(DOMAIN_KEYWORDS),
        timestamp: new Date().toISOString()
    }, null, 2), 'utf-8');

    // 2. Формируем суженный контекст
    const narrowContext = buildNarrowContext(routeSelected, node, context);
    const taskFilePath = path.resolve(taskDir, `op_worker_task_${routeSelected}.json`);
    await fs.writeFile(taskFilePath, JSON.stringify({
        route: routeSelected,
        task_description: node.title,
        narrow_context: narrowContext,
        constraints: context.constraints_digest || ''
    }, null, 2), 'utf-8');

    // 3. Вызов специализированного воркера
    const workerResult = await callLLMWithFallback('worker',
        PROMPTS.routing.workerSystem(routeSelected),
        PROMPTS.routing.workerUser(node, narrowContext)
    );

    const resultFilePath = path.resolve(taskDir, `op_worker_result_${routeSelected}.json`);
    await fs.writeFile(resultFilePath, JSON.stringify({
        route: routeSelected,
        result: workerResult,
        status: 'SUCCESS',
        timestamp: new Date().toISOString()
    }, null, 2), 'utf-8');

    return {
        strategy: 'Routing',
        files_written: ['op_route.json', `op_worker_task_${routeSelected}.json`, `op_worker_result_${routeSelected}.json`],
        summary: `Задача маршрутизирована к '${routeSelected}'. Причина: ${route.reasoning || 'N/A'}`,
        success: true,
        error: null
    };
}

// ─── Стратегия 3: Parallelization ───────────────────────────────────────────

async function executeParallelization(taskDir, node, context) {
    const parts = (node.dod || []).map((d, i) => ({ index: i, criterion: d.criterion }));

    // 1. Записываем задания
    for (const part of parts) {
        await fs.writeFile(
            path.resolve(taskDir, `op_task_part_${part.index}.json`),
            JSON.stringify({
                part_index: part.index,
                criterion: part.criterion,
                context: context.constraints_digest || '',
                timestamp: new Date().toISOString()
            }, null, 2), 'utf-8'
        );
    }

    // 2. Параллельный запуск воркеров
    const results = await Promise.allSettled(
        parts.map(part =>
            callLLMWithFallback('worker',
                PROMPTS.parallelization.system,
                PROMPTS.parallelization.user(part, node, context)
            ).then(result => ({ part, result, status: 'SUCCESS' }))
             .catch(err => ({ part, result: null, status: 'FAIL', error: err.message }))
        )
    );

    // 3. Записываем результаты
    const filesWritten = [];
    const partResults = [];
    for (const settled of results) {
        const r = settled.status === 'fulfilled' ? settled.value : { part: { index: -1 }, result: null, status: 'FAIL', error: 'Promise rejected' };
        if (r.part.index < 0) continue;

        const partFile = `op_result_part_${r.part.index}.json`;
        await fs.writeFile(
            path.resolve(taskDir, partFile),
            JSON.stringify({
                part_index: r.part.index,
                result: r.result || null,
                status: r.status,
                error: r.error || null,
                timestamp: new Date().toISOString()
            }, null, 2), 'utf-8'
        );
        filesWritten.push(`op_task_part_${r.part.index}.json`, partFile);
        partResults.push(r);
    }

    // 4. Агрегация (collator)
    const successResults = partResults.filter(r => r.status === 'SUCCESS');

    let aggregated = '';
    if (successResults.length > 0) {
        aggregated = await callLLMWithFallback('collator',
            PROMPTS.parallelization.collatorSystem,
            PROMPTS.parallelization.collatorUser(successResults, node)
        );
    }

    const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
    await fs.writeFile(opMemoryPath, JSON.stringify({
        strategy: 'Parallelization',
        total_parts: parts.length,
        success_count: successResults.length,
        aggregated_result: aggregated,
        timestamp: new Date().toISOString()
    }, null, 2), 'utf-8');
    filesWritten.push('op_memory.json');

    return {
        strategy: 'Parallelization',
        files_written: [...new Set(filesWritten)],
        summary: `${successResults.length}/${parts.length} частей выполнены успешно. Результат агрегирован.`,
        success: successResults.length > 0,
        error: successResults.length === 0 ? 'Все воркеры упали' : null
    };
}

// ─── Стратегия 4: Orchestrator-Workers ──────────────────────────────────────

async function executeOrchestratorWorkers(taskDir, node, context) {
    const MAX_REPLAN = 2;
    const MAX_WORKER_ATTEMPTS = 3;
    const filesWritten = [];

    // 1. Оркестратор формирует план
    const planResponse = await callLLMWithFallback('orchestrator',
        PROMPTS.orchestrator.system,
        PROMPTS.orchestrator.user(node, context),
        { jsonMode: true }
    );

    let plan;
    try { plan = JSON.parse(planResponse); }
    catch {
        const jsonMatch = planResponse.match(/\{[\s\S]*\}/);
        plan = JSON.parse(jsonMatch ? jsonMatch[0] : '{"steps":[]}');
    }

    const opMemory = {
        strategy: 'Orchestrator-Workers',
        plan,
        workers: {},
        replan_count: 0
    };

    // 2. Исполнение по плану (с учётом зависимостей)
    const steps = plan.steps || [];
    for (const step of steps) {
        const deps = step.depends_on || [];
        const depsResolved = deps.every(depId =>
            opMemory.workers[depId]?.status === 'DONE'
        );
        if (!depsResolved) {
            opMemory.workers[step.id] = { status: 'BLOCKED', error: 'Зависимости не завершены' };
            continue;
        }

        // Собираем контексты от завершённых зависимостей
        let depsContext = '';
        for (const depId of deps) {
            try {
                const depResult = await fs.readFile(
                    path.resolve(taskDir, `op_worker_result_${depId}.json`), 'utf-8'
                );
                depsContext += `\nРезультат шага ${depId}:\n${JSON.parse(depResult).result}\n`;
            } catch { /* ignore */ }
        }

        // Попытки выполнения воркером
        let success = false;
        for (let attempt = 1; attempt <= MAX_WORKER_ATTEMPTS; attempt++) {
            const taskFile = `op_worker_task_${step.id}.json`;
            await fs.writeFile(
                path.resolve(taskDir, taskFile),
                JSON.stringify({
                    step_id: step.id,
                    task: step.task,
                    worker_context: `${context.constraints_digest || ''}\n${depsContext}`,
                    attempt
                }, null, 2), 'utf-8'
            );
            if (!filesWritten.includes(taskFile)) filesWritten.push(taskFile);

            try {
                const workerResult = await callLLMWithFallback('worker',
                    PROMPTS.orchestrator.workerSystem,
                    PROMPTS.orchestrator.workerUser(step, depsContext, context)
                );

                const resultFile = `op_worker_result_${step.id}.json`;
                await fs.writeFile(
                    path.resolve(taskDir, resultFile),
                    JSON.stringify({
                        step_id: step.id,
                        result: workerResult,
                        status: 'SUCCESS',
                        error: null,
                        timestamp: new Date().toISOString()
                    }, null, 2), 'utf-8'
                );
                if (!filesWritten.includes(resultFile)) filesWritten.push(resultFile);
                opMemory.workers[step.id] = { status: 'DONE', result_file: resultFile };
                success = true;
                break;
            } catch (err) {
                opMemory.workers[step.id] = { status: 'FAIL', error: err.message, attempt };
            }
        }

        // Перепланирование при провале
        if (!success && opMemory.replan_count < MAX_REPLAN) {
            opMemory.replan_count++;
            try {
                const replanResponse = await callLLMWithFallback('orchestrator',
                    PROMPTS.orchestrator.replanSystem,
                    PROMPTS.orchestrator.replanUser(step, opMemory, context),
                    { jsonMode: true }
                );
                let newPlan;
                try { newPlan = JSON.parse(replanResponse); }
                catch {
                    const match = replanResponse.match(/\{[\s\S]*\}/);
                    newPlan = JSON.parse(match ? match[0] : '{"steps":[]}');
                }
                opMemory.plan = newPlan;
                // Обновляем steps для оставшихся итераций
                // (В текущей реализации прерываем цикл и сохраняем результат)
            } catch { /* replan failed, continue */ }
        }
    }

    // 3. Сохраняем op_memory.json
    const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
    await fs.writeFile(opMemoryPath, JSON.stringify(opMemory, null, 2), 'utf-8');
    filesWritten.push('op_memory.json');

    const doneCount = Object.values(opMemory.workers).filter(w => w.status === 'DONE').length;
    return {
        strategy: 'Orchestrator-Workers',
        files_written: [...new Set(filesWritten)],
        summary: `${doneCount}/${steps.length} шагов выполнено. Перепланирований: ${opMemory.replan_count}.`,
        success: doneCount === steps.length,
        error: doneCount < steps.length ? 'Не все шаги выполнены' : null
    };
}

// ─── Стратегия 5: Map-Reduce ────────────────────────────────────────────────

async function executeMapReduce(taskDir, node, context) {
    const dod = node.dod || [];
    const filesWritten = [];

    // MAP фаза: параллельная обработка каждого DoD-критерия
    const mapPromises = dod.map((d, i) =>
        callLLMWithFallback('worker',
            PROMPTS.mapReduce.mapSystem,
            PROMPTS.mapReduce.mapUser(d, node, context)
        ).then(async result => {
            const file = `op_map_data_${i}.json`;
            await fs.writeFile(
                path.resolve(taskDir, file),
                JSON.stringify({
                    index: i,
                    criterion: d.criterion,
                    data: result,
                    timestamp: new Date().toISOString()
                }, null, 2), 'utf-8'
            );
            filesWritten.push(file);
            return result;
        }).catch(err => {
            console.warn(`[Map-Reduce] Map-воркер ${i} упал: ${err.message}`);
            return null;
        })
    );

    const mapResults = (await Promise.allSettled(mapPromises))
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter(r => r !== null);

    if (mapResults.length === 0) {
        return {
            strategy: 'Map-Reduce',
            files_written: filesWritten,
            summary: 'Все map-воркеры упали.',
            success: false,
            error: 'Все map-воркеры упали'
        };
    }

    // REDUCE фаза: иерархическая свёртка
    let current = [...mapResults];
    while (current.length > 1) {
        const pairs = [];
        for (let i = 0; i < current.length; i += 2) {
            pairs.push(current.slice(i, i + 2));
        }
        const reduceResults = await Promise.allSettled(
            pairs.map(pair =>
                callLLMWithFallback('collator',
                    PROMPTS.mapReduce.reduceSystem,
                    PROMPTS.mapReduce.reduceUser(pair)
                )
            )
        );
        current = reduceResults
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);

        if (current.length === 0) break;
    }

    // Финальный результат
    const finalResult = current[0] || 'Reduce не удался';
    const finalPath = path.resolve(taskDir, 'op_reduce_final.json');
    await fs.writeFile(finalPath, JSON.stringify({
        strategy: 'Map-Reduce',
        final_result: finalResult,
        map_count: mapResults.length,
        total: dod.length,
        timestamp: new Date().toISOString()
    }, null, 2), 'utf-8');
    filesWritten.push('op_reduce_final.json');

    const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
    await fs.writeFile(opMemoryPath, JSON.stringify({
        strategy: 'Map-Reduce',
        result: finalResult
    }, null, 2), 'utf-8');
    filesWritten.push('op_memory.json');

    return {
        strategy: 'Map-Reduce',
        files_written: filesWritten,
        summary: `Map: ${mapResults.length}/${dod.length}. Reduce свёртка завершена.`,
        success: true,
        error: null
    };
}

// ─── Стратегия 6: LATM / Tool Maker ─────────────────────────────────────────

async function executeLATM(taskDir, node, context) {
    const MAX_ATTEMPTS = 3;
    const filesWritten = [];

    // 1. Tool Maker генерирует скрипт
    const toolSpec = await callLLMWithFallback('maker',
        PROMPTS.latm.makerSystem,
        PROMPTS.latm.makerUser(node, context),
        { jsonMode: true }
    );

    let spec;
    try { spec = JSON.parse(toolSpec); }
    catch {
        const match = toolSpec.match(/\{[\s\S]*\}/);
        spec = match ? JSON.parse(match[0]) : {
            script_name: `tool_${(node.id || 'unknown').replace(/[^a-zA-Z0-9]/g, '_')}.js`,
            language: 'javascript',
            code: toolSpec,
            test_cases: []
        };
    }

    const makeFilePath = path.resolve(taskDir, 'op_tool_make.json');
    await fs.writeFile(makeFilePath, JSON.stringify(spec, null, 2), 'utf-8');
    filesWritten.push('op_tool_make.json');

    // 2. Записываем скрипт на диск
    const scriptName = spec.script_name || 'tool.js';
    const scriptPath = path.resolve(taskDir, scriptName);
    await fs.writeFile(scriptPath, spec.code || '', 'utf-8');
    filesWritten.push(scriptName);

    // 3. Тестирование (до 3 попыток)
    let testResult = { pass: false, output: '', errors: '' };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const { stdout, stderr } = await execAsync(`node "${scriptPath}"`, {
                cwd: taskDir,
                timeout: 30000
            });
            testResult = { pass: true, output: (stdout || '').trim(), errors: (stderr || '').trim() };
        } catch (err) {
            testResult = {
                pass: false,
                output: (err.stdout || '').trim(),
                errors: (err.stderr || err.message || '').trim()
            };

            if (attempt < MAX_ATTEMPTS) {
                const fixResponse = await callLLMWithFallback('maker',
                    PROMPTS.latm.fixSystem,
                    PROMPTS.latm.fixUser(spec, testResult)
                );
                spec.code = fixResponse;
                await fs.writeFile(scriptPath, fixResponse, 'utf-8');
                await fs.writeFile(makeFilePath, JSON.stringify(spec, null, 2), 'utf-8');
            }
        }

        if (testResult.pass) break;
    }

    // 4. Записываем результат тестов
    const useFilePath = path.resolve(taskDir, 'op_tool_use.json');
    await fs.writeFile(useFilePath, JSON.stringify({
        script_name: scriptName,
        test_pass: testResult.pass,
        output: (testResult.output || '').slice(0, 500),
        errors: (testResult.errors || '').slice(0, 500),
        timestamp: new Date().toISOString()
    }, null, 2), 'utf-8');
    filesWritten.push('op_tool_use.json');

    return {
        strategy: 'LATM / Tool Maker',
        files_written: filesWritten,
        summary: testResult.pass
            ? `Инструмент ${scriptName} создан и протестирован успешно.`
            : `Инструмент ${scriptName} не прошёл тесты после ${MAX_ATTEMPTS} попыток.`,
        success: testResult.pass,
        error: testResult.pass ? null : testResult.errors
    };
}

// ─── Стратегия 7: Evaluator-Optimizer ───────────────────────────────────────

async function executeEvaluatorOptimizer(taskDir, node, context) {
    const maxIterations = node.max_iterations || 5;
    const filesWritten = [];
    const feedbackLoop = { strategy: 'Evaluator-Optimizer', iterations: [] };

    // 1. Судья определяет способ валидации по контексту задачи
    const evalPlanResponse = await callLLMWithFallback('judge',
        PROMPTS.evaluator.planSystem,
        PROMPTS.evaluator.planUser(node, context),
        { jsonMode: true }
    );

    let evalPlan;
    try { evalPlan = JSON.parse(evalPlanResponse); }
    catch {
        const match = evalPlanResponse.match(/\{[\s\S]*\}/);
        evalPlan = match ? JSON.parse(match[0]) : { validation_method: 'ai_review', commands: null };
    }

    let lastErrors = null;
    let lastSolution = null;
    let passed = false;

    // 2. Цикл генерация → оценка
    for (let i = 0; i < maxIterations; i++) {
        // Генерация
        const solution = await callLLMWithFallback('maker',
            PROMPTS.evaluator.generatorSystem,
            PROMPTS.evaluator.generatorUser(node, context, lastErrors)
        );
        lastSolution = solution;

        // Оценка
        let feedback;
        if (evalPlan.validation_method !== 'ai_review' && evalPlan.commands?.length > 0) {
            // Детерминированная оценка
            const cmdResults = [];
            for (const cmd of evalPlan.commands) {
                try {
                    const { stdout } = await execAsync(cmd, { cwd: taskDir, timeout: 60000 });
                    cmdResults.push({ command: cmd, status: 'PASS', output: (stdout || '').trim().slice(0, 300) });
                } catch (err) {
                    cmdResults.push({ command: cmd, status: 'FAIL', output: ((err.stderr || err.message) || '').slice(0, 300) });
                }
            }
            const allPass = cmdResults.every(r => r.status === 'PASS');
            feedback = {
                pass: allPass,
                errors: cmdResults.filter(r => r.status === 'FAIL').map(r => `${r.command}: ${r.output}`)
            };
        } else {
            // AI-review (судья оценивает)
            const reviewResponse = await callLLMWithFallback('judge',
                PROMPTS.evaluator.reviewSystem,
                PROMPTS.evaluator.reviewUser(node, solution),
                { jsonMode: true }
            );
            try { feedback = JSON.parse(reviewResponse); }
            catch {
                const match = reviewResponse.match(/\{[\s\S]*\}/);
                feedback = match ? JSON.parse(match[0]) : { pass: false, errors: ['Не удалось распарсить ответ судьи'] };
            }
        }

        feedbackLoop.iterations.push({
            iteration: i + 1,
            solution_length: solution.length,
            validation_method: evalPlan.validation_method,
            pass: feedback.pass,
            errors: feedback.errors || [],
            timestamp: new Date().toISOString()
        });

        if (feedback.pass) { passed = true; break; }
        lastErrors = feedback.errors;
    }

    // 3. Сохранение
    const feedbackPath = path.resolve(taskDir, 'op_feedback_loop.json');
    await fs.writeFile(feedbackPath, JSON.stringify(feedbackLoop, null, 2), 'utf-8');
    filesWritten.push('op_feedback_loop.json');

    const opMemoryPath = path.resolve(taskDir, 'op_memory.json');
    await fs.writeFile(opMemoryPath, JSON.stringify({
        strategy: 'Evaluator-Optimizer',
        result: lastSolution,
        passed,
        iterations: feedbackLoop.iterations.length
    }, null, 2), 'utf-8');
    filesWritten.push('op_memory.json');

    return {
        strategy: 'Evaluator-Optimizer',
        files_written: filesWritten,
        summary: passed
            ? `Решение прошло валидацию за ${feedbackLoop.iterations.length} итераций.`
            : `Решение не прошло валидацию за ${feedbackLoop.iterations.length} итераций.`,
        success: passed,
        error: passed ? null : (lastErrors || []).join('; ')
    };
}
