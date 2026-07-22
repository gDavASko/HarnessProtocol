import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkflowProfile, validateWorkflowProfile } from './workflowRuntime.js';

const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-workflow-'));
try {
    const node = { id: 'N1', title: 'Аудит', workflow: { mode: 'workflow', profile: 'readonly-code-audit' }, dod: [{ criterion: 'A' }, { criterion: 'B' }, { criterion: 'C' }] };
    let active = 0;
    let peak = 0;
    const result = await runWorkflowProfile({ taskDir, node, bin: 'codex', dryRun: true, workerTurn: async args => {
        active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
        return { ok: true, estTokens: args.budgetTokens - 1, text: `ok-${args.runId}` };
    } });
    assert.equal(result.status, 'READY_FOR_VALIDATION');
    assert.ok(peak <= 3);
    assert.equal(result.phase, 'readonly_audit');
    assert.equal(result.estimated_tokens, 3 * 14999);
    assert.equal(result.run_dir, null, 'Dry-run must not create worker artifacts.');
    await assert.rejects(fs.access(path.join(taskDir, 'workflow_runs')));
    const defaultDryRun = await runWorkflowProfile({ taskDir, node: { ...node, dod: [{ criterion: 'A' }] }, bin: 'codex', dryRun: true });
    assert.equal(defaultDryRun.ok, true, 'Canonical transport must support a side-effect-free dry-run.');
    assert.equal((await runWorkflowProfile({ taskDir, node, bin: 'agy', dryRun: true })).status, 'READY_FOR_VALIDATION');
    assert.equal(validateWorkflowProfile({ name: 'bad', phases: ['one'], allowed_actions: [], writes_code: false, max_concurrent_workers: 1, max_workers_per_run: 1, token_budget: 1, worker_phase: 'one', phase_budgets: { extra: 1 } }, 'bad'), false);
    const overLimit = await runWorkflowProfile({ taskDir, node: { ...node, dod: Array.from({ length: 9 }, (_, index) => ({ criterion: String(index) })) }, bin: 'codex' });
    assert.equal(overLimit.status, 'WORKER_LIMIT_EXCEEDED');
    const writeProfile = await runWorkflowProfile({ taskDir, node: { ...node, workflow: { mode: 'workflow', profile: 'safe-migration' } }, bin: 'codex' });
    assert.equal(writeProfile.status, 'WRITE_PHASE_REQUIRES_SEQUENTIAL_IDE_AGENT');
    console.log('Workflow runtime tests passed.');
} finally {
    await fs.rm(taskDir, { recursive: true, force: true });
}
