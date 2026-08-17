import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';
import { checkCodeSyntax } from '../syntaxGuard.js';

export const evaluatorOptimizerPlugin = {
    id: 'evaluator_optimizer',
    aliases: ['eval_opt', 'generator_evaluator'],
    name: 'Evaluator-Optimizer',
    description: 'Iterative refinement loop between a Generator and an isolated Evaluator critic with feedback tracking.',
    weapons: ['read_file', 'write_clean', 'lint_checker'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('generatorNode', async (state) => {
                const latestFeedback = state.feedbackHistory.slice(-1)[0] || '';
                const systemPrompt = 'Ты генератор решений (Generator). Создай или улучши решение на основе замечаний критика.\nВерни только готовое решение.';
                const userPrompt = `ЗАДАЧА: ${state.node?.title}\nКРИТЕРИИ: ${(state.node?.dod || []).map(d => typeof d === 'string' ? d : d.criterion).join('; ')}\n\nЗАМЕЧАНИЯ КРИТИКА:\n${latestFeedback || '(первая итерация генерации)'}`;

                let draft = `[Generated draft for ${state.node?.id}]`;
                if (modelAdapter && !state.context?.dryRun) {
                    const resp = await modelAdapter.call({
                        taskDir: state.taskDir,
                        node: state.node,
                        role: 'worker',
                        systemPrompt,
                        userPrompt,
                        dryRun: state.context?.dryRun || false
                    });
                    draft = resp.text || draft;
                }
                return { result: draft, stepIndex: state.stepIndex + 1 };
            })
            .addNode('evaluatorNode', async (state) => {
                const draft = typeof state.result === 'string' ? state.result : JSON.stringify(state.result);
                
                // 1. Fast Pre-Commit Syntax Check
                const syntax = checkCodeSyntax(draft, 'generated_draft.txt');
                if (!syntax.ok) {
                    return {
                        feedbackHistory: [`[Синтаксическая ошибка]: ${syntax.error}. Исправь синтаксис.`],
                        error: 'SYNTAX_FAIL'
                    };
                }

                // 2. Evaluator Critic Check
                const systemPrompt = 'Ты независимый критик (Evaluator). Оцени решение строго по критериям.\nЕсли решение удовлетворяет всем требованиям, верни: { "verdict": "PASS", "feedback": "..." }\nЕсли есть недочеты, верни: { "verdict": "NEEDS_REVISION", "feedback": "..." }';
                const userPrompt = `КРИТЕРИИ: ${(state.node?.dod || []).map(d => typeof d === 'string' ? d : d.criterion).join('; ')}\n\nРЕШЕНИЕ ДЛЯ ОЦЕНКИ:\n${draft}`;

                let verdict = 'PASS';
                let feedback = 'All criteria met.';

                if (modelAdapter && !state.context?.dryRun) {
                    try {
                        const resp = await modelAdapter.call({
                            taskDir: state.taskDir,
                            node: state.node,
                            role: 'evaluator',
                            systemPrompt,
                            userPrompt
                        });
                        const match = resp.text.match(/\{[\s\S]*\}/);
                        if (match) {
                            const parsed = JSON.parse(match[0]);
                            verdict = parsed.verdict || 'PASS';
                            feedback = parsed.feedback || feedback;
                        }
                    } catch (e) {}
                }

                return {
                    feedbackHistory: [feedback],
                    error: verdict === 'PASS' ? null : 'NEEDS_REVISION'
                };
            })
            .addNode('compileResult', async (state) => {
                const summary = typeof state.result === 'string' ? state.result : JSON.stringify(state.result);

                if (state.taskDir) {
                    try {
                        await fs.writeFile(path.join(state.taskDir, 'op_feedback_loop.json'), JSON.stringify({
                            strategy: 'evaluator_optimizer',
                            iterations: state.stepIndex,
                            feedback_history: state.feedbackHistory,
                            final_solution: summary,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'evaluator_optimizer',
                        iterations: state.stepIndex,
                        summary,
                        files_written: ['op_feedback_loop.json']
                    }
                };
            })
            .addEdge(START, 'generatorNode')
            .addEdge('generatorNode', 'evaluatorNode')
            .addConditionalEdges('evaluatorNode', (state) => {
                if (!state.error || state.stepIndex >= 3) {
                    return 'compileResult';
                }
                return 'generatorNode';
            })
            .addEdge('compileResult', END);

        return graph.compile();
    }
};
