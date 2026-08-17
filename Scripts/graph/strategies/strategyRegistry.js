import { chainingPlugin } from './chaining.js';
import { routingPlugin } from './routing.js';
import { parallelizationPlugin } from './parallelization.js';
import { orchestratorPlugin } from './orchestrator.js';
import { evaluatorOptimizerPlugin } from './evaluatorOptimizer.js';
import { mapReducePlugin } from './mapReduce.js';
import { latmPlugin } from './latm.js';

/**
 * StrategyRegistry
 * Central static registry for all 7 canonical Execution Strategy Subgraphs.
 */
class StrategyPluginRegistry {
    constructor() {
        this.plugins = new Map();
        this.register(chainingPlugin);
        this.register(routingPlugin);
        this.register(parallelizationPlugin);
        this.register(orchestratorPlugin);
        this.register(evaluatorOptimizerPlugin);
        this.register(mapReducePlugin);
        this.register(latmPlugin);
    }

    register(plugin) {
        if (!plugin || !plugin.id || typeof plugin.createSubgraph !== 'function') {
            throw new Error(`Invalid strategy plugin format: ${plugin?.id}`);
        }
        this.plugins.set(plugin.id, plugin);
        if (plugin.aliases) {
            for (const alias of plugin.aliases) {
                this.plugins.set(alias, plugin);
            }
        }
    }

    get(id) {
        const canonical = (id || '').toLowerCase().replace(/[- ]/g, '_');
        return this.plugins.get(canonical) || this.plugins.get('chaining');
    }

    has(id) {
        const canonical = (id || '').toLowerCase().replace(/[- ]/g, '_');
        return this.plugins.has(canonical);
    }

    list() {
        return Array.from(new Set(this.plugins.values())).map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            weapons: p.weapons
        }));
    }
}

export const strategyRegistry = new StrategyPluginRegistry();
