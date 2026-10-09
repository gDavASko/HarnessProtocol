import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireProjectLock, releaseProjectLock, inspectProjectLock, runManagedJob, canonicalPath, writeJson } from './managedJob.mjs';
import { preflightUnity, evaluateUnityResult, makeUnityArguments, parseUnityLog, recoverUnity, unityJobStatus, sha256, sourceFingerprint, appendUnityFailure, inspectUnityLock } from './unityRunner.mjs';

const execFileAsync = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(scripts, '..', '.harness');
fs.mkdirSync(harnessRoot, { recursive: true });
const testRoot = path.join(harnessRoot, `unity-runtime-tests-${crypto.randomUUID()}`);
fs.mkdirSync(testRoot);
const fixture = path.join(scripts, 'managedJobFixture.mjs');
after(() => {
    const root = fs.realpathSync.native(testRoot);
    const parent = fs.realpathSync.native(harnessRoot);
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^unity-runtime-tests-[a-f0-9-]+$/);
    // Only this uniquely created and resolved test directory is removed.
    fs.rmSync(root, { recursive: true, force: false });
});
function directory(name) { const result = path.join(testRoot, name); fs.mkdirSync(result); return result; }
async function project(name) {
    const projectPath = directory(name);
    for (const sub of ['Assets/Editor', 'ProjectSettings', 'Packages']) fs.mkdirSync(path.join(projectPath, sub), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
    writeJson(path.join(projectPath, 'Packages/manifest.json'), { dependencies: { 'com.unity.test-framework': '1.4.6' } });
    // Not executable: this file only exercises read-only explicit hash pinning.
    const editorPath = path.join(projectPath, 'Unity.exe');
    fs.writeFileSync(editorPath, 'non-executable proof fixture');
    const methodSourcePath = path.join(projectPath, 'Assets/Editor/Fixture.cs');
    fs.writeFileSync(methodSourcePath, '// static method source fixture, never compiled');
    return { action: 'preflight', operation: 'compile', projectPath, editorPath, editorVersion: '6000.0.1f1', editorSha256: await sha256(editorPath), executeMethod: 'Fixture.Execute', methodSourcePath, methodSourceSha256: await sha256(methodSourcePath) };
}
function evidence(name, operation = 'compile') {
    const directoryPath = canonicalPath(directory(name));
    const job = { jobId: crypto.randomUUID(), directory: directoryPath, projectPath: canonicalPath(testRoot), logPath: path.join(directoryPath, 'Editor.log'), readbackPath: path.join(directoryPath, 'readback.json'), testResultsPath: path.join(directoryPath, 'results.xml'), outputPath: path.join(directoryPath, 'build'), requestPath: path.join(directoryPath, 'editor-request.json') };
    const request = { operation, editorVersion: '6000.0.1f1', expectedTestCount: 1 };
    const processResult = { jobId: job.jobId, processClosed: true, timedOut: false, exitCode: 0 };
    fs.writeFileSync(job.logPath, `Editor log fixture\nHARNESS_UNITY_COMPLETED:${job.jobId}:${operation}\n`);
    writeJson(job.readbackPath, { jobId: job.jobId, operation, success: true, projectPath: job.projectPath, editorVersion: request.editorVersion });
    return { job, request, processResult };
}

test('read-only preflight checks identity without making runtime directories or launching Unity', async () => {
    const request = await project('preflight');
    const result = await preflightUnity(request);
    assert.equal(result.ok, true); assert.equal(result.editorLaunched, false);
    assert.equal(result.connection, 'not_attempted');
    assert.equal(fs.existsSync(path.join(request.projectPath, '.harness')), false);
    await assert.rejects(preflightUnity({ ...request, editorVersion: '6000.0.2f1' }), /ProjectVersion mismatch/);
    await assert.rejects(preflightUnity({ ...request, editorSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
    await assert.rejects(preflightUnity({ ...request, methodSourceSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
});
test('an unheld UnityLockfile is preserved and Windows can retry without deleting it', async () => {
    const request = await project('unity-lock');
    fs.mkdirSync(path.join(request.projectPath, 'Temp'));
    fs.writeFileSync(path.join(request.projectPath, 'Temp/UnityLockfile'), 'fixture');
    const result = await preflightUnity(request);
    assert.equal(result.ok, process.platform === 'win32');
    assert.equal(result.checks.unityLock, process.platform !== 'win32');
    assert.equal(result.checks.unityLockEvidence.state, process.platform === 'win32' ? 'unheld' : 'unknown');
    assert.equal(result.checks.unityLockEvidence.present, true);
    assert.equal(fs.existsSync(path.join(request.projectPath, 'Temp/UnityLockfile')), true);
    assert.equal(fs.readFileSync(path.join(request.projectPath, 'Temp/UnityLockfile'), 'utf8'), 'fixture');
    assert.equal(fs.existsSync(path.join(request.projectPath, '.harness')), false);
});

async function holdUnityLock(lockPath, share = 'None') {
    // This owned test helper exits normally when stdin closes. Never signal/kill
    // a PID and never invoke Unity; the existing test lockfile is only opened.
    const script = '$ErrorActionPreference="Stop"; $h=$null; try {$s=[Enum]::Parse([System.IO.FileShare],$env:HARNESS_TEST_LOCK_SHARE); $h=[System.IO.File]::Open($env:HARNESS_TEST_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,$s); [Console]::Out.WriteLine("HELD"); [Console]::Out.Flush(); [void][Console]::In.ReadLine()} finally {if($null -ne $h){$h.Dispose()}}';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, HARNESS_TEST_LOCK_PATH: lockPath, HARNESS_TEST_LOCK_SHARE: share }, windowsHide: true, stdio: 'pipe'
    });
    child.stdin.on('error', () => {});
    const closed = new Promise(resolve => child.once('close', resolve));
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.stdin.end(); reject(new Error(`Lock fixture did not become ready: ${errorText}`)); }, 10000);
        child.stdout.on('data', chunk => { if (String(chunk).includes('HELD')) { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); reject(new Error(`Lock fixture closed (${code}): ${errorText}`)); });
    });
    return async () => { child.stdin.end('\n'); await closed; };
}

test('an OS-held Unity lock blocks preflight and status until its owner releases the handle', { skip: process.platform !== 'win32' }, async t => {
    const request = await project('unity-held-lock');
    fs.mkdirSync(path.join(request.projectPath, 'Temp'));
    const file = path.join(request.projectPath, 'Temp/UnityLockfile');
    fs.writeFileSync(file, 'held fixture');
    for (const share of ['None', 'ReadWrite, Delete']) {
        const release = await holdUnityLock(file, share);
        try {
            const state = await inspectUnityLock(request.projectPath);
            assert.equal(state.blocked, true);
            assert.equal(state.state, 'held');
            const preflight = await preflightUnity(request);
            assert.equal(preflight.ok, false);
            assert.equal(preflight.checks.unityLock, true);
            const status = await unityJobStatus({ projectPath: request.projectPath });
            assert.equal(status.status, 'external_editor_lock');
            assert.equal(status.replayAllowed, false);
        } finally { await release(); }
        assert.equal((await inspectUnityLock(request.projectPath)).state, 'unheld');
    }
    const afterRelease = await preflightUnity(request);
    assert.equal(afterRelease.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'held fixture');
    assert.equal(fs.existsSync(path.join(request.projectPath, '.harness')), false);
});

test('unknown or redirected Unity lock paths fail closed without altering them', async () => {
    const request = await project('unity-redirected-lock');
    const outside = directory('unity-redirect-target');
    fs.writeFileSync(path.join(outside, 'UnityLockfile'), 'outside fixture');
    fs.symlinkSync(outside, path.join(request.projectPath, 'Temp'), process.platform === 'win32' ? 'junction' : 'dir');
    const state = await inspectUnityLock(request.projectPath);
    assert.equal(state.blocked, true);
    assert.equal(state.state, 'unknown');
    assert.equal((await preflightUnity(request)).ok, false);
    assert.equal(fs.readFileSync(path.join(outside, 'UnityLockfile'), 'utf8'), 'outside fixture');
    fs.unlinkSync(path.join(request.projectPath, 'Temp'));
});

test('known failed compilation recovery accepts only an unheld Unity lock and never removes it', { skip: process.platform !== 'win32' }, async () => {
    const request = await project('unity-failed-compile-lock');
    const lock = acquireProjectLock(request.projectPath, 'failed-compile-job');
    const jobDirectory = path.join(lock.root, 'jobs', lock.owner.jobId);
    fs.mkdirSync(jobDirectory, { recursive: true });
    writeJson(path.join(jobDirectory, 'process.json'), { jobId: lock.owner.jobId, pid: null, state: 'exited', processClosed: true, timedOut: false, exitCode: 1 });
    writeJson(path.join(jobDirectory, 'result.json'), { jobId: lock.owner.jobId, ok: false, status: 'failed' });
    fs.mkdirSync(path.join(request.projectPath, 'Temp'));
    const file = path.join(request.projectPath, 'Temp/UnityLockfile');
    fs.writeFileSync(file, 'leftover after compiler exit 1');
    const release = await holdUnityLock(file);
    try {
        assert.equal((await recoverUnity({ projectPath: lock.project, jobId: lock.owner.jobId })).ok, false);
        assert.equal(inspectProjectLock(lock.project).locked, true);
    } finally { await release(); }
    const recovered = await recoverUnity({ projectPath: lock.project, jobId: lock.owner.jobId });
    assert.equal(recovered.status, 'recovered_completed_job');
    assert.equal(recovered.replayed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'leftover after compiler exit 1');
    assert.equal((await preflightUnity(request)).ok, true);
});
test('full source fingerprints include unrelated scripts and generated meta files', async () => {
    const request = await project('source-fingerprint');
    const before = await sourceFingerprint(request.projectPath);
    const script = path.join(request.projectPath, 'Assets/Unrelated.cs');
    fs.writeFileSync(script, '// unrelated script is part of source identity');
    const afterScript = await sourceFingerprint(request.projectPath);
    assert.notEqual(before.sha256, afterScript.sha256);
    fs.writeFileSync(`${script}.meta`, 'fileFormatVersion: 2\nguid: fixture');
    const afterMeta = await sourceFingerprint(request.projectPath);
    assert.notEqual(afterScript.sha256, afterMeta.sha256);
    assert.equal(afterMeta.files.some(file => file.path === 'Assets/Unrelated.cs.meta'), true);
});
test('one canonical project writer across independent child processes; stale owner is not stolen', async () => {
    const projectPath = directory('exclusive');
    const children = await Promise.allSettled(['writer-a', 'writer-b'].map(id => execFileAsync(process.execPath, [fixture, 'lock', projectPath, id], { windowsHide: true })));
    assert.equal(children.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(children.filter(result => result.status === 'rejected').length, 1);
    const lock = inspectProjectLock(path.join(projectPath, '.'));
    assert.equal(lock.locked, true);
    assert.throws(() => acquireProjectLock(projectPath, 'third'), /PROJECT_LOCKED/);
    releaseProjectLock(lock);
});
test('mismatched lock token cannot release another owner', () => {
    const lock = acquireProjectLock(directory('token-lock'), 'owner');
    assert.throws(() => releaseProjectLock({ ...lock, owner: { ...lock.owner, token: 'not-owner' } }), /ownership changed/);
    assert.equal(inspectProjectLock(lock.project).locked, true);
    releaseProjectLock(lock);
});
test('runtime junction escape is refused', () => {
    const projectPath = directory('junction');
    const outside = directory('junction-target');
    fs.symlinkSync(outside, path.join(projectPath, '.harness'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => acquireProjectLock(projectPath, 'escape'), /redirects/);
    fs.unlinkSync(path.join(projectPath, '.harness'));
});
test('managed local child preserves literal arguments and durable process result without a shell', async () => {
    const jobDirectory = directory('literal-arguments');
    const output = path.join(jobDirectory, 'argv.json');
    const literals = ['a path with spaces', '$(not-a-command)', '; harmless & text', 'a"quote'];
    const result = await runManagedJob({ jobId: 'literal', jobDirectory, executable: process.execPath, args: [fixture, 'echo', output, ...literals], cwd: jobDirectory, timeoutMs: 5000 });
    assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 0); assert.equal(result.processClosed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), literals);
    assert.equal(JSON.parse(fs.readFileSync(path.join(jobDirectory, 'process.json'))).pid, result.pid);
});
test('managed nonzero child exit is preserved', async () => {
    const jobDirectory = directory('failed-child');
    const result = await runManagedJob({ jobId: 'failure', jobDirectory, executable: process.execPath, args: [fixture, 'fail'], cwd: jobDirectory, timeoutMs: 5000 });
    assert.equal(result.exitCode, 7); assert.equal(result.processClosed, true);
});
test('managed timeout is bounded and is never reported as successful recovery', async () => {
    const jobDirectory = directory('timeout');
    const start = Date.now();
    const result = await runManagedJob({ jobId: 'timeout', jobDirectory, executable: process.execPath, args: [fixture, 'hang'], cwd: jobDirectory, timeoutMs: 100, killGraceMs: 500 });
    assert.equal(result.timedOut, true); assert.equal(result.state, 'recovery_required');
    assert.ok(Date.now() - start < 3000);
    assert.equal(result.processClosed, true);
});
test('missing executable is recorded as spawn failure', async () => {
    const jobDirectory = directory('spawn-failure');
    const result = await runManagedJob({ jobId: 'spawn-failure', jobDirectory, executable: path.join(jobDirectory, 'absent.exe'), args: [], cwd: jobDirectory, timeoutMs: 1000 });
    assert.equal(result.state, 'spawn_failed'); assert.equal(result.processClosed, true);
});
test('tests do not use -quit and build target is explicit', () => {
    const { job } = evidence('arguments');
    const tests = makeUnityArguments({ operation: 'test', testPlatform: 'EditMode' }, job);
    assert.ok(tests.includes('-runTests')); assert.ok(!tests.includes('-quit'));
    assert.ok(makeUnityArguments({ operation: 'build', executeMethod: 'Fixture.Execute' }, job).includes('WebGL'));
});
test('exit zero without current readback and log marker never passes compile', async () => {
    const { request, job, processResult } = evidence('compile-evidence');
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, true);
    fs.writeFileSync(job.logPath, 'Editor fixture with no completion marker');
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
    fs.writeFileSync(job.logPath, `HARNESS_UNITY_COMPLETED:${job.jobId}:compile\nerror CS1001: fixture error`);
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
    fs.writeFileSync(job.logPath, `HARNESS_UNITY_COMPLETED:${job.jobId}:compile\nNullReferenceException: broken bootstrap`);
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
    fs.writeFileSync(job.logPath, `HARNESS_UNITY_COMPLETED:${job.jobId}:compile\n[Bootstrap] Error: initialization failed`);
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
    fs.writeFileSync(job.logPath, `HARNESS_UNITY_COMPLETED:${job.jobId}:compile`);
    writeJson(job.readbackPath, { jobId: 'stale' });
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
});
test('malformed, empty, failed, skipped and count-mismatched NUnit reports fail', async () => {
    const { request, job, processResult } = evidence('test-evidence', 'test');
    const report = '<test-run result="Passed" total="1" passed="1" failed="0" skipped="0"><test-case result="Passed" /></test-run>';
    fs.writeFileSync(job.testResultsPath, report);
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, true);
    assert.equal((await evaluateUnityResult({ ...request, expectedTestCount: 2 }, job, processResult)).ok, false);
    for (const invalid of ['', '<test-run', report.replace('result="Passed" />', 'result="Skipped" />'), report.replace('result="Passed" />', 'result="Failed" />')]) {
        fs.writeFileSync(job.testResultsPath, invalid);
        assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
    }
});
test('WebGL requires actual nonempty output classes and never certifies browser behavior', async () => {
    const { request, job, processResult } = evidence('build-evidence', 'build');
    fs.mkdirSync(job.outputPath);
    writeJson(job.readbackPath, { jobId: job.jobId, operation: 'build', success: true, projectPath: job.projectPath, editorVersion: request.editorVersion, buildResult: 'Succeeded', buildTarget: 'WebGL', totalErrors: 0, outputPath: job.outputPath });
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
    for (const file of ['index.html', 'fixture.loader.js', 'fixture.framework.js', 'fixture.wasm', 'fixture.data']) fs.writeFileSync(path.join(job.outputPath, file), 'nonempty test double; not a Unity build');
    const acceptedFixture = await evaluateUnityResult(request, job, processResult);
    assert.equal(acceptedFixture.ok, true);
    assert.equal(acceptedFixture.browserVerification, 'not_run');
    assert.equal(acceptedFixture.platformVerification, 'unverified');
    fs.writeFileSync(path.join(job.outputPath, 'fixture.wasm'), '');
    assert.equal((await evaluateUnityResult(request, job, processResult)).ok, false);
});
test('recovery refuses ambiguous/timeout jobs even when the root PID is absent', async () => {
    const lock = acquireProjectLock(directory('ambiguous'), 'ambiguous-job');
    const jobDirectory = path.join(lock.root, 'jobs', lock.owner.jobId);
    fs.mkdirSync(jobDirectory, { recursive: true });
    writeJson(path.join(jobDirectory, 'process.json'), { jobId: lock.owner.jobId, pid: null, state: 'starting' });
    const result = await recoverUnity({ projectPath: lock.project, jobId: lock.owner.jobId });
    assert.equal(result.ok, false); assert.equal(inspectProjectLock(lock.project).locked, true);
    writeJson(path.join(jobDirectory, 'process.json'), { jobId: lock.owner.jobId, pid: null, state: 'recovery_required', processClosed: true, timedOut: true });
    writeJson(path.join(jobDirectory, 'result.json'), { jobId: lock.owner.jobId, ok: false });
    assert.equal((await recoverUnity({ projectPath: lock.project, jobId: lock.owner.jobId })).ok, false);
    releaseProjectLock(lock); // test owns this inert fixture; no real child was ever created
});
test('recovery finishes only known clean completion cleanup without replay', async () => {
    const lock = acquireProjectLock(directory('completed'), 'completed-job');
    const jobDirectory = path.join(lock.root, 'jobs', lock.owner.jobId);
    fs.mkdirSync(jobDirectory, { recursive: true });
    writeJson(path.join(jobDirectory, 'process.json'), { jobId: lock.owner.jobId, pid: null, state: 'spawn_failed', processClosed: true, timedOut: false });
    writeJson(path.join(jobDirectory, 'result.json'), { jobId: lock.owner.jobId, ok: false });
    assert.equal((await recoverUnity({ projectPath: lock.project, jobId: 'wrong' })).ok, false);
    const recovered = await recoverUnity({ projectPath: lock.project, jobId: lock.owner.jobId });
    assert.equal(recovered.status, 'recovered_completed_job'); assert.equal(recovered.replayed, false);
    assert.equal((await unityJobStatus({ projectPath: lock.project })).status, 'idle');
});
test('log failures are interpreted instead of discarded', () => {
    assert.equal(parseUnityLog('No valid Unity Editor license\nBuildFailedException: failed').errorCount, 2);
    assert.equal(parseUnityLog('').present, false);
    assert.equal(parseUnityLog('Build succeeded with 0 errors\nNo errors found').errorCount, 0);
});
const recoveredLicensingFixture = [
    '[Licensing::Client] Error: HandshakeResponse reported an error:',
    '  ResponseCode: 505',
    "  ResponseStatus: Unsupported protocol version '1.18.3'.",
    '[Licensing::Module] Error: Failed to handshake to channel: "LicenseClient-TestFixture"',
    '[Licensing::Module] Successfully connected to LicensingClient on channel: "LicenseClient-TestFixture-6000.5.10" (connect: 1s)',
    '[Licensing::Module] Error: Access token is unavailable; failed to update',
    '[Licensing::Client] Successfully updated license, isAsync: True, time: 0.01',
    '[Licensing::Client] Successfully resolved entitlement details',
    '[Licensing::Module] Licensing is initialized (took 3.28s).',
    'Initialize engine version: 6000.5.10f1 (synthetic-fixture)'
].join('\n');
test('known licensing startup failures recover only after ordered license/entitlement/initialization proof', () => {
    const recovered = parseUnityLog(recoveredLicensingFixture);
    assert.equal(recovered.errorCount, 0);
    assert.equal(recovered.recoveredDiagnostics.length, 3);
    assert.equal(recovered.licensingRecoveryProof.initializedLine, 9);
    for (const required of [
        'Successfully connected to LicensingClient',
        'Successfully updated license',
        'Successfully resolved entitlement details',
        'Licensing is initialized',
        'Initialize engine version'
    ]) {
        const incomplete = recoveredLicensingFixture.split('\n').filter(line => !line.includes(required)).join('\n');
        assert.equal(parseUnityLog(incomplete).errorCount, 3, required);
        assert.equal(parseUnityLog(incomplete).recoveredDiagnostics.length, 0, required);
    }
    assert.ok(parseUnityLog(recoveredLicensingFixture.replace('ResponseCode: 505', 'ResponseCode: 999')).errorCount >= 2);
    assert.ok(parseUnityLog(recoveredLicensingFixture.split('\n').reverse().join('\n')).errorCount >= 3);
});
test('licensing initialization and entitlement notifications may arrive in either order before engine initialization', () => {
    const asynchronousOrder = recoveredLicensingFixture.replace(
        '[Licensing::Client] Successfully resolved entitlement details\n[Licensing::Module] Licensing is initialized (took 3.28s).',
        '[Licensing::Module] Licensing is initialized (took 3.28s).\n[Licensing::Client] Successfully resolved entitlement details'
    );
    const recovered = parseUnityLog(asynchronousOrder);
    assert.equal(recovered.errorCount, 0);
    assert.equal(recovered.recoveredDiagnostics.length, 3);
    assert.equal(recovered.licensingRecoveryProof.initializedLine, 8);
    assert.equal(recovered.licensingRecoveryProof.entitlementResolvedLine, 9);
    assert.equal(recovered.licensingRecoveryProof.startupBoundaryLine, 10);
    const entitlementAfterEngine = asynchronousOrder.replace(
        '[Licensing::Client] Successfully resolved entitlement details\nInitialize engine version: 6000.5.10f1 (synthetic-fixture)',
        'Initialize engine version: 6000.5.10f1 (synthetic-fixture)\n[Licensing::Client] Successfully resolved entitlement details'
    );
    assert.equal(parseUnityLog(entitlementAfterEngine).recoveredDiagnostics.length, 0);
    assert.equal(parseUnityLog(entitlementAfterEngine).errorCount, 3);
    const initAfterEngine = recoveredLicensingFixture.replace(
        '[Licensing::Module] Licensing is initialized (took 3.28s).\nInitialize engine version: 6000.5.10f1 (synthetic-fixture)',
        'Initialize engine version: 6000.5.10f1 (synthetic-fixture)\n[Licensing::Module] Licensing is initialized (took 3.28s).'
    );
    assert.equal(parseUnityLog(initAfterEngine).recoveredDiagnostics.length, 0);
    assert.equal(parseUnityLog(`${asynchronousOrder}\n[Licensing::Module] Error: Access token is unavailable; failed to update`).errorCount, 1);
    assert.equal(parseUnityLog(`${asynchronousOrder}\nNullReferenceException: actual runtime failure`).errorCount, 1);
});
test('recovered licensing never clears generic runtime errors, unknown diagnostics or later license failures', () => {
    for (const error of [
        'NullReferenceException: bootstrap failed',
        '[Bootstrap] Error: initialization failed',
        '[Licensing::Module] Error: Unknown licensing diagnostic',
        '[Licensing::Module] Error: Access token is unavailable; failed to update',
        'No valid Unity Editor license'
    ]) {
        const parsed = parseUnityLog(`${recoveredLicensingFixture}\n${error}`);
        assert.equal(parsed.errorCount, 1, error);
        assert.equal(parsed.recoveredDiagnostics.length, 3);
    }
});
test('source freshness failure preserves process and log failures instead of replacing them', async () => {
    const { request, job, processResult } = evidence('multiple-failures');
    fs.writeFileSync(job.logPath, 'error CS1001: fixture compiler failure');
    const result = await evaluateUnityResult(request, job, { ...processResult, exitCode: 1 });
    appendUnityFailure(result, 'source', 'Source fingerprint changed', 'source_changed');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.failures.map(failure => failure.stage), ['process', 'log', 'source']);
    assert.match(result.reason, /Process did not finish successfully/);
    assert.match(result.reason, /Editor log is empty or contains/);
    assert.match(result.reason, /Source fingerprint changed/);
    assert.equal(result.log.errorCount, 1);
});
