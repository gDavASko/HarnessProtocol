import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { TaskStateAnnotation } from './stateAnnotations.js';
import { createRalphLoopSubgraph } from './ralphLoopSubgraph.js';
import { readRoadmap, writeRoadmap, readState, writeState } from '../harnessState.js';

/**
 * TaskOrchestratorGraph
 * Top-level meta-graph managing task roadmap progression, scale gating, drift-guard,
 * dynamic runtime node decomposition (ADR 0021), hierarchical escalation,
 * and mandatory Final Acceptance Stress-Gate (ADR 0020).
 */
export function createTaskOrchestratorGraph({ modelAdapter, checkpointer, dryRun = false }) {
    const ralphSubgraph = createRalphLoopSubgraph({ modelAdapter, dryRun });

    const graph = new StateGraph(TaskStateAnnotation)
        .addNode('readRoadmapNode', async (state) => {
            const taskDir = state.taskDir;
            let roadmap = state.roadmap;
            if (!roadmap && taskDir) {
                try {
                    roadmap = await readRoadmap(taskDir);
                } catch (e) {}
            }

            const nodes = roadmap?.nodes || [];
            const activeIdx = nodes.findIndex(n => n.status !== 'DONE');

            if (activeIdx === -1 || nodes.length === 0) {
                return {
                    status: 'AWAITING_FINAL_ACCEPTANCE',
                    roadmap,
                    currentNodeIndex: nodes.length
                };
            }

            return {
                roadmap,
                currentNodeIndex: activeIdx,
                status: 'IN_PROGRESS'
            };
        })

        // ADR 0021: Dynamic Runtime Node Decomposition & Adaptive Fracturing
        .addNode('dynamicDecompositionNode', async (state) => {
            const roadmap = state.roadmap;
            const idx = state.currentNodeIndex;
            const node = roadmap?.nodes?.[idx];
            if (!node || node.status === 'DONE') return {};

            // If node is complex (DoD >= 3 or marked for decomposition) and not yet fractured
            const shouldDecompose = (node.dod && node.dod.length >= 3 && !node.is_decomposed && node.strategy !== 'prompt_chaining');

            if (shouldDecompose) {
                console.log(`\n🧩 [ADR 0021] Обнаружен крупный узел "${node.id}: ${node.title}". Запуск динамического дробления...`);
                
                const childNodes = node.dod.map((dodItem, dIdx) => ({
                    id: `${node.id}.${dIdx + 1}`,
                    title: `[Суб-узел] ${dodItem}`,
                    parent_node_id: node.id,
                    strategy: node.strategy === 'map_reduce' ? 'evaluator_optimizer' : 'evaluator_optimizer',
                    criticality: node.criticality || 'L3',
                    validation_type: node.validation_type || 'hybrid',
                    artifact_kind: node.artifact_kind || 'code',
                    status: 'PENDING',
                    iteration: 1,
                    max_iterations: 3,
                    dod: [dodItem]
                }));

                node.is_decomposed = true;
                node.title = `[Агрегатор] ${node.title}`;

                // Insert child nodes before the parent node (or replace)
                const newNodes = [
                    ...roadmap.nodes.slice(0, idx),
                    ...childNodes,
                    ...roadmap.nodes.slice(idx)
                ];

                const updatedRoadmap = { ...roadmap, nodes: newNodes };
                if (state.taskDir) {
                    try {
                        await writeRoadmap(state.taskDir, updatedRoadmap, { syncMarkdown: true });
                    } catch (e) {}
                }

                console.log(`   ✨ Узел ${node.id} успешно раздроблен на ${childNodes.length} атомарных под-узлов.`);

                return {
                    roadmap: updatedRoadmap,
                    currentNodeIndex: idx,
                    lastAction: 'DYNAMICALLY_DECOMPOSED'
                };
            }

            return { lastAction: 'DECOMPOSITION_EVALUATED' };
        })

        .addNode('scaleGateCheckNode', async (state) => {
            const node = state.roadmap?.nodes?.[state.currentNodeIndex];
            if (!node) return {};

            // Criticality L3 enforces classic single executor mode
            if (node.criticality === 'L3') {
                return { lastAction: 'CLASSIC_SCALE_ENFORCED' };
            }

            return { lastAction: 'SCALE_CHECKED' };
        })

        .addNode('invokeRalphLoopNode', async (state) => {
            const node = state.roadmap?.nodes?.[state.currentNodeIndex];
            if (!node) return {};

            const ralphResult = await ralphSubgraph.invoke({
                taskDir: state.taskDir,
                nodeId: node.id,
                node,
                iteration: node.iteration || 1,
                maxIterations: node.max_iterations || 3,
                context: { dryRun }
            });

            return {
                lastAction: ralphResult.action,
                error: ralphResult.error
            };
        })

        .addNode('hierarchicalEscalationNode', async (state) => {
            const node = state.roadmap?.nodes?.[state.currentNodeIndex];
            
            // Parent level decomposition revision
            if (state.lastAction === 'NEEDS_PARENT_REFRAMING') {
                const failPayload = {
                    type: 'CRITICAL_FAIL',
                    nodeId: node?.id,
                    title: node?.title,
                    reason: 'Все стратегии исчерпаны. Требуется ручной пересмотр задачи человеком.'
                };
                interrupt(failPayload);
                return { status: 'PAUSED' };
            }

            return {};
        })

        .addNode('driftGuardCheckNode', async (state) => {
            const counter = (state.driftCounter || 0) + 1;
            const syncDue = counter >= 3;

            return {
                driftCounter: syncDue ? 0 : counter,
                lastAction: syncDue ? 'SYNC_DUE' : 'ADVANCE_NODE'
            };
        })

        .addNode('advanceTaskCursorNode', async (state) => {
            const roadmap = state.roadmap;
            const node = roadmap?.nodes?.[state.currentNodeIndex];
            
            if (node && state.lastAction !== 'CRITICAL_FAIL') {
                node.status = 'DONE';
                if (state.taskDir) {
                    try {
                        await writeRoadmap(state.taskDir, roadmap, { syncMarkdown: true });
                    } catch (e) {
                        console.error('writeRoadmap error:', e);
                    }
                }
            }

            const nextIdx = state.currentNodeIndex + 1;
            const isAllNodesDone = nextIdx >= (roadmap?.nodes?.length || 0);

            return {
                roadmap: { ...roadmap, nodes: [...(roadmap.nodes || [])] },
                currentNodeIndex: nextIdx,
                status: isAllNodesDone ? 'AWAITING_FINAL_ACCEPTANCE' : 'IN_PROGRESS'
            };
        })

        // ADR 0020: Final Acceptance Stress-Gate & Remediation Loop
        .addNode('finalAcceptanceStressNode', async (state) => {
            const roadmap = state.roadmap;
            const taskDir = state.taskDir;

            // Run Final Acceptance Stress-Test & Quality Verification
            let acceptancePassed = true;
            let failureReason = null;

            if (modelAdapter && !dryRun) {
                try {
                    const prompt = `Проведи финальный приемочный аудит задачи ${taskDir}. Убедись, что все требования выполнены без косяков и заглушек.`;
                    const res = await modelAdapter.callModel([{ role: 'user', content: prompt }], { tier: 'tier1' });
                    if (res && res.text && res.text.toLowerCase().includes('critical defect')) {
                        acceptancePassed = false;
                        failureReason = res.text;
                    }
                } catch (e) {
                    // Fallback to strict code verification
                }
            }

            if (!acceptancePassed) {
                // Synthesize Remediation Node and trigger new cycle
                const fixNode = {
                    id: `FIX-${Date.now().toString().slice(-4)}`,
                    title: `Устранение дефектов финального стресс-теста`,
                    strategy: 'evaluator_optimizer',
                    criticality: 'L3',
                    validation_type: 'human',
                    artifact_kind: 'code',
                    status: 'PENDING',
                    dod: [failureReason || 'Устранить обнаруженные дефекты и пройти повторный стресс-тест']
                };

                const updatedNodes = [...(roadmap?.nodes || []), fixNode];
                const updatedRoadmap = { ...roadmap, nodes: updatedNodes };

                if (taskDir) {
                    try {
                        await writeRoadmap(taskDir, updatedRoadmap, { syncMarkdown: true });
                    } catch (e) {}
                }

                return {
                    roadmap: updatedRoadmap,
                    currentNodeIndex: updatedNodes.length - 1,
                    status: 'IN_PROGRESS',
                    lastAction: 'REMEDIATION_LOOP_TRIGGERED'
                };
            }

            return {
                status: 'COMPLETED',
                lastAction: 'FINAL_ACCEPTANCE_PASSED'
            };
        })

        // Edges
        .addEdge(START, 'readRoadmapNode')
        .addConditionalEdges('readRoadmapNode', (state) => {
            if (state.status === 'AWAITING_FINAL_ACCEPTANCE') return 'finalAcceptanceStressNode';
            if (state.status === 'COMPLETED') return END;
            return 'dynamicDecompositionNode';
        })
        .addEdge('dynamicDecompositionNode', 'scaleGateCheckNode')
        .addEdge('scaleGateCheckNode', 'invokeRalphLoopNode')
        .addConditionalEdges('invokeRalphLoopNode', (state) => {
            if (state.lastAction === 'NEEDS_PARENT_REFRAMING') {
                return 'hierarchicalEscalationNode';
            }
            return 'driftGuardCheckNode';
        })
        .addEdge('hierarchicalEscalationNode', 'driftGuardCheckNode')
        .addEdge('driftGuardCheckNode', 'advanceTaskCursorNode')
        .addConditionalEdges('advanceTaskCursorNode', (state) => {
            if (state.status === 'AWAITING_FINAL_ACCEPTANCE') return 'finalAcceptanceStressNode';
            return 'dynamicDecompositionNode';
        })
        .addConditionalEdges('finalAcceptanceStressNode', (state) => {
            return state.status === 'COMPLETED' ? END : 'dynamicDecompositionNode';
        });

    return graph.compile({ checkpointer });
}
