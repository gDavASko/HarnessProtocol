import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';

export const parallelizationPlugin = {
    id: 'parallelization',
    aliases: ['parallel', 'sharding'],
    name: 'Parallelization & Collator',
    description: 'Partitions DoD into shards, processes with parallel workers, and aggregates results via a Collator node.',
    weapons: ['read_file', 'write_clean', 'shard_reader'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('partitionShards', async (state) => {
                const dod = state.node?.dod || [];
                const shards = dod.map((item, index) => ({
                    index: index + 1,
                    criterion: typeof item === 'string' ? item : item.criterion
                }));
                return { shards: shards.length > 0 ? shards : [{ index: 1, criterion: state.node?.title || 'General' }] };
            })
            .addNode('executeParallelWorkers', async (state) => {
                const workers = state.shards.map(async (shard) => {
                    const systemPrompt = `Ты воркер. Выполни ОДНУ изолированную часть (#${shard.index}) задачи.\nВерни только результат.`;
                    const userPrompt = `ОБЩАЯ ЗАДАЧА: ${state.node?.title}\nТВОЙ ФРАГМЕНТ: ${shard.criterion}`;

                    const resp = await modelAdapter.call({
                        taskDir: state.taskDir,
                        node: state.node,
                        role: 'worker',
                        systemPrompt,
                        userPrompt,
                        dryRun: state.context?.dryRun || false
                    });

                    return {
                        shard: shard.index,
                        criterion: shard.criterion,
                        text: resp.text || `[Worker shard ${shard.index} output]`
                    };
                });

                const shardResults = await Promise.all(workers);
                return { shardResults };
            })
            .addNode('collatorNode', async (state) => {
                const results = state.shardResults || [];
                const systemPrompt = 'Ты агрегатор результатов (Collator). Объедини результаты нескольких воркеров в единое целостное решение.';
                const userPrompt = `ЗАДАЧА: ${state.node?.title}\n\nРЕЗУЛЬТАТЫ ВОРКЕРОВ:\n${results.map(r => `--- Шард #${r.shard} (${r.criterion}) ---\n${r.text}`).join('\n\n')}`;

                const resp = await modelAdapter.call({
                    taskDir: state.taskDir,
                    node: state.node,
                    role: 'reasoner',
                    systemPrompt,
                    userPrompt,
                    dryRun: state.context?.dryRun || false
                });

                const collatedText = resp.text || results.map(r => r.text).join('\n\n');

                if (state.taskDir) {
                    try {
                        await fs.writeFile(path.join(state.taskDir, 'op_collated.json'), JSON.stringify({
                            strategy: 'parallelization',
                            shards: results,
                            collated: collatedText,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'parallelization',
                        summary: collatedText,
                        files_written: ['op_collated.json']
                    }
                };
            })
            .addEdge(START, 'partitionShards')
            .addEdge('partitionShards', 'executeParallelWorkers')
            .addEdge('executeParallelWorkers', 'collatorNode')
            .addEdge('collatorNode', END);

        return graph.compile();
    }
};
