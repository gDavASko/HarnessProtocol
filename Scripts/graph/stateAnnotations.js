import { Annotation } from '@langchain/langgraph';

/**
 * TaskStateAnnotation: Top-level channel schema for TaskOrchestratorGraph
 */
export const TaskStateAnnotation = Annotation.Root({
    taskDir: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ''
    }),
    taskId: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ''
    }),
    roadmap: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    currentNodeIndex: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => 0
    }),
    status: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => 'IN_PROGRESS'
    }),
    driftCounter: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : (curr || 0)),
        default: () => 0
    }),
    tokenBudget: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => 120000
    }),
    events: Annotation({
        reducer: (curr, next) => (Array.isArray(next) ? curr.concat(next) : (next ? curr.concat([next]) : curr)),
        default: () => []
    }),
    error: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    }),
    lastAction: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    })
});

/**
 * NodeStateAnnotation: Scoped channel schema for RalphLoopSubgraph
 */
export const NodeStateAnnotation = Annotation.Root({
    taskDir: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ''
    }),
    nodeId: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ''
    }),
    node: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    iteration: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : (curr || 1)),
        default: () => 1
    }),
    maxIterations: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : (curr || 3)),
        default: () => 3
    }),
    contract: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    context: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ({})
    }),
    strategy: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ''
    }),
    strategyResult: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    }),
    syntaxCheck: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    }),
    evidence: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    }),
    validationResult: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    }),
    action: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    }),
    events: Annotation({
        reducer: (curr, next) => (Array.isArray(next) ? curr.concat(next) : (next ? curr.concat([next]) : curr)),
        default: () => []
    }),
    error: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : curr),
        default: () => null
    })
});

/**
 * StrategyStateAnnotation: Channel schema for individual strategy subgraphs
 */
export const StrategyStateAnnotation = Annotation.Root({
    taskDir: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ''
    }),
    node: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    context: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => ({})
    }),
    steps: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => []
    }),
    stepIndex: Annotation({
        reducer: (curr, next) => (next !== undefined ? next : (curr || 0)),
        default: () => 0
    }),
    shards: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => []
    }),
    shardResults: Annotation({
        reducer: (curr, next) => (Array.isArray(next) ? curr.concat(next) : (next ? curr.concat([next]) : curr)),
        default: () => []
    }),
    route: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    toolScript: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    feedbackHistory: Annotation({
        reducer: (curr, next) => (Array.isArray(next) ? curr.concat(next) : (next ? curr.concat([next]) : curr)),
        default: () => []
    }),
    result: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    }),
    error: Annotation({
        reducer: (curr, next) => next ?? curr,
        default: () => null
    })
});
