import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeNode } from './harnessState.js';
import { DEFAULT_WORKFLOW_LIMITS, selectScale } from './scaleGate.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.resolve(scriptDir, '../Workflows/profiles');
const execFileAsync = promisify(execFile);

async function run() {
    const goalNode = normalizeNode({
        id: 'УЗЕЛ-01',
        title: 'Исправить компиляцию',
        max_iterations: 5,
        goal: {
            outcome: 'Сборка проходит',
            proof: 'dotnet build exits 0',
            constraints: ['Не менять .meta'],
            max_no_progress: 2
        }
    });
    assert.deepEqual(goalNode.goal, {
        outcome: 'Сборка проходит',
        proof: 'dotnet build exits 0',
        constraints: ['Не менять .meta'],
        max_no_progress: 2,
        on_limit: 'CRITICAL_FAIL'
    });

    const legacyNode = normalizeNode({ id: 'УЗЕЛ-02', title: 'Старый узел' });
    assert.equal(legacyNode.goal, null, 'Legacy roadmap must remain compatible.');

    assert.equal(selectScale(goalNode, { hasOracle: true }).mode, 'goal_loop');
    const workflow = selectScale({ title: 'Аудит модулей' }, { independentParts: 3 });
    assert.equal(workflow.mode, 'workflow');
    assert.equal(workflow.profile, 'readonly-code-audit');
    assert.equal(workflow.limits.max_concurrent_workers, 3);
    assert.equal(workflow.limits.token_budget, 60000);
    const unknownProfile = selectScale({}, { mode: 'workflow', profile: 'unknown' });
    assert.equal(unknownProfile.mode, 'classic');
    assert.equal(unknownProfile.refused, true);
    assert.equal(selectScale({ artifact_kind: 'code', criticality: 'L3' }, { independentParts: 3 }).mode, 'classic');
    assert.equal(selectScale({ artifact_kind: 'code', criticality: 'L3' }, { mode: 'workflow', profile: 'safe-migration' }).refused, true);
    assert.equal(selectScale({ artifact_kind: 'text' }, { profile: 'safe-migration' }).refused, true);

    const expectedProfiles = [
        'unity-compile-fix',
        'readonly-code-audit',
        'safe-migration',
        'research-map-reduce'
    ];
    for (const name of expectedProfiles) {
        const profile = JSON.parse(await fs.readFile(path.join(profilesDir, `${name}.json`), 'utf8'));
        assert.equal(profile.name, name);
        assert.ok(Array.isArray(profile.phases) && profile.phases.length > 0);
        assert.ok(profile.max_concurrent_workers <= DEFAULT_WORKFLOW_LIMITS.max_concurrent_workers);
        assert.ok(profile.max_workers_per_run <= DEFAULT_WORKFLOW_LIMITS.max_workers_per_run);
        assert.ok(profile.token_budget <= DEFAULT_WORKFLOW_LIMITS.token_budget);
        assert.ok(Array.isArray(profile.allowed_actions) && profile.allowed_actions.length > 0);
    }

    await verifyRoadmapEditCli();

    console.log('Goal and workflow profile tests passed.');
}

async function verifyRoadmapEditCli() {
    const taskId = 'TACT-GOAL-WORKFLOW-TEST';
    const tacticalDir = path.resolve(scriptDir, '../../../../..', 'memory/tactical', taskId);
    try {
        await fs.rm(tacticalDir, { recursive: true, force: true });
        await execFileAsync('node', [path.join(scriptDir, 'task_initializer.js'), taskId, 'Goal workflow test']);
        await execFileAsync('node', [
            path.join(scriptDir, 'roadmapEdit.js'), tacticalDir, 'set-goal', '--node', 'УЗЕЛ-01',
            '--outcome', 'Сборка проходит', '--proof', 'dotnet build exits 0', '--max-no-progress', '2'
        ]);
        await execFileAsync('node', [
            path.join(scriptDir, 'roadmapEdit.js'), tacticalDir, 'set-scale', '--node', 'УЗЕЛ-01', '--oracle'
        ]);
        let roadmap = JSON.parse(await fs.readFile(path.join(tacticalDir, '.harness_roadmap.json'), 'utf8'));
        assert.equal(roadmap.nodes[0].goal.proof, 'dotnet build exits 0');
        assert.equal(roadmap.nodes[0].workflow.mode, 'goal_loop');
        assert.equal(roadmap.nodes[0].workflow.limits.token_budget, 120000);

        await execFileAsync('node', [
            path.join(scriptDir, 'roadmapEdit.js'), tacticalDir, 'set-scale', '--node', 'УЗЕЛ-01', '--profile', 'readonly-code-audit'
        ]);
        roadmap = JSON.parse(await fs.readFile(path.join(tacticalDir, '.harness_roadmap.json'), 'utf8'));
        assert.equal(roadmap.nodes[0].workflow.profile, 'readonly-code-audit');
        assert.equal(roadmap.nodes[0].workflow.limits.token_budget, 60000);

        await execFileAsync('node', [
            path.join(scriptDir, 'roadmapEdit.js'), tacticalDir, 'set-field', '--node', 'УЗЕЛ-01', '--criticality', 'L3'
        ]);
        await execFileAsync('node', [
            path.join(scriptDir, 'roadmapEdit.js'), tacticalDir, 'set-scale', '--node', 'УЗЕЛ-01', '--scale-mode', 'workflow'
        ]);
        roadmap = JSON.parse(await fs.readFile(path.join(tacticalDir, '.harness_roadmap.json'), 'utf8'));
        assert.equal(roadmap.nodes[0].workflow.mode, 'classic');
        assert.equal(roadmap.nodes[0].workflow.refused, true);

        await execFileAsync('node', [
            path.join(scriptDir, 'roadmapEdit.js'), tacticalDir, 'set-scale', '--node', 'УЗЕЛ-01', '--profile', 'unknown'
        ]);
        roadmap = JSON.parse(await fs.readFile(path.join(tacticalDir, '.harness_roadmap.json'), 'utf8'));
        assert.equal(roadmap.nodes[0].workflow.profile, null);
        assert.equal(roadmap.nodes[0].workflow.refused, true);
    } finally {
        await fs.rm(tacticalDir, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
