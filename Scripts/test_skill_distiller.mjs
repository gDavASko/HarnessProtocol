import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { distillSkillIfEligible } from './graph/skillDistiller.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skill-candidates-'));
    t.after(async () => {
        if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('harness-skill-candidates-')) throw new Error('unsafe test cleanup');
        await fs.rm(root, { recursive: true, force: true });
    });
    const taskDir = path.join(root, 'task');
    const activeDir = path.join(root, '.agents', 'skills');
    const existingSkill = path.join(activeDir, 'distilled-tact-02', 'SKILL.md');
    await fs.mkdir(taskDir);
    await fs.mkdir(path.dirname(existingSkill), { recursive: true });
    await fs.writeFile(existingSkill, 'Existing reviewed instructions must remain unchanged.');
    return { root, taskDir, activeDir, existingSkill };
}

const eligible = { id: 'TACT-02', title: 'Candidate fixture', criticality: 'L3', iteration: 1, dod: ['Preserve existing skills'] };

test('distillation produces a readable inactive task-local candidate and preserves installed instructions', async t => {
    const ctx = await fixture(t);
    const before = await fs.stat(ctx.existingSkill);
    const existing = await fs.readFile(ctx.existingSkill, 'utf8');
    const result = await distillSkillIfEligible(ctx.taskDir, eligible, 'Observed successful solution fixture.');
    assert.equal(result.distilled, true);
    assert.equal(result.activation, 'not_installed');
    assert.equal(result.promotion_requires_review, true);
    assert.ok(result.skillPath.startsWith(path.join(ctx.taskDir, '.harness', 'skill-candidates') + path.sep));
    assert.ok(!result.skillPath.includes(path.join('.agents', 'skills')));
    const candidate = await fs.readFile(result.skillPath, 'utf8');
    assert.match(candidate, /activation: not_installed/);
    assert.match(candidate, /promotion_requires_review: true/);
    assert.match(candidate, /Observed successful solution fixture/);
    assert.equal(await fs.readFile(ctx.existingSkill, 'utf8'), existing);
    assert.equal((await fs.stat(ctx.existingSkill)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await fs.readdir(ctx.activeDir), ['distilled-tact-02']);
});

test('repeated and same-node calls in separate tasks never overwrite earlier candidates', async t => {
    const ctx = await fixture(t);
    const secondTask = path.join(ctx.root, 'second-task');
    await fs.mkdir(secondTask);
    const first = await distillSkillIfEligible(ctx.taskDir, eligible, 'First candidate remains available for review.');
    const next = await distillSkillIfEligible(ctx.taskDir, eligible, 'Second candidate.');
    const other = await distillSkillIfEligible(secondTask, eligible, 'Other task candidate.');
    assert.equal(next.distilled, true);
    assert.equal(other.distilled, true);
    assert.equal(new Set([first.skillPath, next.skillPath, other.skillPath]).size, 3);
    assert.match(await fs.readFile(first.skillPath, 'utf8'), /First candidate remains/);
    assert.ok(other.skillPath.startsWith(secondTask + path.sep));
});

test('ineligible/error summaries create neither a candidate nor installed skill', async t => {
    const ctx = await fixture(t);
    for (const [node, summary] of [[{ ...eligible, criticality: 'L1' }, 'Done'], [eligible, '[Model Fallback Error] unavailable']]) {
        const result = await distillSkillIfEligible(ctx.taskDir, node, summary);
        assert.equal(result.distilled, false);
        assert.equal(result.activation, 'not_installed');
        assert.equal(result.promotion_requires_review, true);
    }
    assert.deepEqual(await fs.readdir(ctx.taskDir), []);
    assert.deepEqual(await fs.readdir(ctx.activeDir), ['distilled-tact-02']);
});

test('active discovery roots and junction redirections are refused before any candidate write', async t => {
    const ctx = await fixture(t);
    const direct = await distillSkillIfEligible(ctx.activeDir, eligible, 'Must not become active.');
    assert.equal(direct.distilled, false);
    assert.match(direct.error, /active skill discovery/);
    await fs.symlink(ctx.activeDir, path.join(ctx.taskDir, '.harness'), process.platform === 'win32' ? 'junction' : 'dir');
    const redirected = await distillSkillIfEligible(ctx.taskDir, eligible, 'Must not follow active directory junction.');
    assert.equal(redirected.distilled, false);
    assert.match(redirected.error, /redirects/);
    assert.deepEqual(await fs.readdir(ctx.activeDir), ['distilled-tact-02']);
    assert.equal(await fs.readFile(ctx.existingSkill, 'utf8'), 'Existing reviewed instructions must remain unchanged.');
});
