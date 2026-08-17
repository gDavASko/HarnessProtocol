import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END } from '@langchain/langgraph';
import { StrategyStateAnnotation } from '../stateAnnotations.js';

export const mapReducePlugin = {
    id: 'map_reduce',
    aliases: ['mapreduce', 'batch_chunking'],
    name: 'Map-Reduce Aggregator',
    description: 'Partitions large data chunks, maps them in parallel or batch scripts, and performs hierarchical reduction.',
    weapons: ['read_file', 'write_clean', 'chunk_splitter', 'execute_code'],

    createSubgraph({ modelAdapter }) {
        const graph = new StateGraph(StrategyStateAnnotation)
            .addNode('splitChunks', async (state) => {
                const dod = state.node?.dod || [];
                const chunks = dod.map((d, i) => ({
                    id: `chunk_${i + 1}`,
                    text: typeof d === 'string' ? d : d.criterion
                }));
                return { shards: chunks.length > 0 ? chunks : [{ id: 'chunk_1', text: state.node?.title || 'Data Chunk' }] };
            })
            .addNode('mapWorkers', async (state) => {
                // Programmatic mapping or worker invocation
                const mapPromises = state.shards.map(async (chunk) => {
                    const systemPrompt = 'Ты Map-воркер. Выполни извлечение и структурирование данных для данного чанка.';
                    const userPrompt = `ЧАНК: ${chunk.text}\nОГРАНИЧЕНИЯ: ${state.context?.constraints_digest || 'нет'}`;

                    const resp = await modelAdapter.call({
                        taskDir: state.taskDir,
                        node: state.node,
                        role: 'worker',
                        systemPrompt,
                        userPrompt,
                        dryRun: state.context?.dryRun || false
                    });

                    return {
                        chunk_id: chunk.id,
                        mapped_data: resp.text || `[Mapped result for ${chunk.id}]`
                    };
                });

                const mappedResults = await Promise.all(mapPromises);
                return { shardResults: mappedResults };
            })
            .addNode('reduceAggregator', async (state) => {
                const results = state.shardResults || [];
                const systemPrompt = 'Ты Reduce-агрегатор. Выполни финальное объединение, дедупликацию и синтез агрегированного результата.';
                const userPrompt = `ЗАДАЧА: ${state.node?.title}\n\nРЕЗУЛЬТАТЫ MAP-ФАЗЫ:\n${results.map(r => `[${r.chunk_id}]: ${r.mapped_data}`).join('\n\n')}`;

                const resp = await modelAdapter.call({
                    taskDir: state.taskDir,
                    node: state.node,
                    role: 'reasoner',
                    systemPrompt,
                    userPrompt,
                    dryRun: state.context?.dryRun || false
                });

                const finalSummary = resp.text || results.map(r => r.mapped_data).join('\n\n');

                if (state.taskDir) {
                    try {
                        await fs.writeFile(path.join(state.taskDir, 'op_reduce_final.json'), JSON.stringify({
                            strategy: 'map_reduce',
                            mapped_chunks: results,
                            reduced_summary: finalSummary,
                            updated_at: new Date().toISOString()
                        }, null, 2), 'utf-8');
                    } catch (e) {}
                }

                return {
                    result: {
                        success: true,
                        strategy: 'map_reduce',
                        summary: finalSummary,
                        files_written: ['op_reduce_final.json']
                    }
                };
            })
            .addEdge(START, 'splitChunks')
            .addEdge('splitChunks', 'mapWorkers')
            .addEdge('mapWorkers', 'reduceAggregator')
            .addEdge('reduceAggregator', END);

        return graph.compile();
    }
};
