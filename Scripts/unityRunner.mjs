#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalPath, inspectProjectLock, acquireProjectLock, releaseProjectLock, runManagedJob, inspectProcess, readJson, writeJson } from './managedJob.mjs';
import { parseUnityTestResults } from './parseUnityTestResults.mjs';

const execFileAsync = promisify(execFile);
const VERSION = /^\d+\.\d+\.\d+[abfp]\d+$/;
export async function sha256(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
export async function sourceFingerprint(projectPath) {
    const project = canonicalPath(projectPath);
    const files = [];
    const pending = ['Assets', 'Packages', 'ProjectSettings'];
    while (pending.length) {
        const relative = pending.pop();
        const absolute = path.join(project, relative);
        requireValue(canonicalPath(absolute) === (process.platform === 'win32' ? absolute.toLowerCase() : absolute), `Source path redirects and cannot be pinned: ${absolute}`);
        const entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const nested = path.join(relative, entry.name);
            requireValue(!entry.isSymbolicLink(), `Source symlink cannot be pinned: ${nested}`);
            if (entry.isDirectory()) pending.push(nested);
            else if (entry.isFile()) {
                const file = path.join(project, nested);
                const before = fs.statSync(file);
                const digest = await sha256(file);
                const after = fs.statSync(file);
                requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs, `Source changed during hashing: ${nested}`);
                files.push({ path: nested.split(path.sep).join('/'), size: after.size, sha256: digest });
            } else throw new Error(`Unsupported source entry: ${nested}`);
        }
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'), fileCount: files.length, files };
}
function requireValue(condition, reason) { if (!condition) throw new Error(reason); }
function inside(root, file) {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function fileInside(root, file) {
    const resolved = canonicalPath(file);
    requireValue(inside(root, resolved) && fs.statSync(resolved).isFile(), `Expected a regular file inside ${root}: ${file}`);
    return resolved;
}

// Windows checks sharing modes against ALL existing handles, including handles
// owned by the same process. FileMode.Open + FileAccess.Read + FileShare.None
// neither creates, truncates nor deletes the file. An unheld leftover file is
// therefore different from active/uncertain ownership. This is a point-in-time
// probe, not a replacement for Unity's own lock when the Editor starts.
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
// https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare
const WINDOWS_UNITY_LOCK_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$handle = $null
$observation = $null
try {
    $handle = [System.IO.File]::Open($env:HARNESS_UNITY_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    $observation = @{state='unheld'; present=$true; blocked=$false}
} catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $nativeCode = $failure.HResult -band 65535
    if ($nativeCode -eq 2 -or $nativeCode -eq 3) {
        $observation = @{state='absent'; present=$false; blocked=$false}
    } elseif ($nativeCode -eq 32 -or $nativeCode -eq 33) {
        $observation = @{state='held'; present=$true; blocked=$true; nativeCode=$nativeCode}
    } else {
        $observation = @{state='unknown'; present=$true; blocked=$true; nativeCode=$nativeCode; reason=$failure.Message}
    }
} finally {
    if ($null -ne $handle) { $handle.Dispose() }
}
$observation | ConvertTo-Json -Compress
`;

/** Read-only lock observation; unknown/redirected/non-Windows existing files block. */
export async function inspectUnityLock(projectPath) {
    const project = canonicalPath(projectPath);
    const tempPath = path.join(project, 'Temp');
    const lockPath = path.join(tempPath, 'UnityLockfile');
    const evidence = { path: lockPath, checkedAt: new Date().toISOString(), method: 'path-inspection', readOnly: true };
    try {
        for (const [candidate, directory] of [[tempPath, true], [lockPath, false]]) {
            const stat = fs.lstatSync(candidate);
            const expected = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
            requireValue(!stat.isSymbolicLink() && canonicalPath(candidate) === expected && (directory ? stat.isDirectory() : stat.isFile()), 'Unity lock path redirects or is not a regular file/directory');
        }
    } catch (error) {
        if (error.code === 'ENOENT') return { ...evidence, state: 'absent', present: false, blocked: false };
        return { ...evidence, state: 'unknown', present: true, blocked: true, reason: String(error.message).slice(0, 300) };
    }
    if (process.platform !== 'win32') return { ...evidence, state: 'unknown', present: true, blocked: true, reason: 'Existing UnityLockfile: OS ownership probe is only supported on Windows' };
    try {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_UNITY_LOCK_PROBE],
            { env: { ...process.env, HARNESS_UNITY_LOCK_PATH: lockPath }, windowsHide: true, timeout: 5000, maxBuffer: 65536 });
        const observed = JSON.parse(stdout.trim());
        requireValue(['absent', 'unheld', 'held', 'unknown'].includes(observed.state) &&
            observed.blocked === ['held', 'unknown'].includes(observed.state) &&
            observed.present === (observed.state !== 'absent'), 'Invalid OS lock observation');
        return { ...evidence, ...observed, method: 'windows-exclusive-read' };
    } catch (error) {
        return { ...evidence, state: 'unknown', present: true, blocked: true, method: 'windows-exclusive-read', reason: String(error.message).slice(0, 300) };
    }
}
async function editorProof(request, editor) {
    const expected = request.editorVersion;
    requireValue(VERSION.test(expected), 'editorVersion must be an exact Unity Editor version');
    // Explicit expected executable pins are portable, and never inferred from a directory name.
    const digest = await sha256(editor);
    if (request.editorSha256 !== undefined) {
        requireValue(/^[a-f0-9]{64}$/i.test(request.editorSha256) && digest === request.editorSha256.toLowerCase(), 'Editor executable SHA-256 mismatch');
        return { kind: 'explicit-executable-pin', version: expected, sha256: digest, limitation: 'Version mapping is the caller\'s explicit attestation, not discovered metadata' };
    }
    requireValue(process.platform === 'win32', 'An explicit editorSha256 pin is required on this OS');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference="Stop"; (Get-Item -LiteralPath $env:HARNESS_EDITOR_PROOF_PATH).VersionInfo.ProductVersion'],
        { env: { ...process.env, HARNESS_EDITOR_PROOF_PATH: editor }, windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    const metadata = stdout.trim();
    requireValue(metadata.split(/[\s_()]/)[0] === expected, `Installed Editor metadata does not match ${expected}: ${metadata}`);
    return { kind: 'windows-file-version', version: expected, metadata, sha256: digest };
}

/** Read-only: hashes files and reads process/lock metadata, never starts Unity or creates directories. */
export async function preflightUnity(request) {
    requireValue(request && typeof request === 'object' && !Array.isArray(request), 'Request must be a JSON object');
    requireValue(['compile', 'test', 'build'].includes(request.operation), 'operation must be compile, test or build');
    const projectPath = canonicalPath(request.projectPath);
    requireValue(fs.statSync(projectPath).isDirectory(), 'projectPath must be a directory');
    const editorPath = canonicalPath(request.editorPath);
    requireValue(fs.statSync(editorPath).isFile(), 'editorPath must be a regular executable file');
    requireValue(/^Unity(?:\.exe)?$/i.test(path.basename(editorPath)), 'Expected an explicit Unity Editor executable, not a shell or launcher');
    const projectVersionPath = fileInside(projectPath, path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'));
    const text = fs.readFileSync(projectVersionPath, 'utf8');
    const projectVersion = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(text)?.[1];
    requireValue(projectVersion === request.editorVersion, `ProjectVersion mismatch: ${projectVersion ?? 'missing'} != ${request.editorVersion}`);
    requireValue(fs.statSync(path.join(projectPath, 'Assets')).isDirectory(), 'Project Assets directory is required');
    const manifestPath = fileInside(projectPath, path.join(projectPath, 'Packages', 'manifest.json'));
    const manifest = readJson(manifestPath);
    const proof = await editorProof(request, editorPath);
    const lock = inspectProjectLock(projectPath);
    const unityLockEvidence = await inspectUnityLock(projectPath);
    const unityLock = unityLockEvidence.blocked;
    const checks = { projectVersion, projectVersionSha256: await sha256(projectVersionPath), packageManifestSha256: await sha256(manifestPath), editor: proof, writerLock: lock, unityLock, unityLockEvidence };
    let methodSourcePath;
    if (request.operation === 'test') {
        requireValue(['EditMode', 'PlayMode'].includes(request.testPlatform), 'testPlatform must be EditMode or PlayMode');
        requireValue(Number.isSafeInteger(request.expectedTestCount) && request.expectedTestCount > 0, 'expectedTestCount must be a positive exact test count');
        requireValue(typeof manifest.dependencies?.['com.unity.test-framework'] === 'string', 'Unity Test Framework is not declared in Packages/manifest.json');
    } else {
        requireValue(typeof request.executeMethod === 'string' && /^(?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*$/.test(request.executeMethod), 'An explicit static executeMethod is required');
        methodSourcePath = fileInside(projectPath, request.methodSourcePath);
        requireValue(/\.cs$/i.test(methodSourcePath) && methodSourcePath.split(path.sep).some(part => part.toLowerCase() === 'editor'), 'methodSourcePath must name a C# file in an Editor folder');
        requireValue(/^[a-f0-9]{64}$/i.test(request.methodSourceSha256 ?? '') && await sha256(methodSourcePath) === request.methodSourceSha256.toLowerCase(), 'Editor method source SHA-256 mismatch');
        checks.methodSourceSha256 = request.methodSourceSha256.toLowerCase();
    }
    if (request.operation === 'build') {
        requireValue(request.buildTarget === 'WebGL', 'This runtime currently supports WebGL build evidence only');
        requireValue(request.compressionFormat === undefined || ['Disabled', 'Gzip', 'Brotli'].includes(request.compressionFormat), 'compressionFormat must be Disabled, Gzip or Brotli');
        requireValue(request.developmentBuild === undefined || typeof request.developmentBuild === 'boolean', 'developmentBuild must be a boolean');
        requireValue(Array.isArray(request.scenes) && request.scenes.length > 0, 'Build requires explicit scenes');
        checks.scenes = [];
        for (const scene of request.scenes) {
            requireValue(typeof scene === 'string' && /^Assets\//.test(scene) && /\.unity$/.test(scene), 'Scenes must be project-relative Assets/*.unity paths');
            const source = fileInside(projectPath, path.resolve(projectPath, scene));
            checks.scenes.push({ path: scene, sha256: await sha256(source) });
        }
        const modulePath = path.join(path.dirname(editorPath), 'Data', 'PlaybackEngines', 'WebGLSupport');
        requireValue(fs.existsSync(modulePath), `WebGL support module not found: ${modulePath}`);
        checks.webglModule = canonicalPath(modulePath);
    }
    const source = await sourceFingerprint(projectPath);
    checks.source = { sha256: source.sha256, fileCount: source.fileCount };
    return { schemaVersion: 1, ok: !lock.locked && !unityLock, status: lock.locked || unityLock ? 'blocked' : 'preflight_passed', operation: request.operation, projectPath, editorPath, methodSourcePath, checks, readOnly: true, editorLaunched: false, connection: 'not_attempted', platformVerification: 'unverified' };
}

export function makeUnityArguments(request, job) {
    const args = ['-batchmode', '-projectPath', job.projectPath, '-logFile', job.logPath];
    if (request.noGraphics === true) args.push('-nographics');
    if (request.operation === 'test') {
        // Unity documents that -quit can terminate the run before tests finish.
        args.push('-runTests', '-testPlatform', request.testPlatform, '-testResults', job.testResultsPath);
    } else {
        if (request.operation === 'build') args.push('-buildTarget', 'WebGL');
        args.push('-executeMethod', request.executeMethod, '-harnessRequest', job.requestPath, '-quit');
    }
    return args;
}

export function parseUnityLog(text) {
    const lines = text.split(/\r?\n/);
    const recovered = new Map();
    // New client -> license update -> BOTH entitlement readback and initialization.
    // The latter notifications are asynchronous: either order is valid, but all
    // proof must precede engine initialization. Later runtime errors never recover here.
    const startupBoundary = lines.findIndex(line => /^Initialize engine version:\s/.test(line));
    const connection = lines.findIndex((line, index) => index < startupBoundary && /^\[Licensing::Module\] Successfully connected to LicensingClient on channel:/.test(line));
    const updated = lines.findIndex((line, index) => index > connection && index < startupBoundary && connection >= 0 && /^\[Licensing::Client\] Successfully updated license, isAsync: (?:True|False), time:/.test(line));
    const entitlement = lines.findIndex((line, index) => index > updated && index < startupBoundary && updated >= 0 && /^\[Licensing::Client\] Successfully resolved entitlement details\s*$/.test(line));
    const initialized = lines.findIndex((line, index) => index > updated && index < startupBoundary && updated >= 0 && /^\[Licensing::Module\] Licensing is initialized \(took [\d.]+s\)\.?\s*$/.test(line));
    const recoveryProof = initialized >= 0 && entitlement >= 0 ? { connectionLine: connection + 1, licenseUpdatedLine: updated + 1, entitlementResolvedLine: entitlement + 1, initializedLine: initialized + 1, startupBoundaryLine: startupBoundary + 1 } : null;
    if (recoveryProof) {
        for (let i = 0; i < updated; i++) {
            if (i < connection && /^\[Licensing::Client\] Error: HandshakeResponse reported an error:\s*$/.test(lines[i]) &&
                /^\s*ResponseCode: 505\s*$/.test(lines[i + 1] ?? '') &&
                /^\s*ResponseStatus: Unsupported protocol version '[\d.]+'\.\s*$/.test(lines[i + 2] ?? '')) {
                recovered.set(i, 'startup_client_protocol_mismatch');
                if (/^\[Licensing::Module\] Error: Failed to handshake to channel: "LicenseClient-[^"]+"\s*$/.test(lines[i + 3] ?? '')) recovered.set(i + 3, 'startup_client_handshake_replaced');
            }
            if (i > connection && i < updated && /^\[Licensing::Module\] Error: Access token is unavailable; failed to update\s*$/.test(lines[i])) recovered.set(i, 'startup_access_token_unavailable_then_license_updated');
        }
    }
    const errorPattern = /\berror CS\d+\b|Scripts have compiler errors|Compilation failed|Aborting batchmode due to failure|\b(?:[\w.]+)?Exception\s*:|Build completed with a result of ['"]Failed|Fatal error|Failed to (?:activate|update license)|No valid Unity Editor license|License is not active|(?:^|\]\s*|\s)(?:Error|Fatal)\s*:|\[(?:error|exception)\]|^Error\s+\S/i;
    const errors = lines.filter((line, index) => !recovered.has(index) && errorPattern.test(line));
    return { present: text.trim().length > 0, errors: errors.slice(0, 40), errorCount: errors.length, recoveredDiagnostics: [...recovered].map(([index, code]) => ({ line: index + 1, code })), licensingRecoveryProof: recovered.size ? recoveryProof : null };
}

export function appendUnityFailure(result, stage, reason, status = 'failed') {
    result.failures ??= [];
    if (result.failures.length === 0) result.status = status;
    result.ok = false;
    result.failures.push({ stage, reason: String(reason).slice(0, 1500) });
    result.reason = result.failures.map(failure => `${failure.stage}: ${failure.reason}`).join(' | ');
    return result;
}

async function artifact(file, root) {
    const verified = fileInside(root, file);
    const stat = fs.statSync(verified);
    requireValue(stat.size > 0, `Empty artifact: ${verified}`);
    return { path: verified, size: stat.size, sha256: await sha256(verified) };
}
async function webglArtifacts(directory) {
    const files = [];
    function walk(folder) {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const full = path.join(folder, entry.name);
            requireValue(!entry.isSymbolicLink(), `Symlink build output is not accepted: ${full}`);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) files.push(full);
        }
    }
    walk(directory);
    for (const [name, match] of [
        ['index.html', file => path.relative(directory, file) === 'index.html'],
        ['loader', file => /\.loader\.js$/.test(file)],
        ['framework', file => /\.framework\.js(?:\.gz|\.br|\.unityweb)?$/.test(file)],
        ['wasm', file => /\.wasm(?:\.gz|\.br|\.unityweb)?$/.test(file)],
        ['data', file => /\.data(?:\.gz|\.br|\.unityweb)?$/.test(file)]
    ]) requireValue(files.some(match), `WebGL artifact missing: ${name}`);
    const result = [];
    for (const file of files) result.push(await artifact(file, directory));
    return result;
}

/** Evidence evaluator: process success alone is never sufficient. */
export async function evaluateUnityResult(request, job, processResult) {
    const result = { schemaVersion: 1, jobId: job.jobId, operation: request.operation, ok: false, status: 'failed', editorLaunched: true, projectPath: job.projectPath, editorVersion: request.editorVersion, platformVerification: 'unverified', browserVerification: 'not_run', process: processResult, artifacts: [], failures: [] };
    if (processResult.jobId !== job.jobId || !processResult.processClosed || processResult.timedOut || processResult.exitCode !== 0) {
        appendUnityFailure(result, 'process', 'Process did not finish successfully; inspect process evidence before any retry', processResult.timedOut || !processResult.processClosed ? 'recovery_required' : 'failed');
    }
    try {
        result.log = parseUnityLog(fs.readFileSync(fileInside(job.directory, job.logPath), 'utf8'));
        requireValue(result.log.present && result.log.errorCount === 0, 'Editor log is empty or contains compiler/build/license failure evidence');
        result.artifacts.push(await artifact(job.logPath, job.directory));
    } catch (error) { appendUnityFailure(result, 'log', error.message); }
    if (result.failures.length) return result;
    try {
        if (request.operation === 'test') {
            fileInside(job.directory, job.testResultsPath);
            result.tests = parseUnityTestResults(fs.readFileSync(job.testResultsPath, 'utf8'), { expectedCount: request.expectedTestCount });
            requireValue(result.tests.ok === true && result.tests.total === request.expectedTestCount, `Test report must pass exactly ${request.expectedTestCount} tests`);
            result.artifacts.push(await artifact(job.testResultsPath, job.directory));
        } else {
            const readback = readJson(fileInside(job.directory, job.readbackPath));
            requireValue(readback.jobId === job.jobId && readback.operation === request.operation && readback.success === true && readback.editorVersion === request.editorVersion && canonicalPath(readback.projectPath) === job.projectPath, 'Readback identity/outcome mismatch');
            requireValue(fs.readFileSync(job.logPath, 'utf8').includes(`HARNESS_UNITY_COMPLETED:${job.jobId}:${request.operation}`), 'Missing job-specific completion marker in Editor log');
            result.readback = readback;
            result.artifacts.push(await artifact(job.readbackPath, job.directory));
            if (request.operation === 'build') {
                requireValue(readback.buildResult === 'Succeeded' && readback.buildTarget === 'WebGL' && readback.totalErrors === 0 && canonicalPath(readback.outputPath) === canonicalPath(job.outputPath), 'BuildReport must confirm a successful WebGL build at the job output path');
                result.artifacts.push(...await webglArtifacts(job.outputPath));
            }
        }
        result.ok = true; result.status = 'passed';
    } catch (error) {
        appendUnityFailure(result, 'operation_evidence', error.message);
    }
    return result;
}

export async function runUnity(request) {
    requireValue(request.action === 'run', 'Explicit action=run is required to launch Unity');
    requireValue(Number.isSafeInteger(request.timeoutMs) && request.timeoutMs >= 1000 && request.timeoutMs <= 86_400_000, 'An explicit timeoutMs from 1000 to 86400000 is required');
    const preflight = await preflightUnity(request);
    requireValue(preflight.ok, 'PROJECT_LOCKED: read-only preflight found a writer lock or active/uncertain Unity ownership');
    const jobId = crypto.randomUUID();
    const lock = acquireProjectLock(preflight.projectPath, jobId);
    const directory = path.join(lock.root, 'jobs', jobId);
    let launched = false;
    try {
        // Close the cooperative-lock race before launch; Unity's own lock handles outside editors.
        const unityLockBeforeLaunch = await inspectUnityLock(preflight.projectPath);
        requireValue(!unityLockBeforeLaunch.blocked, `Unity ownership is active or uncertain after acquiring writer ownership: ${unityLockBeforeLaunch.state}`);
        preflight.checks.unityLockBeforeLaunch = unityLockBeforeLaunch;
        const sourceBefore = await sourceFingerprint(preflight.projectPath);
        requireValue(sourceBefore.sha256 === preflight.checks.source.sha256, 'Source changed between preflight and acquiring project ownership');
        fs.mkdirSync(path.dirname(directory), { recursive: true });
        requireValue(canonicalPath(path.dirname(directory)) === path.dirname(directory), 'Job directory ancestor redirects');
        fs.mkdirSync(directory);
        const job = { jobId, directory, projectPath: preflight.projectPath, logPath: path.join(directory, 'Editor.log'), requestPath: path.join(directory, 'editor-request.json'), readbackPath: path.join(directory, 'readback.json'), testResultsPath: path.join(directory, 'results.xml'), outputPath: path.join(directory, 'build') };
        writeJson(path.join(directory, 'request.json'), request);
        writeJson(path.join(directory, 'preflight.json'), preflight);
        writeJson(path.join(directory, 'source-before.json'), sourceBefore);
        writeJson(job.requestPath, { schemaVersion: 1, jobId, operation: request.operation, projectPath: job.projectPath, editorVersion: request.editorVersion, readbackPath: job.readbackPath, outputPath: job.outputPath, buildTarget: request.buildTarget ?? '', scenes: request.scenes ?? [], compressionFormat: request.compressionFormat ?? '', developmentBuild: request.developmentBuild ?? false });
        const args = makeUnityArguments(request, job);
        launched = true; // a failure from here is potentially ambiguous; retain ownership by default
        const processResult = await runManagedJob({ jobId, jobDirectory: directory, executable: preflight.editorPath, args, cwd: job.projectPath, timeoutMs: request.timeoutMs });
        const result = await evaluateUnityResult(request, job, processResult);
        result.source = { before: { sha256: sourceBefore.sha256, fileCount: sourceBefore.fileCount }, after: null, unchanged: null };
        if (processResult.processClosed && !processResult.timedOut) {
            try {
                const sourceAfter = await sourceFingerprint(preflight.projectPath);
                writeJson(path.join(directory, 'source-after.json'), sourceAfter);
                result.source.after = { sha256: sourceAfter.sha256, fileCount: sourceAfter.fileCount };
                result.source.unchanged = sourceBefore.sha256 === sourceAfter.sha256;
                if (!result.source.unchanged) {
                    appendUnityFailure(result, 'source', 'Assets, Packages or ProjectSettings changed during Unity execution (including generated .meta). Inspect retained source manifests and explicitly establish a new baseline before rerunning.', 'source_changed');
                }
            } catch (error) {
                appendUnityFailure(result, 'source', error.message, 'source_unverified');
            }
        }
        result.jobDirectory = directory;
        result.preflight = preflight;
        result.lockRetained = processResult.timedOut || !processResult.processClosed;
        // Commit the receipt before lock release; recovery can finish this exact cleanup without replay.
        writeJson(path.join(directory, 'result.json'), result);
        if (!result.lockRetained) releaseProjectLock(lock);
        return result;
    } catch (error) {
        if (!launched) releaseProjectLock(lock);
        return { ok: false, status: launched ? 'recovery_required' : 'blocked', jobId, jobDirectory: directory, lockRetained: launched, reason: String(error.message), platformVerification: 'unverified' };
    }
}

export async function unityJobStatus(request) {
    const lock = inspectProjectLock(request.projectPath);
    const unityLockEvidence = await inspectUnityLock(lock.project);
    const unityLock = unityLockEvidence.blocked;
    const status = { ok: true, status: lock.locked ? 'locked' : unityLock ? 'external_editor_lock' : 'idle', lock, unityLock, unityLockEvidence, readOnly: true, replayAllowed: !lock.locked && !unityLock };
    if (!lock.locked || !lock.owner) return status;
    requireValue(/^[a-zA-Z0-9_-]{1,100}$/.test(lock.owner.jobId), 'Invalid job identity in lock');
    const directory = path.join(lock.root, 'jobs', lock.owner.jobId);
    try {
        status.process = readJson(fileInside(lock.root, path.join(directory, 'process.json')));
        status.currentProcess = await inspectProcess(status.process.pid);
        status.sameProcessIdentity = status.currentProcess.state === 'running' && status.process.identity?.birth && status.process.identity.birth === status.currentProcess.birth;
        if (fs.existsSync(path.join(directory, 'result.json'))) status.result = readJson(fileInside(lock.root, path.join(directory, 'result.json')));
    } catch (error) { status.reason = String(error.message); }
    status.nextSafeAction = 'Inspect durable process/log evidence; do not rerun, remove the lock, or kill a persisted PID blindly';
    return status;
}

export async function recoverUnity(request) {
    const status = await unityJobStatus(request);
    const { lock } = status;
    if (!lock.locked) return { ...status, readOnly: false, status: 'nothing_to_recover' };
    const processResult = status.process;
    const safelyCompleted = lock.owner?.jobId === request.jobId && processResult?.jobId === request.jobId && status.result?.jobId === request.jobId && processResult.processClosed === true && processResult.timedOut === false && ['exited', 'spawn_failed'].includes(processResult.state);
    // A timed-out/crashed child might have surviving compilers. An absent root PID alone is NOT proof.
    if (!safelyCompleted || (await inspectUnityLock(lock.project)).blocked) {
        return { ...status, ok: false, status: 'recovery_required', reason: 'No durable clean completion receipt. Ownership stays locked; manual process-tree investigation is required. This operation never kills or replays jobs.' };
    }
    releaseProjectLock({ ...lock, owner: lock.owner });
    return { ok: true, status: 'recovered_completed_job', jobId: request.jobId, replayed: false, priorResult: status.result };
}

export async function unityRunner(request) {
    switch (request?.action) {
        case 'preflight': return preflightUnity(request);
        case 'run': return runUnity(request);
        case 'status': return unityJobStatus(request);
        case 'recover': return recoverUnity(request);
        default: throw new Error('action must be preflight, run, status or recover');
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        requireValue(process.argv.length === 3 && path.isAbsolute(process.argv[2]), 'Usage: node Scripts/unityRunner.mjs <absolute-request.json>');
        const result = await unityRunner(readJson(process.argv[2]));
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
        console.error(JSON.stringify({ ok: false, status: 'blocked', reason: String(error.message) }));
        process.exitCode = 2;
    }
}
