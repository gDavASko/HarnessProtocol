import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveTaskDir } from './harnessPaths.js';

// ─── Durable checkpointer (C1) ───────────────────────────────────────────────
//
// Backend choice: append-only JSONL Write-Ahead Log (no native deps). Rationale:
// better-sqlite3 is not installed and npm install is unreliable inside the Unity
// submodule; node:sqlite exists on Node 22 but is flagged experimental. The WAL
// is dependency-free, crash-safe (append-only), and keeps the JSON roadmap/state
// as the human-readable export while the WAL is the transition source of truth.
//
// One record per state transition:
//   { run_id, node, status, state_json, updated_at }
// The authoritative state for a run is the LAST record with that run_id.
//
// CLI:
//   node stateStore.js <task_dir> --list
//   node stateStore.js <task_dir> --resume [run_id]

const WAL_FILE = '.harness_wal.jsonl';

export function walPath(taskDir) {
    return path.join(taskDir, WAL_FILE);
}

/**
 * Append one checkpoint record. Best-effort: never throws (so it cannot break the
 * state-machine hot path). Disabled by HARNESS_CHECKPOINT=0.
 */
export async function checkpoint(taskDir, { runId, node = null, status = null, state = null } = {}) {
    if (process.env.HARNESS_CHECKPOINT === '0') return false;
    try {
        const rec = {
            run_id: runId || path.basename(taskDir),
            node,
            status,
            state_json: state,
            updated_at: new Date().toISOString()
        };
        await fs.appendFile(walPath(taskDir), JSON.stringify(rec) + '\n', 'utf-8');
        return true;
    } catch {
        return false;
    }
}

/** Synchronous variant for callers already inside a sync path. */
export function checkpointSync(taskDir, { runId, node = null, status = null, state = null } = {}) {
    if (process.env.HARNESS_CHECKPOINT === '0') return false;
    try {
        const rec = { run_id: runId || path.basename(taskDir), node, status, state_json: state, updated_at: new Date().toISOString() };
        fssync.appendFileSync(walPath(taskDir), JSON.stringify(rec) + '\n', 'utf-8');
        return true;
    } catch {
        return false;
    }
}

async function readAll(taskDir) {
    try {
        const raw = await fs.readFile(walPath(taskDir), 'utf-8');
        return raw.split('\n').filter(Boolean).map(line => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
    } catch {
        return [];
    }
}

/** Latest checkpoint record for a run (or the newest run if runId omitted). */
export async function restore(taskDir, runId = null) {
    const recs = await readAll(taskDir);
    if (recs.length === 0) return null;
    const filtered = runId ? recs.filter(r => r.run_id === runId) : recs;
    return filtered.length ? filtered[filtered.length - 1] : null;
}

/** Latest record per run_id. */
export async function listRuns(taskDir) {
    const recs = await readAll(taskDir);
    const byRun = new Map();
    for (const r of recs) byRun.set(r.run_id, r);
    return [...byRun.values()];
}

async function main() {
    const args = process.argv.slice(2);
    const taskDir = resolveTaskDir(args[0]);
    if (!taskDir) {
        console.error(JSON.stringify({ error: 'Usage: node stateStore.js <task_dir> [--list | --resume [run_id]]' }));
        process.exit(1);
    }
    if (args.includes('--list')) {
        console.log(JSON.stringify({ runs: await listRuns(taskDir) }, null, 2));
        return;
    }
    if (args.includes('--resume')) {
        const idx = args.indexOf('--resume');
        const runId = args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
        const last = await restore(taskDir, runId);
        if (!last) {
            console.error(JSON.stringify({ error: 'Нет чекпоинтов в WAL для этой задачи/прогона.' }));
            process.exit(1);
        }
        console.log(JSON.stringify({ action: 'RESUME', checkpoint: last }, null, 2));
        return;
    }
    console.log(JSON.stringify({ wal: walPath(taskDir).replace(/\\/g, '/'), records: (await readAll(taskDir)).length }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch(err => {
        console.error(JSON.stringify({ error: err.message }));
        process.exit(1);
    });
}
