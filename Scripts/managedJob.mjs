import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const canonicalPath = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('An absolute path is required');
    const resolved = fs.realpathSync.native(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
export function writeJson(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
}
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// Fixed within the canonical project, so independent runner processes and checkouts agree.
export function projectRuntime(projectPath) {
    const project = canonicalPath(projectPath);
    const root = path.join(project, '.harness', 'unity-runtime');
    // Refuse symlink/junction escape in existing ancestors, even during read-only calls.
    for (const candidate of [path.join(project, '.harness'), root]) {
        if (fs.existsSync(candidate) && canonicalPath(candidate) !== candidate) throw new Error(`Runtime path redirects outside its expected location: ${candidate}`);
    }
    return { project, root, lockPath: path.join(root, 'writer.lock') };
}
export function inspectProjectLock(projectPath) {
    const locations = projectRuntime(projectPath);
    if (!fs.existsSync(locations.lockPath)) return { ...locations, locked: false };
    if (canonicalPath(locations.lockPath) !== locations.lockPath) throw new Error('Writer lock redirects; refusing to inspect or release it');
    try { return { ...locations, locked: true, owner: readJson(path.join(locations.lockPath, 'owner.json')) }; }
    catch { return { ...locations, locked: true, owner: null, reason: 'Lock owner is missing or unreadable; do not steal it' }; }
}
export function acquireProjectLock(projectPath, jobId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) throw new Error('Invalid job ID');
    const locations = projectRuntime(projectPath);
    fs.mkdirSync(locations.root, { recursive: true });
    try { fs.mkdirSync(locations.lockPath); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error('PROJECT_LOCKED: inspect the existing job; no automatic replay or stale-lock stealing');
        throw error;
    }
    const owner = { jobId, token: crypto.randomUUID(), projectPath: locations.project, runnerPid: process.pid, acquiredAt: new Date().toISOString() };
    writeJson(path.join(locations.lockPath, 'owner.json'), owner);
    return { ...locations, owner };
}
export function releaseProjectLock(lock) {
    const observed = inspectProjectLock(lock.project);
    if (!observed.locked || observed.owner?.token !== lock.owner.token || observed.owner?.jobId !== lock.owner.jobId) throw new Error('Lock ownership changed; refusing release');
    // Only these two known paths, never recursive deletion.
    fs.unlinkSync(path.join(lock.lockPath, 'owner.json'));
    fs.rmdirSync(lock.lockPath);
}

// Birth identity is diagnostic evidence, not authority to kill a PID found in an old file.
export async function inspectProcess(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown', reason: 'Missing process identity' };
    try {
        if (process.platform === 'linux') {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return { state: fields[0] === 'Z' ? 'exited' : 'running', pid, birth: fields[19], executable: fs.readlinkSync(`/proc/${pid}/exe`) };
        }
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
                '$ErrorActionPreference="Stop"; $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:HARNESS_INSPECT_PID); if($null -eq $p){"null"}else{@{pid=[int]$p.ProcessId;birth=$p.CreationDate.ToUniversalTime().ToString("o");executable=$p.ExecutablePath}|ConvertTo-Json -Compress}'],
                { env: { ...process.env, HARNESS_INSPECT_PID: String(pid) }, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
            const observed = JSON.parse(stdout.trim());
            return observed ? { state: 'running', ...observed } : { state: 'exited', pid };
        }
        process.kill(pid, 0);
        return { state: 'unknown', pid, reason: 'PID exists; birth identity unsupported on this OS' };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return { state: 'exited', pid };
        return { state: 'unknown', pid, reason: String(error.message).slice(0, 300) };
    }
}

/** Run one owned child without a shell. Timeout always requires recovery, even after kill. */
export async function runManagedJob({ jobId, jobDirectory, executable, args, cwd, timeoutMs, killGraceMs = 3000 }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error('Invalid timeoutMs');
    if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 30_000) throw new Error('Invalid killGraceMs');
    if (!path.isAbsolute(executable) || !path.isAbsolute(jobDirectory) || !path.isAbsolute(cwd)) throw new Error('Managed job paths must be absolute');
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Arguments must be a string array');
    const statePath = path.join(jobDirectory, 'process.json');
    const state = { schemaVersion: 1, jobId, executable, args, cwd, runnerPid: process.pid, startedAt: new Date().toISOString(), state: 'starting', pid: null, timeoutMs, processClosed: false, timedOut: false };
    writeJson(statePath, state); // crash before PID persistence remains explicitly ambiguous
    const stdout = fs.openSync(path.join(jobDirectory, 'stdout.log'), 'wx');
    const stderr = fs.openSync(path.join(jobDirectory, 'stderr.log'), 'wx');
    let child;
    try {
        child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', stdout, stderr] });
    } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    state.pid = child.pid ?? null;
    state.state = state.pid ? 'running' : 'starting';
    writeJson(statePath, state);
    return await new Promise(resolve => {
        let settled = false;
        let hardDeadline;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline); clearTimeout(hardDeadline);
            state.finishedAt = new Date().toISOString();
            writeJson(statePath, state);
            if (!state.processClosed) child.unref();
            resolve({ ...state });
        };
        child.once('error', error => {
            state.error = String(error.message).slice(0, 500);
            state.state = state.pid ? 'recovery_required' : 'spawn_failed';
            state.processClosed = !state.pid;
            finish();
        });
        child.once('close', (code, signal) => {
            if (settled) return;
            state.exitCode = code; state.signal = signal; state.processClosed = true;
            state.state = state.timedOut ? 'recovery_required' : 'exited';
            finish();
        });
        const deadline = setTimeout(() => {
            state.timedOut = true;
            state.state = 'recovery_required';
            state.termination = 'Requested for this owned live child only; descendant shutdown is not certified';
            writeJson(statePath, state);
            hardDeadline = setTimeout(finish, killGraceMs);
            // Never signal an old persisted PID. This handle belongs to this invocation.
            if (child.exitCode === null && child.signalCode === null) {
                if (process.platform === 'win32') child.kill('SIGKILL');
                else {
                    try { process.kill(-child.pid, 'SIGKILL'); }
                    catch { child.kill('SIGKILL'); }
                }
            }
        }, timeoutMs);
        // Inspection does not delay timeout or completion, and cannot overwrite a terminal receipt.
        if (state.pid) inspectProcess(state.pid).then(identity => {
            if (!settled) { state.identity = identity; writeJson(statePath, state); }
        });
    });
}
