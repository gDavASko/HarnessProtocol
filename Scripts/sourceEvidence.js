import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findRepoRoot } from './harnessPaths.js';

const execFileAsync = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replace(/\\/g, '/');
const ignoredDirectories = new Set(['.git', '.harness', '.harness_tmp', '.harness_logs', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Obj', 'UserSettings']);
const ignoredFiles = new Set(['evidence_receipts.json', 'validation_report.md', 'session_log.jsonl', 'dash.html', 'dash_report.json', 'STRESS_TEST_REPORT.json']);
function ignored(rel) {
    const parts = slash(rel).split('/');
    return parts.some(part => ignoredDirectories.has(part)) || parts.slice(0, 2).join('/') === 'memory/tactical'
        || ignoredFiles.has(parts.at(-1)) || parts.at(-1).startsWith('.harness_');
}

export async function resolveDeliverable(taskDir, item) {
    const rel = typeof item === 'string' ? item : item?.path;
    if (!rel) return null;
    const candidates = path.isAbsolute(rel) ? [rel] : [path.resolve(taskDir, rel), path.resolve(taskDir, 'workspace', rel), path.resolve(findRepoRoot(taskDir), rel)];
    for (const candidate of candidates) {
        try { await fs.lstat(candidate); return candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return candidates[0];
}

// Hash source bytes, including untracked files. Runtime output is kept outside the
// source scope; explicitly declared deliverables are hashed even when gitignored.
export async function captureSourceEvidence(taskDir, target = {}) {
    const scopePath = path.join(taskDir, 'evidence-scope.json');
    let scope;
    try {
        scope = JSON.parse((await fs.readFile(scopePath, 'utf8')).replace(/^\uFEFF/, ''));
        if (scope.schema_version !== 1 || !Array.isArray(scope.source_roots) || !scope.source_roots.length
            || scope.source_roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('Invalid evidence-scope.json: absolute source_roots required');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        scope = { schema_version: 1, source_roots: [findRepoRoot(taskDir)] };
    }
    const files = new Map();
    let bytes = 0;
    const directory = async dir => {
        const real = await fs.realpath(dir);
        const stat = await fs.stat(real, { bigint: true });
        files.set(real, { directory: true, mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), inode: String(stat.ino) });
    };
    const inspect = async (file, missingAllowed = false) => {
        let stat;
        try { stat = await fs.lstat(file); } catch (error) {
            if (error.code === 'ENOENT' && missingAllowed) { files.set(path.resolve(file), 'MISSING'); return; }
            throw error;
        }
        if (stat.isSymbolicLink()) throw new Error(`Evidence scope contains a symbolic link: ${file}`);
        if (stat.isDirectory()) { await walk(file, file); return; }
        if (!stat.isFile()) throw new Error(`Unsupported evidence file: ${file}`);
        await directory(path.dirname(file));
        const real = await fs.realpath(file);
        const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
        if (normalize(real) !== normalize(file)) throw new Error(`Evidence path redirects: ${file}`);
        if (files.has(real)) return;
        bytes += stat.size;
        if (files.size >= 50000 || bytes > 2 * 1024 * 1024 * 1024) throw new Error('Evidence scope exceeds limits; narrow source_roots');
        const before = await fs.stat(real, { bigint: true });
        const content = hash(await fs.readFile(real));
        const after = await fs.stat(real, { bigint: true });
        if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size || before.ino !== after.ino) throw new Error(`Source changed while fingerprinting: ${file}`);
        // Rewriting and restoring the same bytes still requires a fresh check.
        files.set(real, { content, mtime: String(after.mtimeNs), ctime: String(after.ctimeNs), inode: String(after.ino) });
    };
    const walk = async (dir, base, explicit = false) => {
        const stat = await fs.lstat(dir);
        if (stat.isSymbolicLink()) throw new Error(`Evidence scope contains a symbolic link: ${dir}`);
        if (stat.isFile()) return inspect(dir);
        if (!stat.isDirectory()) throw new Error(`Unsupported evidence path: ${dir}`);
        await directory(dir);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (!explicit && ignored(path.relative(base, file))) continue;
            if (entry.isDirectory()) await walk(file, base, explicit);
            else await inspect(file);
        }
    };
    for (const root of scope.source_roots) {
        const stat = await fs.lstat(root);
        if (stat.isSymbolicLink()) throw new Error(`Evidence root is a symbolic link: ${root}`);
        if (stat.isFile()) { await inspect(root); continue; }
        await directory(root);
        let gitRoot = false;
        try { await fs.lstat(path.join(root, '.git')); gitRoot = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!gitRoot) { await walk(root, root); continue; }
        const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        for (const rel of stdout.split('\0').filter(Boolean).sort()) {
            if (!ignored(rel)) await inspect(path.resolve(root, rel), true);
        }
    }
    const workspace = path.join(taskDir, 'workspace');
    try { await walk(workspace, workspace); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const nodes = target.nodes || [target];
    for (const node of nodes) {
        for (const item of node.deliverables || []) {
            const file = await resolveDeliverable(taskDir, item);
            if (!file) continue;
            try { await walk(file, file, true); } catch (error) {
                if (error.code === 'ENOENT') files.set(path.resolve(file), 'MISSING'); else throw error;
            }
        }
    }
    const manifest = [...files].sort(([a], [b]) => a.localeCompare(b));
    return { schema_version: 1, scope, file_count: manifest.length, digest: hash(JSON.stringify({ scope, files: manifest })) };
}

export function sameSourceEvidence(a, b) {
    return !!a && !!b && a.schema_version === 1 && b.schema_version === 1 && a.digest === b.digest;
}
