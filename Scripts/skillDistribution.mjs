import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(projectRoot, '.harness');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const fail = message => { throw new Error(message); };

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an explicit absolute path`);
  return path.resolve(value);
}

function inside(child, parent) {
  const relative = path.relative(key(parent), key(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function disjoint(a, b) {
  if (inside(a, b) || inside(b, a)) fail(`Overlapping paths are forbidden: ${a} / ${b}`);
}

function optionalStat(value) {
  try { return fs.lstatSync(value); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Inspect every existing ancestor, not just the final path: a safe-looking file
// can otherwise escape through a junction or symlink in one of its parents.
function safePath(value) {
  const resolved = absolute(value, 'Path');
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = optionalStat(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) fail(`Symlink/junction is forbidden: ${current}`);
    if (key(path.resolve(fs.realpathSync.native(current))) !== key(current)) {
      fail(`Reparse/alias path is forbidden: ${current}`);
    }
    if (!stat.isDirectory() && current !== resolved) fail(`Non-directory ancestor: ${current}`);
  }
  return resolved;
}

function relativeFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes(':') || value.includes('\0')) {
    fail(`Unsafe relative file path: ${JSON.stringify(value)}`);
  }
  if (value.split('/').some(part => part === '' || part === '.' || part === '..' || /[. ]$/.test(part))) {
    fail(`Unsafe relative file path: ${JSON.stringify(value)}`);
  }
  return value;
}

function regularBytes(file) {
  safePath(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink > 1) fail(`Expected a regular file without hardlinks: ${file}`);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    fail(`File changed during read: ${file}`);
  }
  return bytes;
}

export function snapshot(rootValue) {
  const root = safePath(rootValue);
  const stat = optionalStat(root);
  if (!stat) return { exists: false, directories: [], files: [] };
  if (!stat.isDirectory()) fail(`Expected directory: ${root}`);
  const files = [];
  const directories = [];
  function visit(directory, prefix) {
    safePath(directory);
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = relativeFile(prefix ? `${prefix}/${name}` : name);
      const full = path.join(root, ...relative.split('/'));
      safePath(full);
      const entry = fs.lstatSync(full);
      if (entry.isDirectory()) {
        directories.push(relative);
        visit(full, relative);
      } else if (entry.isFile()) {
        const bytes = regularBytes(full);
        files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
      } else fail(`Unsupported filesystem entry: ${full}`);
    }
  }
  visit(root, '');
  return { exists: true, directories: directories.sort(), files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

function requiredReading(root, source) {
  if (!source.files.some(file => file.path === 'SKILL.md')) fail('Canonical source must contain SKILL.md');
  const available = new Set(source.files.map(file => file.path));
  const references = [];
  for (const file of source.files.filter(file => path.posix.basename(file.path) === 'SKILL.md')) {
    const bytes = regularBytes(path.join(root, ...file.path.split('/')));
    if (sha256(bytes) !== file.sha256) fail(`Source drift while validating required_reading: ${file.path}`);
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!frontmatter) fail(`Missing YAML frontmatter: ${file.path}`);
    const lines = frontmatter[1].split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*["']?required_reading["']?\s*:/.test(lines[i]) && !/^required_reading\s*:/.test(lines[i])) {
        fail(`Unsupported required_reading key syntax: ${file.path}`);
      }
      if (!/^required_reading\s*:/.test(lines[i])) continue;
      if (found) fail(`Duplicate required_reading: ${file.path}`);
      found = true;
      const inline = lines[i].replace(/^required_reading\s*:/, '').trim();
      if (inline === '[]') continue;
      if (inline !== '' && !inline.startsWith('#')) fail(`Use a block list for required_reading: ${file.path}`);
      let count = 0;
      while (++i < lines.length) {
        const line = lines[i];
        if (/^\s*(?:#.*)?$/.test(line)) continue;
        if (/^[^\s-]/.test(line)) { i--; break; }
        const match = line.match(/^\s+-\s+(.+?)\s*$/);
        if (!match) fail(`Unsupported required_reading syntax: ${file.path}`);
        let reference = match[1];
        if (reference.startsWith('"')) {
          try { reference = JSON.parse(reference); } catch { fail(`Invalid quoted reference: ${file.path}`); }
        } else if (reference.startsWith("'")) {
          if (!/^'[^']*'$/.test(reference)) fail(`Invalid quoted reference: ${file.path}`);
          reference = reference.slice(1, -1);
        } else {
          reference = reference.replace(/\s+#.*$/, '');
        }
        relativeFile(reference);
        const resolved = path.posix.join(path.posix.dirname(file.path), reference);
        if (!available.has(resolved)) fail(`Missing required_reading target: ${file.path} -> ${reference}`);
        references.push({ skill: file.path, path: resolved });
        count++;
      }
      if (count === 0) fail(`Empty required_reading block: ${file.path}; use [] if intentional`);
    }
  }
  return references;
}

function difference(source, destination) {
  const canonical = new Map(source.files.map(file => [file.path, file]));
  const existing = new Map(destination.files.map(file => [file.path, file]));
  return {
    added: source.files.filter(file => !existing.has(file.path)).map(file => file.path),
    changed: source.files.filter(file => existing.has(file.path) && existing.get(file.path).sha256 !== file.sha256).map(file => file.path),
    extra: destination.files.filter(file => !canonical.has(file.path)).map(file => file.path),
    conflicts: source.files.filter(file => destination.directories.includes(file.path)).map(file => file.path),
  };
}

export function checkTrees(sourceValue, destinationValues) {
  const sourceRoot = safePath(absolute(sourceValue, 'Source'));
  if (!Array.isArray(destinationValues) || destinationValues.length === 0) fail('At least one explicit destination is required');
  const roots = destinationValues.map(value => safePath(absolute(value, 'Destination')));
  const all = [sourceRoot, ...roots];
  all.forEach((a, index) => all.slice(index + 1).forEach(b => disjoint(a, b)));
  const source = snapshot(sourceRoot);
  if (!source.exists) fail(`Canonical source does not exist: ${sourceRoot}`);
  const references = requiredReading(sourceRoot, source);
  const destinations = roots.map(root => {
    const state = snapshot(root);
    const changes = difference(source, state);
    return { root, snapshot: state, changes, exactMatch: state.exists && Object.values(changes).every(items => items.length === 0) };
  });
  return { source: { root: sourceRoot, snapshot: source }, requiredReading: references, destinations,
    exactMatch: destinations.every(destination => destination.exactMatch) };
}

function taskDirectory(value, roots) {
  const directory = safePath(absolute(value, 'Task directory'));
  if (!inside(directory, scratchRoot) || key(directory) === key(scratchRoot)) fail(`Task directory must be below ${scratchRoot}`);
  roots.forEach(root => disjoint(directory, root));
  return directory;
}

function artifactPath(value, directory) {
  const file = safePath(absolute(value, 'Artifact'));
  if (!inside(file, directory) || key(file) === key(directory)) fail('Artifact must be inside the task directory');
  return file;
}

export function createPlan({ source, destinations, taskDir, out }) {
  const report = checkTrees(source, destinations);
  const directory = taskDirectory(taskDir, [report.source.root, ...report.destinations.map(item => item.root)]);
  const planPath = artifactPath(out, directory);
  const plan = { version: 1, taskDir: directory, ...report };
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  safePath(planPath);
  const bytes = json(plan);
  fs.writeFileSync(planPath, bytes, { flag: 'wx' });
  return { planPath, planSha256: sha256(bytes), plan };
}

function assertSnapshots(plan) {
  const current = checkTrees(plan.source.root, plan.destinations.map(item => item.root));
  if (!same(current.source.snapshot, plan.source.snapshot)) fail('Source drift since plan; create and review a new plan');
  for (let i = 0; i < current.destinations.length; i++) {
    if (!same(current.destinations[i].snapshot, plan.destinations[i].snapshot)) fail(`Destination drift since plan: ${current.destinations[i].root}`);
  }
  if (!same(current.requiredReading, plan.requiredReading) || !same(current.destinations, plan.destinations) || current.exactMatch !== plan.exactMatch) {
    fail('Plan manifest/operations do not match the current trees');
  }
  return current;
}

export function applyPlan({ planPath: planValue, planSha256 }) {
  const planPath = safePath(absolute(planValue, 'Plan'));
  if (!/^[a-f0-9]{64}$/.test(planSha256 ?? '')) fail('Supply the reviewed --plan-sha256 digest');
  const bytes = regularBytes(planPath);
  if (sha256(bytes) !== planSha256) fail('Plan digest mismatch; review the actual plan before applying');
  const plan = JSON.parse(bytes.toString('utf8'));
  if (plan.version !== 1 || !plan.source || !Array.isArray(plan.destinations)) fail('Unsupported plan format');
  const directory = taskDirectory(plan.taskDir, [plan.source.root, ...plan.destinations.map(item => item.root)]);
  artifactPath(planPath, directory);
  assertSnapshots(plan);
  for (const destination of plan.destinations) {
    if (destination.changes.extra.length || destination.changes.conflicts.length) {
      fail(`Extra files or file/directory conflicts block apply: ${destination.root}. Review a separate exact-path cleanup; this tool never deletes destination files.`);
    }
  }
  const sourceFiles = new Map(plan.source.snapshot.files.map(file => [file.path, file]));
  const operations = [];
  for (let index = 0; index < plan.destinations.length; index++) {
    const destination = plan.destinations[index];
    const previous = new Map(destination.snapshot.files.map(file => [file.path, file]));
    for (const relative of [...destination.changes.added, ...destination.changes.changed].sort()) {
      operations.push({ destination: destination.root, path: relative, beforeSha256: previous.get(relative)?.sha256 ?? null,
        afterSha256: sourceFiles.get(relative).sha256, backup: previous.has(relative) ? `files/${index}/${relative}` : null });
    }
  }
  if (operations.length === 0) return { status: 'already-matching', exactMatch: true, operations: 0 };
  const runDir = path.join(directory, `skill-distribution-${crypto.randomUUID()}`);
  safePath(runDir);
  fs.mkdirSync(runDir, { recursive: false });
  fs.writeFileSync(path.join(runDir, 'reviewed-plan.json'), bytes, { flag: 'wx' });
  const journalPath = path.join(runDir, 'recovery.json');
  const journal = { version: 1, planSha256, planPath, status: 'backing-up', operations, completed: [], pending: null };
  const writeJournal = () => {
    safePath(journalPath);
    fs.writeFileSync(journalPath, json(journal));
  };
  writeJournal();
  try {
    // Finish and verify every backup before modifying any destination.
    for (const operation of operations) {
      if (!operation.backup) continue;
      const original = regularBytes(path.join(operation.destination, ...operation.path.split('/')));
      if (sha256(original) !== operation.beforeSha256) fail(`Destination drift during backup: ${operation.path}`);
      const backup = path.join(runDir, ...operation.backup.split('/'));
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      safePath(backup);
      fs.writeFileSync(backup, original, { flag: 'wx' });
      if (sha256(regularBytes(backup)) !== operation.beforeSha256) fail(`Backup verification failed: ${backup}`);
    }
    assertSnapshots(plan);
    journal.status = 'applying';
    writeJournal();
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      const sourceFile = path.join(plan.source.root, ...operation.path.split('/'));
      const content = regularBytes(sourceFile);
      if (sha256(content) !== operation.afterSha256) fail(`Source drift during apply: ${operation.path}`);
      const destinationFile = safePath(path.join(operation.destination, ...operation.path.split('/')));
      const current = optionalStat(destinationFile);
      if (operation.beforeSha256 === null ? current !== null : current === null || sha256(regularBytes(destinationFile)) !== operation.beforeSha256) {
        fail(`Destination drift during apply: ${destinationFile}`);
      }
      journal.pending = index;
      writeJournal();
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
      safePath(destinationFile);
      fs.writeFileSync(destinationFile, content, { flag: operation.beforeSha256 === null ? 'wx' : 'w' });
      if (sha256(regularBytes(destinationFile)) !== operation.afterSha256) fail(`Copy verification failed: ${destinationFile}`);
      journal.completed.push(index);
      journal.pending = null;
      writeJournal();
    }
    const result = checkTrees(plan.source.root, plan.destinations.map(item => item.root));
    if (!same(result.source.snapshot, plan.source.snapshot) || !result.exactMatch) fail('Post-copy verification failed; use recovery journal');
    journal.status = 'complete';
    writeJournal();
    return { status: 'applied', exactMatch: true, operations: operations.length, journalPath,
      journalSha256: sha256(regularBytes(journalPath)), planSha256 };
  } catch (error) {
    journal.status = 'interrupted';
    try { writeJournal(); } catch { /* Existing journal and backups remain the recovery source. */ }
    throw new Error(`${error.message}. Recovery journal: ${journalPath}`, { cause: error });
  }
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = { destinations: [] };
  const keys = { '--source': 'source', '--task-dir': 'taskDir', '--out': 'out', '--plan': 'planPath', '--plan-sha256': 'planSha256' };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${flag}`);
    if (flag === '--destination') options.destinations.push(value);
    else if (keys[flag] && options[keys[flag]] === undefined) options[keys[flag]] = value;
    else fail(`Unknown or duplicate argument: ${flag}`);
  }
  const allowed = command === 'apply' ? ['destinations', 'planPath', 'planSha256']
    : command === 'plan' ? ['destinations', 'source', 'taskDir', 'out'] : ['destinations', 'source'];
  if (Object.keys(options).some(option => !allowed.includes(option)) || (command === 'apply' && options.destinations.length)) fail(`Unexpected argument for ${command}`);
  return { command, options };
}

const help = `Full-tree skill distribution (offline; no destination deletions).
check --source ABS --destination ABS [--destination ABS ...]
plan  --source ABS --destination ABS [--destination ABS ...] --task-dir ABS --out ABS
apply --plan ABS --plan-sha256 SHA256

Run with node Scripts/skillDistribution.mjs <command> <arguments>.
The task directory must be under ${scratchRoot}; the plan must be inside it.
Review the plan's complete file manifests and added/changed/extra paths before apply.
Check: exit 0 = identical regular-file trees; 1 = divergence; 2 = unsafe/invalid input.
Plan: exit 0 = artifact created, even if extras will block apply; 2 = error.
Apply: exit 0 = exact copy verified; 2 = refusal/failure (retain recovery artifacts).
Recovery and security limits: docs/skill-distribution.md.
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 2 || process.argv.includes('--help')) process.stdout.write(help);
    else {
      const { command, options } = parseArgs(process.argv.slice(2));
      let result;
      if (command === 'check') {
        result = checkTrees(options.source, options.destinations);
        process.exitCode = result.exactMatch ? 0 : 1;
      } else if (command === 'plan') result = createPlan(options);
      else if (command === 'apply') result = applyPlan(options);
      else fail(`Unknown command: ${command}`);
      process.stdout.write(json(result));
    }
  } catch (error) {
    process.stderr.write(json({ error: error.message }));
    process.exitCode = 2;
  }
}
