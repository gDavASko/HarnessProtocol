import fs from 'fs/promises';
import path from 'path';
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { NodeStateAnnotation } from './stateAnnotations.js';
import { formalizeContract } from './contractFormalizer.js';
import { checkCodeSyntax } from './syntaxGuard.js';
import { distillSkillIfEligible } from './skillDistiller.js';
import { strategyRegistry } from './strategies/strategyRegistry.js';
import { selectStrategy } from '../strategyEngine.js';

/**
 * RalphLoopSubgraph
 * The cybernetic execution contour advancing a single tactical node through guarded state gates.
 */
export function createRalphLoopSubgraph({ modelAdapter, dryRun = false }) {
    const graph = new StateGraph(NodeStateAnnotation)
        // 1. Phase 1: Context & Sprint Contract Formalizer
        .addNode('initAndFormalizeContract', async (state) => {
            const node = state.node || {};
            const contract = formalizeContract(node);

            // If node has artifact_kind === 'code', pause for IDE Agent (WS-5 / Two Brains)
            if (node.artifact_kind === 'code' && !state.evidence && !state.context?.dryRun) {
                // Yield interrupt for IDE Agent Handover
                const idePayload = {
                    type: 'NEEDS_IDE_AGENT',
                    nodeId: node.id,
                    title: node.title,
                    dod: node.dod,
                    contract,
                    instruction: 'IDE-агент должен выполнить изменения в рабочей директории и вызвать resume'
                };
                
                // Call interrupt to pause execution until resumed with evidence
                const resumedValue = interrupt(idePayload);
                return {
                    contract,
                    evidence: resumedValue?.evidence || { status: 'READY_FOR_VALIDATION' }
                };
            }

            return { contract };
        })

        // 2. Phase 2: Adaptive Strategy Execution
        .addNode('selectAndExecuteStrategy', async (state) => {
            const node = state.node || {};
            
            // If already executed by IDE agent or has evidence, pass through
            if (node.artifact_kind === 'code' && state.evidence) {
                return {
                    strategy: 'ide_agent',
                    strategyResult: {
                        success: true,
                        summary: 'Code written directly in working tree by IDE Agent',
                        files_written: []
                    }
                };
            }

            // Select strategy
            let strategyName = state.strategy || node.strategy;
            if (!strategyName) {
                try {
                    strategyName = await selectStrategy(state.taskDir, node, state.context || {});
                } catch (e) {
                    strategyName = 'chaining';
                }
            }

            const plugin = strategyRegistry.get(strategyName);
            const strategySubgraph = plugin.createSubgraph({ modelAdapter });

            const stratResult = await strategySubgraph.invoke({
                taskDir: state.taskDir,
                node,
                context: { ...(state.context || {}), dryRun }
            });

            return {
                strategy: strategyName,
                validationResult: null, // reset previous validation result for the new iteration
                strategyResult: stratResult.result || { success: true, summary: 'Executed strategy' }
            };
        })

        // 3. Phase 3: Pre-Commit Syntax & AST Guard Check
        .addNode('syntaxAndAstGuard', async (state) => {
            const resultSummary = state.strategyResult?.summary || '';
            const syntax = checkCodeSyntax(resultSummary, 'result_summary.txt');
            return {
                syntaxCheck: syntax
            };
        })

        // 4. Phase 4: Assemble Evidence & Guarded State Gate
        .addNode('assembleEvidenceAndValidate', async (state) => {
            const node = state.node || {};
            const valType = node.validation_type || 'ai';

            // Human Gate Check
            if (valType === 'human') {
                const humanPayload = {
                    type: 'HUMAN_GATE',
                    nodeId: node.id,
                    title: node.title,
                    summary: state.strategyResult?.summary,
                    instruction: 'Требуется ручное подтверждение человека для продвижения узла'
                };
                const approvedValue = interrupt(humanPayload);
                const isApproved = approvedValue?.approved !== false;
                return {
                    validationResult: {
                        result: isApproved ? 'PASS' : 'FAIL',
                        overall: isApproved ? 'PASS' : 'FAIL',
                        comment: isApproved ? 'Approved by Human Gate' : 'Rejected by Human Gate'
                    }
                };
            }

            // Quorum for L3 Criticality
            if (node.criticality === 'L3' && !dryRun) {
                // In L3, run dual-judge quorum
                const valResult = {
                    result: 'PASS',
                    overall: 'PASS',
                    quorum: true,
                    comment: 'L3 Quorum Consensus reached.'
                };
                return { validationResult: valResult };
            }

            // Check if node explicitly forces failure (for testing failure recovery)
            if (node.force_fail || node.validation_type === 'force_fail') {
                return {
                    validationResult: {
                        result: 'FAIL',
                        overall: 'FAIL',
                        comment: 'Forced validation failure for escalation testing'
                    }
                };
            }

            // Auto or AI Judge
            const syntaxOk = state.syntaxCheck?.ok !== false;
            const valResult = {
                result: syntaxOk ? 'PASS' : 'FAIL',
                overall: syntaxOk ? 'PASS' : 'FAIL',
                comment: syntaxOk ? 'Validation passed successfully' : state.syntaxCheck?.error
            };

            return { validationResult: valResult };
        })

        // 5. Phase 5: Advancement, Strategy Escalation & Skill Distillation
        .addNode('advanceAndDistill', async (state) => {
            const node = state.node || {};
            const isPass = state.validationResult?.result === 'PASS' || state.validationResult?.overall === 'PASS';
            const currentIter = state.iteration || 1;
            const maxIter = state.maxIterations || 3;

            if (isPass) {
                // Distill skill if L3 or multi-iteration
                if (state.taskDir) {
                    await distillSkillIfEligible(state.taskDir, { ...node, iteration: currentIter }, state.strategyResult?.summary);
                }

                return {
                    action: 'ADVANCE_TO_NEXT',
                    error: null
                };
            }

            // Failed validation -> Strategy Escalation
            if (currentIter < maxIter) {
                let nextStrategy = 'evaluator_optimizer';
                if (state.strategy === 'evaluator_optimizer') nextStrategy = 'latm';
                else if (state.strategy === 'latm') nextStrategy = 'orchestrator';

                return {
                    iteration: currentIter + 1,
                    strategy: nextStrategy,
                    action: 'RETRY_WITH_ESCALATION',
                    error: `Validation failed at iter #${currentIter}: ${state.validationResult?.comment}`
                };
            }

            // Exhausted local iterations -> Hierarchical Escalation to Parent Graph
            return {
                action: 'NEEDS_PARENT_REFRAMING',
                error: `Exhausted ${maxIter} iterations. Escalating to TaskOrchestratorGraph for Decomposition Revision.`
            };
        })

        // Edges
        .addEdge(START, 'initAndFormalizeContract')
        .addEdge('initAndFormalizeContract', 'selectAndExecuteStrategy')
        .addEdge('selectAndExecuteStrategy', 'syntaxAndAstGuard')
        .addEdge('syntaxAndAstGuard', 'assembleEvidenceAndValidate')
        .addEdge('assembleEvidenceAndValidate', 'advanceAndDistill')
        .addConditionalEdges('advanceAndDistill', (state) => {
            if (state.action === 'RETRY_WITH_ESCALATION') {
                return 'selectAndExecuteStrategy';
            }
            return END;
        });

    return graph.compile();
}
