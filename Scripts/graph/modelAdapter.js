import fs from 'fs/promises';
import path from 'path';
import { callLLMWithFallback } from '../llmClient.js';
import { fileExists } from '../harnessState.js';

/**
 * Harness Model Adapter
 * Resolves model configuration across 3-tier hierarchy: Global -> Task -> Node
 */
export class HarnessModelAdapter {
    constructor({ baseDir }) {
        this.baseDir = baseDir;
    }

    async resolveModelConfig(taskDir, node, role = 'worker') {
        let globalConfig = {};
        try {
            const configPath = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../llm-config.json');
            if (await fileExists(configPath)) {
                globalConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
            }
        } catch (e) {}

        let taskConfig = {};
        try {
            const taskPath = path.resolve(taskDir, 'task.json');
            if (await fileExists(taskPath)) {
                taskConfig = JSON.parse(await fs.readFile(taskPath, 'utf-8'));
            }
        } catch (e) {}

        // Resolve preferred tier and model name
        const tier = node?.model_tier || taskConfig?.model_tier || globalConfig?.roles?.[role]?.tier || 'frontier';
        const preferredModel = node?.preferred_model || taskConfig?.preferred_model || globalConfig?.roles?.[role]?.model || null;
        const temperature = node?.temperature ?? globalConfig?.roles?.[role]?.temperature ?? 0.2;

        return {
            tier,
            preferredModel,
            temperature,
            role
        };
    }

    async call({ taskDir, node, role = 'worker', systemPrompt, userPrompt, dryRun = false }) {
        if (dryRun) {
            return {
                text: `[DRY_RUN] Simulated execution for node ${node?.id || 'TEST'}`,
                model: 'dry-run-model',
                tier: 'light',
                tokens: 50
            };
        }

        const config = await this.resolveModelConfig(taskDir, node, role);

        try {
            const rawText = await callLLMWithFallback(
                role,
                systemPrompt,
                userPrompt,
                { temperature: config.temperature }
            );

            return {
                text: typeof rawText === 'string' ? rawText : (rawText?.text || JSON.stringify(rawText)),
                role,
                tier: config.tier
            };
        } catch (err) {
            return {
                text: `[Model Fallback Error]: ${err.message}`,
                error: err.message,
                role,
                tier: config.tier
            };
        }
    }
}
