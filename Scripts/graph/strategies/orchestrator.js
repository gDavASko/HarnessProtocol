import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';

export const orchestratorPlugin = {
    id: 'orchestrator',
    aliases: ['orchestrator_workers', 'dynamic_plan'],
    name: 'Orchestrator-Workers',
    description: 'Dynamic step decomposition with sequential worker execution.',
    weapons: ['read_file', 'write_clean'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('planSteps', async (state) => {
                const systemPrompt = 'Ты планировщик-оркестратор. Декомпозируй задачу на 2-4 последовательных шага.\nВерни JSON: { "steps": [ { "id": "step_1", "task": "..." } ] }';
                const userPrompt = `ЗАДАЧА: ${state.node?.title}\nКРИТЕРИИ: ${(state.node?.dod || []).map(d => typeof d === 'string' ? d : d.criterion).join('; ')}`;

                let steps = [];
                if (!state.context?.dryRun) {
                    try {
                        const resp = await modelAdapter.call({
                            taskDir: state.taskDir,
                            node: state.node,
                            role: 'manager',
                            systemPrompt,
                            userPrompt
                        });
                        const match = resp.text.match(/\{[\s\S]*\}/);
                        if (match) {
                            const parsed = JSON.parse(match[0]);
                            steps = parsed.steps || [];
                        }
                    } catch (e) {}
                }

                if (steps.length === 0) {
                    steps = (state.node?.dod || [{ criterion: state.node?.title || 'Main Task' }]).map((d, i) => ({
                        id: `step_${i + 1}`,
                        task: typeof d === 'string' ? d : d.criterion
                    }));
                }

                return { steps, stepIndex: 0, feedbackHistory: [] };
            })
            .addNode('executeStepWorker', async (state) => {
                const step = state.steps[state.stepIndex];
                if (!step) return {};

                const systemPrompt = 'Ты воркер-исполнитель. Выполни конкретный шаг плана оркестратора.';
                const userPrompt = `ШАГ: ${step.task}\nКОНТЕКСТ ПРЕДЫДУЩИХ ШАГОВ:\n${state.feedbackHistory.join('\n\n')}`;

                const resp = await modelAdapter.call({
                    taskDir: state.taskDir,
                    node: state.node,
                    role: 'worker',
                    systemPrompt,
                    userPrompt,
                    dryRun: state.context?.dryRun || false
                });

                const stepOutput = resp.text || `[Orchestrated step ${step.id} executed]`;
                return {
                    feedbackHistory: [stepOutput],
                    stepIndex: state.stepIndex + 1
                };
            })
            .addNode('compileResult', async (state) => {
                const summary = state.feedbackHistory.join('\n\n---\n\n');

                if (state.taskDir) {
                    try {
                        await fs.writeFile(path.join(state.taskDir, 'op_plan.json'), JSON.stringify({
                            strategy: 'orchestrator',
                            steps: state.steps,
                            outputs: state.feedbackHistory,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'orchestrator',
                        summary,
                        files_written: ['op_plan.json']
                    }
                };
            })
            .addEdge(START, 'planSteps')
            .addEdge('planSteps', 'executeStepWorker')
            .addConditionalEdges('executeStepWorker', (state) => {
                return state.stepIndex < state.steps.length ? 'executeStepWorker' : 'compileResult';
            })
            .addEdge('compileResult', END);

        return graph.compile();
    }
};
