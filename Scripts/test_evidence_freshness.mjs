import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordRung, evaluateFloor, recordTaskIntegration, evaluateTaskIntegration } from './evidenceLadder.js';
import { captureSourceEvidence } from './sourceEvidence.js';

async function fixture(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-freshness-'));
    try {
        const src = path.join(dir, 'source');
        const taskDir = path.join(dir, 'task');
        await fs.mkdir(src); await fs.mkdir(taskDir);
        await fs.writeFile(path.join(src, 'core.js'), 'export const value = 1;');
        await fs.writeFile(path.join(taskDir, 'evidence-scope.json'), JSON.stringify({ schema_version: 1, source_roots: [src] }));
        const node = { id: 'N1', artifact_kind: 'code', iteration: 0, deliverables: [path.join(src, 'core.js')] };
        await fn({ src, taskDir, node, roadmap: { nodes: [node] } });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function certify(taskDir, node) {
    for (const rung of ['compile', 'tests', 'security']) await recordRung(taskDir, node, rung, 'PASS');
    assert.equal((await evaluateFloor(taskDir, node)).floorMet, true);
}

test('a file edit invalidates receipts without relying on an iteration bump', () => fixture(async ({src, taskDir, node}) => {
    await certify(taskDir, node);
    await fs.writeFile(path.join(src, 'core.js'), 'export const value = 2;');
    assert.equal((await evaluateFloor(taskDir, node)).floorMet, false);
}));

test('new or deleted source dependencies invalidate a passing integration', () => fixture(async ({src, taskDir, roadmap}) => {
    await recordTaskIntegration(taskDir, roadmap, 'PASS');
    assert.equal((await evaluateTaskIntegration(taskDir, roadmap)).ok, true);
    await fs.writeFile(path.join(src, 'dependency.js'), 'throw new Error();');
    assert.equal((await evaluateTaskIntegration(taskDir, roadmap)).ok, false);
    await recordTaskIntegration(taskDir, roadmap, 'PASS');
    await fs.unlink(path.join(src, 'core.js'));
    assert.equal((await evaluateTaskIntegration(taskDir, roadmap)).ok, false);
}));

test('changing the declared source scope invalidates all old receipts', () => fixture(async ({src, taskDir, node}) => {
    await certify(taskDir, node);
    await fs.writeFile(path.join(taskDir, 'evidence-scope.json'), JSON.stringify({schema_version: 1, source_roots: [path.join(src, 'core.js')]}));
    assert.equal((await evaluateFloor(taskDir, node)).floorMet, false);
}));

test('a new passing test does not refresh stale compile evidence', () => fixture(async ({src, taskDir, node}) => {
    await certify(taskDir, node);
    await fs.writeFile(path.join(src, 'core.js'), 'export const value = 3;');
    await recordRung(taskDir, node, 'tests', 'PASS');
    const floor = await evaluateFloor(taskDir, node);
    assert.equal(floor.floorMet, false);
    assert.ok(floor.missing.includes('compile'));
}));

test('integration never certifies a missing declared artifact', () => fixture(async ({src, taskDir, roadmap}) => {
    await fs.unlink(path.join(src, 'core.js'));
    await recordTaskIntegration(taskDir, roadmap, 'PASS');
    assert.equal((await evaluateTaskIntegration(taskDir, roadmap)).ok, false);
}));

test('Build is not blindly excluded when it contains source', () => fixture(async ({src, taskDir, node}) => {
    await fs.mkdir(path.join(src, 'Build'));
    await fs.writeFile(path.join(src, 'Build', 'pipeline.js'), 'export const build = 1;');
    await certify(taskDir, node);
    await fs.writeFile(path.join(src, 'Build', 'pipeline.js'), 'export const build = 2;');
    assert.equal((await evaluateFloor(taskDir, node)).floorMet, false);
}));

test('temporarily replacing and restoring source during an oracle invalidates it', () => fixture(async ({src, taskDir, node}) => {
    const before = await captureSourceEvidence(taskDir, node);
    const file = path.join(src, 'core.js');
    const original = await fs.readFile(file);
    await fs.writeFile(file, 'export const value = 99;');
    await fs.writeFile(file, original);
    const receipt = await recordRung(taskDir, node, 'tests', 'PASS', 'oracle passed', before);
    assert.equal(receipt.rungs.tests.result, 'FAIL');
}));
