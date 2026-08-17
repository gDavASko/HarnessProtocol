import fs from 'fs/promises';
import path from 'path';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { writeState, writeRoadmap, readRoadmap, fileExists } from '../harnessState.js';

/**
 * HarnessDiskCheckpointer
 * Disk-backed checkpointer with typed event-stream logging and Time-Travel rollback.
 */
export class HarnessDiskCheckpointer extends BaseCheckpointSaver {
    constructor({ baseDir }) {
        super();
        this.baseDir = baseDir;
        this.storage = new Map(); // In-memory fast cache
    }

    getThreadDir(threadId) {
        const sanitized = (threadId || 'default').replace(/[^a-zA-Z0-9_\-.:]/g, '_');
        return path.resolve(this.baseDir, '.harness', 'checkpoints', sanitized);
    }

    async getTuple(config) {
        const threadId = config?.configurable?.thread_id || 'default';
        const checkpointId = config?.configurable?.checkpoint_id;
        const threadDir = this.getThreadDir(threadId);

        try {
            if (checkpointId) {
                const filePath = path.join(threadDir, `${checkpointId}.json`);
                if (await fileExists(filePath)) {
                    const raw = await fs.readFile(filePath, 'utf-8');
                    const saved = JSON.parse(raw);
                    return saved;
                }
            } else {
                // Get latest checkpoint
                const latestPath = path.join(threadDir, 'latest.json');
                if (await fileExists(latestPath)) {
                    const raw = await fs.readFile(latestPath, 'utf-8');
                    const saved = JSON.parse(raw);
                    return saved;
                }
            }
        } catch (e) {
            // fallback to cache if disk read fails
        }

        const threadMap = this.storage.get(threadId);
        if (!threadMap) return undefined;

        if (checkpointId) {
            return threadMap.get(checkpointId);
        }

        // Return latest
        let latest = undefined;
        for (const tuple of threadMap.values()) {
            if (!latest || (tuple.checkpoint?.ts && tuple.checkpoint.ts > latest.checkpoint.ts)) {
                latest = tuple;
            }
        }
        return latest;
    }

    async *list(config, options) {
        const threadId = config?.configurable?.thread_id || 'default';
        const threadDir = this.getThreadDir(threadId);

        try {
            if (await fileExists(threadDir)) {
                const files = await fs.readdir(threadDir);
                const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'latest.json');
                for (const file of jsonFiles.reverse()) {
                    const raw = await fs.readFile(path.join(threadDir, file), 'utf-8');
                    yield JSON.parse(raw);
                }
                return;
            }
        } catch (e) {
            // fallback to memory
        }

        const threadMap = this.storage.get(threadId);
        if (!threadMap) return;

        for (const tuple of Array.from(threadMap.values()).reverse()) {
            yield tuple;
        }
    }

    async put(config, checkpoint, metadata, newVersions) {
        const threadId = config?.configurable?.thread_id || 'default';
        const threadDir = this.getThreadDir(threadId);
        await fs.mkdir(threadDir, { recursive: true });

        const tuple = {
            config: {
                configurable: {
                    thread_id: threadId,
                    checkpoint_id: checkpoint.id,
                    checkpoint_ns: config?.configurable?.checkpoint_ns || ''
                }
            },
            checkpoint,
            metadata,
            parentConfig: config
        };

        if (!this.storage.has(threadId)) {
            this.storage.set(threadId, new Map());
        }
        this.storage.get(threadId).set(checkpoint.id, tuple);

        try {
            // 1. Write checkpoint JSON
            const cpPath = path.join(threadDir, `${checkpoint.id}.json`);
            await fs.writeFile(cpPath, JSON.stringify(tuple, null, 2), 'utf-8');
            await fs.writeFile(path.join(threadDir, 'latest.json'), JSON.stringify(tuple, null, 2), 'utf-8');

            // 2. Append to typed event stream
            const eventPath = path.join(threadDir, 'event_stream.jsonl');
            const eventEntry = {
                ts: new Date().toISOString(),
                checkpoint_id: checkpoint.id,
                step: metadata?.step ?? null,
                node: metadata?.langgraph_node ?? null,
                source: metadata?.source ?? 'graph',
                writes: metadata?.writes ?? null
            };
            await fs.appendFile(eventPath, JSON.stringify(eventEntry) + '\n', 'utf-8');

            // 3. Mirror to .harness_state.json if state changes
            if (checkpoint.channel_values?.status) {
                await this.mirrorHarnessState(threadId, checkpoint.channel_values);
            }
        } catch (err) {
            console.error(`[HarnessDiskCheckpointer] Error persisting checkpoint: ${err.message}`);
        }

        return tuple.config;
    }

    async putWrites(config, writes, taskId) {
        // Record intermediate writes
    }

    async mirrorHarnessState(threadId, channelValues) {
        try {
            const statePath = path.resolve(this.baseDir, '.harness_state.json');
            const currentState = await fileExists(statePath)
                ? JSON.parse(await fs.readFile(statePath, 'utf-8'))
                : {};

            const updated = {
                ...currentState,
                stage: channelValues.status === 'PAUSED' ? 'awaiting_human_validation' : (channelValues.status || 'in_progress'),
                active_node: channelValues.nodeId || channelValues.currentNodeIndex || currentState.active_node,
                last_checkpoint: channelValues.checkpoint_id,
                updated_at: new Date().toISOString()
            };

            await fs.writeFile(statePath, JSON.stringify(updated, null, 2), 'utf-8');
        } catch (e) {
            // ignore
        }
    }

    async rollbackToCheckpoint(threadId, checkpointId) {
        const threadDir = this.getThreadDir(threadId);
        const targetPath = path.join(threadDir, `${checkpointId}.json`);

        if (!(await fileExists(targetPath))) {
            throw new Error(`Checkpoint not found: ${checkpointId}`);
        }

        const raw = await fs.readFile(targetPath, 'utf-8');
        const targetTuple = JSON.parse(raw);

        // Copy target to latest.json
        await fs.writeFile(path.join(threadDir, 'latest.json'), raw, 'utf-8');

        // Log rollback event
        const eventPath = path.join(threadDir, 'event_stream.jsonl');
        const rollbackEvent = {
            ts: new Date().toISOString(),
            event_type: 'TIME_TRAVEL_ROLLBACK',
            target_checkpoint_id: checkpointId
        };
        await fs.appendFile(eventPath, JSON.stringify(rollbackEvent) + '\n', 'utf-8');

        return targetTuple;
    }
}
