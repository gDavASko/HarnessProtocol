// Integrity/schema fixtures only. These bytes are NOT a Unity build, and this
// suite never supplies a valid browser launch request or starts a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyBuildReceipt, runWebglSmoke } from './webglSmoke.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-webgl-boundary-'));
    t.after(async () => {
        if (!path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(base).startsWith('harness-webgl-boundary-')) throw new Error('unsafe test cleanup');
        await fs.rm(base, { recursive: true, force: true });
    });
    const jobDirectory = path.join(base, 'job');
    const buildRoot = path.join(jobDirectory, 'build');
    await fs.mkdir(buildRoot, { recursive: true });
    const jobId = 'webgl-boundary-fixture';
    const projectPath = path.join(base, 'project');
    await fs.mkdir(projectPath);
    const readback = {
        jobId, operation: 'build', success: true, projectPath, editorVersion: '6000.0.1f1',
        buildResult: 'Succeeded', buildTarget: 'WebGL', totalErrors: 0, outputPath: buildRoot
    };
    const files = [
        [path.join(jobDirectory, 'Editor.log'), `Synthetic log fixture\nHARNESS_UNITY_COMPLETED:${jobId}:build\n`],
        [path.join(jobDirectory, 'readback.json'), JSON.stringify(readback)],
        ...['index.html', 'fixture.loader.js', 'fixture.framework.js', 'fixture.wasm', 'fixture.data']
            .map(name => [path.join(buildRoot, name), `Synthetic integrity fixture for ${name}; not a Unity player.`])
    ];
    const artifacts = [];
    for (const [file, text] of files) {
        await fs.writeFile(file, text);
        artifacts.push({ path: file, size: Buffer.byteLength(text), sha256: sha(text) });
    }
    const receipt = {
        schemaVersion: 1, jobId, jobDirectory, projectPath, editorVersion: readback.editorVersion,
        ok: true, status: 'passed', operation: 'build', editorLaunched: true,
        process: { jobId, processClosed: true, timedOut: false, exitCode: 0, state: 'exited' },
        source: { before: { sha256: 'a'.repeat(64), fileCount: 3 }, after: { sha256: 'a'.repeat(64), fileCount: 3 }, unchanged: true },
        readback, artifacts, platformVerification: 'unverified', browserVerification: 'not_run'
    };
    const receiptPath = path.join(jobDirectory, 'result.json');
    const write = async (value = receipt) => fs.writeFile(receiptPath, JSON.stringify(value));
    await write();
    return { base, jobDirectory, buildRoot, receiptPath, receipt, write };
}

test('complete synthetic receipt verifies exact bytes without claiming browser or platform acceptance', async t => {
    const ctx = await fixture(t);
    const result = await verifyBuildReceipt(ctx.receiptPath);
    assert.equal(result.root, await fs.realpath(ctx.buildRoot));
    assert.equal(result.jobId, ctx.receipt.jobId);
    assert.equal(result.files.length, 5);
    assert.equal(result.bytes, ctx.receipt.artifacts.filter(file => path.dirname(file.path) === ctx.buildRoot).reduce((sum, file) => sum + file.size, 0));
    assert.equal(result.receiptHash, sha(await fs.readFile(ctx.receiptPath)));
    assert.equal(result.platformAcceptance, undefined);
    assert.equal(result.browserVersion, undefined);
});

test('relative, malformed and unsuccessful build receipts are rejected', async t => {
    const ctx = await fixture(t);
    await assert.rejects(() => verifyBuildReceipt('result.json'), /absolute/i);
    await fs.writeFile(ctx.receiptPath, '{');
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath));
    for (const patch of [{ ok: false }, { operation: 'compile' }, { readback: { ...ctx.receipt.readback, buildResult: 'Failed' } }]) {
        await ctx.write({ ...ctx.receipt, ...patch });
        await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath));
    }
});

test('receipt schema, job/process/readback identity and unchanged-source guarantees are mandatory', async t => {
    const ctx = await fixture(t);
    for (const patch of [
        { schemaVersion: 2 }, { jobId: undefined },
        { process: { ...ctx.receipt.process, jobId: 'another-job' } },
        { process: { ...ctx.receipt.process, processClosed: false } },
        { process: { ...ctx.receipt.process, timedOut: true } },
        { process: { ...ctx.receipt.process, exitCode: 1 } },
        { readback: { ...ctx.receipt.readback, jobId: 'another-job' } },
        { readback: { ...ctx.receipt.readback, buildTarget: 'StandaloneWindows64' } },
        { readback: { ...ctx.receipt.readback, totalErrors: 1 } },
        { source: { ...ctx.receipt.source, unchanged: false } },
        { source: { ...ctx.receipt.source, after: { ...ctx.receipt.source.after, sha256: 'b'.repeat(64) } } }
    ]) {
        await ctx.write({ ...ctx.receipt, ...patch });
        await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), undefined, `must reject ${JSON.stringify(patch)}`);
    }
});

test('required bundle files cannot be omitted or empty even with matching hashes', async t => {
    const ctx = await fixture(t);
    const data = ctx.receipt.artifacts.find(file => file.path.endsWith('.data'));
    await ctx.write({ ...ctx.receipt, artifacts: ctx.receipt.artifacts.filter(file => file !== data) });
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /artifact|data/i);
    await fs.writeFile(data.path, '');
    data.size = 0; data.sha256 = sha('');
    await ctx.write();
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /empty|nonempty|size|artifact/i);
});

test('artifact content and size mutations are rejected', async t => {
    const ctx = await fixture(t);
    const wasm = ctx.receipt.artifacts.find(file => file.path.endsWith('.wasm'));
    const original = await fs.readFile(wasm.path);
    await fs.writeFile(wasm.path, Buffer.alloc(original.length, 0x78));
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /changed|hash|integrity/i);
    await fs.writeFile(wasm.path, Buffer.concat([original, Buffer.from('extra')]));
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /changed|size|integrity/i);
});

test('log/readback hashes outside build but inside the job remain part of the evidence', async t => {
    const ctx = await fixture(t);
    for (const name of ['Editor.log', 'readback.json']) {
        const file = path.join(ctx.jobDirectory, name);
        const original = await fs.readFile(file);
        await fs.writeFile(file, 'tampered job evidence');
        await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /changed|hash|integrity|evidence|readback/i);
        await fs.writeFile(file, original);
    }
});

test('receipt cannot include artifacts outside its job directory', async t => {
    const ctx = await fixture(t);
    const external = path.join(ctx.base, 'outside.data');
    await fs.writeFile(external, 'outside');
    ctx.receipt.artifacts.push({ path: external, size: 7, sha256: sha('outside') });
    await ctx.write();
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /outside|escaped|contain|job/i);
});

test('build output cannot be redirected to another directory outside the job', async t => {
    const ctx = await fixture(t);
    const externalBuild = path.join(ctx.base, 'other-build');
    await fs.mkdir(externalBuild);
    for (const artifact of ctx.receipt.artifacts.filter(file => path.dirname(file.path) === ctx.buildRoot)) {
        const target = path.join(externalBuild, path.basename(artifact.path));
        await fs.copyFile(artifact.path, target);
        artifact.path = target;
    }
    ctx.receipt.readback.outputPath = externalBuild;
    await ctx.write();
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /outside|escaped|contain|job|output/i);
});

test('a directory junction cannot smuggle an artifact outside the verified build', async t => {
    const ctx = await fixture(t);
    const outside = path.join(ctx.base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'escape.data'), 'escape');
    const link = path.join(ctx.buildRoot, 'linked');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    ctx.receipt.artifacts.push({ path: path.join(link, 'escape.data'), size: 6, sha256: sha('escape') });
    await ctx.write();
    await assert.rejects(() => verifyBuildReceipt(ctx.receiptPath), /outside|escaped|contain|redirect/i);
});

test('request schema rejects bad deadlines, observable names, steps and assertion shapes before browser work', async () => {
    const request = {
        timeoutMs: 1000, stateGlobal: 'unityState', initial: { ready: true },
        steps: [{ type: 'key', key: 'Space', expected: { score: 1 } }],
        buildReceiptPath: 'UNREACHABLE_RELATIVE_RECEIPT', browserExecutable: 'NEVER_LAUNCH', browserSha256: ''
    };
    for (const timeoutMs of [undefined, 0, -1, 999, 300001, Infinity, 1500.5]) {
        await assert.rejects(() => runWebglSmoke({ ...request, timeoutMs }), /timeoutMs/);
    }
    await assert.rejects(() => runWebglSmoke({ ...request, stateGlobal: 'x.y' }), /stateGlobal/);
    await assert.rejects(() => runWebglSmoke({ ...request, steps: [] }), /step/i);
    for (const initial of ['ready', [true], {}]) {
        await assert.rejects(() => runWebglSmoke({ ...request, initial }), /initial|ready-state/i);
    }
    for (const step of [
        { type: 'key', key: 'Space', expected: 'not-an-object' },
        { type: 'key', key: 'Space', expected: [1] },
        { type: 'key', expected: { score: 1 } },
        { type: 'click', position: { x: Infinity, y: 0 }, expected: { score: 1 } }
    ]) await assert.rejects(() => runWebglSmoke({ ...request, steps: [step] }), /step|expected|key|position/i);
});
