import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';

export const chainingPlugin = {
    id: 'chaining',
    aliases: ['prompt_chaining', 'chain'],
    name: 'Prompt Chaining',
    description: 'Sequential step-by-step DoD criteria execution updating op_memory.json.',
    weapons: ['read_file', 'write_clean'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('initSteps', async (state) => {
                const dod = state.node?.dod || [];
                const steps = dod.map((item, index) => ({
                    index,
                    criterion: typeof item === 'string' ? item : item.criterion
                }));
                return { steps, stepIndex: 0, feedbackHistory: [] };
            })
            .addNode('executeStep', async (state) => {
                const step = state.steps[state.stepIndex];
                if (!step) return {};

                const prevMemory = state.feedbackHistory.slice(-1)[0] || '';
                const systemPrompt = 'Ты ИИ-исполнитель (Maker). Выполни ОДИН конкретный шаг задачи.\nВерни ТОЛЬКО результат без лишних слов.';
                const userPrompt = `ОГРАНИЧЕНИЯ: ${state.context?.constraints_digest || 'нет'}\n\nПРЕДЫДУЩИЙ ШАГ: ${prevMemory || '(первый шаг)'}\n\nТЕКУЩИЙ ШАГ #${step.index + 1}: ${step.criterion}\n\nВыполни шаг.`;

                const resp = await modelAdapter.call({
                    taskDir: state.taskDir,
                    node: state.node,
                    role: 'worker',
                    systemPrompt,
                    userPrompt,
                    dryRun: state.context?.dryRun || false
                });

                const stepOutput = resp.text || `[Chaining output for step ${step.index + 1}]`;
                return {
                    feedbackHistory: [stepOutput],
                    stepIndex: state.stepIndex + 1
                };
            })
            .addNode('compileResult', async (state) => {
                const summary = state.feedbackHistory.join('\n\n---\n\n');
                
                // Write L1 op_memory.json
                if (state.taskDir) {
                    try {
                        const opMemoryPath = path.join(state.taskDir, 'op_memory.json');
                        await fs.writeFile(opMemoryPath, JSON.stringify({
                            strategy: 'chaining',
                            steps: state.steps,
                            outputs: state.feedbackHistory,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'chaining',
                        summary,
                        files_written: ['op_memory.json']
                    }
                };
            })
            .addEdge(START, 'initSteps')
            .addEdge('initSteps', 'executeStep')
            .addConditionalEdges('executeStep', (state) => {
                return state.stepIndex < state.steps.length ? 'executeStep' : 'compileResult';
            })
            .addEdge('compileResult', END);

        return graph.compile();
    }
};
