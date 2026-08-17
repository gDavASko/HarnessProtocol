import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';

export const routingPlugin = {
    id: 'routing',
    aliases: ['domain_routing', 'route'],
    name: 'Domain Routing',
    description: 'Classifies the problem domain and routes execution to a specialized domain worker.',
    weapons: ['read_file', 'write_clean', 'domain_profile_reader'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('classifyDomain', async (state) => {
                const title = state.node?.title || '';
                const dod = (state.node?.dod || []).map(d => typeof d === 'string' ? d : d.criterion).join('; ');
                
                const systemPrompt = 'Ты классификатор домена задачи. Определи домен: ui, audio, logic, data, vfx.\nВерни JSON: { "route_selected": "ui"|"audio"|"logic"|"data"|"vfx", "reasoning": "..." }';
                const userPrompt = `ЗАДАЧА: ${title}\nКРИТЕРИИ: ${dod}`;

                let route = 'logic';
                if (!state.context?.dryRun) {
                    try {
                        const resp = await modelAdapter.call({
                            taskDir: state.taskDir,
                            node: state.node,
                            role: 'reasoner',
                            systemPrompt,
                            userPrompt
                        });
                        const match = resp.text.match(/\{[\s\S]*\}/);
                        if (match) {
                            const parsed = JSON.parse(match[0]);
                            route = parsed.route_selected || 'logic';
                        }
                    } catch (e) {
                        route = 'logic';
                    }
                } else {
                    route = 'logic';
                }

                return { route };
            })
            .addNode('executeDomainWorker', async (state) => {
                const route = state.route || 'logic';
                const systemPrompt = `Ты специализированный исполнитель домена "${route}".\nВыполни задачу строго в рамках своего профиля. Верни результат.`;
                const userPrompt = `ЗАДАЧА: ${state.node?.title}\nДОМЕН: ${route}\nКРИТЕРИИ: ${(state.node?.dod || []).map(d => typeof d === 'string' ? d : d.criterion).join('; ')}`;

                const resp = await modelAdapter.call({
                    taskDir: state.taskDir,
                    node: state.node,
                    role: 'worker',
                    systemPrompt,
                    userPrompt,
                    dryRun: state.context?.dryRun || false
                });

                const output = resp.text || `[Domain Worker Output for domain: ${route}]`;

                if (state.taskDir) {
                    try {
                        const opRoutePath = path.join(state.taskDir, 'op_route.json');
                        await fs.writeFile(opRoutePath, JSON.stringify({
                            strategy: 'routing',
                            route_selected: route,
                            output,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'routing',
                        route_selected: route,
                        summary: output,
                        files_written: ['op_route.json']
                    }
                };
            })
            .addEdge(START, 'classifyDomain')
            .addEdge('classifyDomain', 'executeDomainWorker')
            .addEdge('executeDomainWorker', END);

        return graph.compile();
    }
};
