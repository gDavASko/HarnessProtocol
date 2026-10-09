import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan, checkTrees, createPlan, snapshot } from './skillDistribution.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskRoot = path.join(projectRoot, '.harness', 'studio-hardening-20260831');
const fixtureRoot = path.join(taskRoot, `skill-distribution-tests-${crypto.randomUUID()}`);
const cli = path.join(projectRoot, 'Scripts', 'skillDistribution.mjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const skill = '---\nname: fixture\nrequired_reading:\n  - references/required.md\n---\n# Test fixture\n';
let cases = 0;

function write(root, relative, text) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const root = path.join(fixtureRoot, String(++cases));
  const source = path.join(root, 'canonical');
  const destination = path.join(root, 'installed');
  const taskDir = path.join(root, 'receipts');
  write(source, 'SKILL.md', skill);
  write(source, 'references/required.md', 'Canonical instructions\n');
  write(source, 'references/nested/example.json', '{"fixture":true}\n');
  write(source, '.hidden-fixture', 'Included in the manifest\n');
  return { root, source, destination, taskDir, destinations: [destination], out: path.join(taskDir, 'plan.json') };
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: projectRoot });
}

const tests = [
  ['full manifest includes nested and hidden files; CLI divergence is nonzero', () => {
    const f = fixture();
    const result = run(['check', '--source', f.source, '--destination', f.destination]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.source.snapshot.files.length, 4);
    assert.equal(report.requiredReading[0].path, 'references/required.md');
    assert.deepEqual(report.destinations[0].changes.added, ['.hidden-fixture', 'SKILL.md', 'references/nested/example.json', 'references/required.md']);
    for (const entry of report.source.snapshot.files) {
      assert.equal(entry.sha256, hash(fs.readFileSync(path.join(f.source, entry.path))));
    }
  }],
  ['changed, added and extra files are distinguished; extras block all writes', () => {
    const f = fixture();
    write(f.destination, 'SKILL.md', 'Old skill');
    write(f.destination, 'extra.txt', 'Keep this file');
    const plan = createPlan(f);
    assert.deepEqual(plan.plan.destinations[0].changes.changed, ['SKILL.md']);
    assert.deepEqual(plan.plan.destinations[0].changes.extra, ['extra.txt']);
    const before = snapshot(f.destination);
    assert.throws(() => applyPlan(plan), /Extra files/);
    assert.deepEqual(snapshot(f.destination), before);
    assert.deepEqual(fs.readdirSync(f.taskDir), ['plan.json']);
  }],
  ['source content drift after planning is rejected before writes', () => {
    const f = fixture();
    const plan = createPlan(f);
    write(f.source, 'references/required.md', 'Edited after review');
    assert.throws(() => applyPlan(plan), /Source drift/);
    assert.equal(fs.existsSync(f.destination), false);
  }],
  ['new unplanned source file is rejected', () => {
    const f = fixture();
    const plan = createPlan(f);
    write(f.source, 'new-file.md', 'Unreviewed');
    assert.throws(() => applyPlan(plan), /Source drift/);
    assert.equal(fs.existsSync(f.destination), false);
  }],
  ['destination content drift after planning is rejected', () => {
    const f = fixture();
    write(f.destination, 'SKILL.md', 'Previous copy');
    const plan = createPlan(f);
    write(f.destination, 'SKILL.md', 'Other writer owns this change');
    assert.throws(() => applyPlan(plan), /Destination drift/);
    assert.equal(fs.readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8'), 'Other writer owns this change');
  }],
  ['empty directory drift is rejected even though certification compares files', () => {
    const f = fixture();
    const plan = createPlan(f);
    fs.mkdirSync(path.join(f.destination, 'new-empty'), { recursive: true });
    assert.throws(() => applyPlan(plan), /Destination drift/);
  }],
  ['missing mandatory references block both check and plan', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.source, 'references', 'required.md'));
    assert.throws(() => checkTrees(f.source, f.destinations), /Missing required_reading/);
    assert.throws(() => createPlan(f), /Missing required_reading/);
    assert.equal(fs.existsSync(f.out), false);
  }],
  ['unsupported or escaping required_reading syntax fails closed', () => {
    const f = fixture();
    for (const entry of ['  - ../outside.md', '  - /outside.md', '  - references/required.md\n    nested: bad']) {
      write(f.source, 'SKILL.md', `---\nrequired_reading:\n${entry}\n---\n`);
      assert.throws(() => checkTrees(f.source, f.destinations), /Unsafe relative|Unsupported required_reading/);
    }
    write(f.source, 'SKILL.md', '---\nrequired_reading: [references/required.md]\n---\n');
    assert.throws(() => checkTrees(f.source, f.destinations), /block list/);
    write(f.source, 'SKILL.md', '---\n"required_reading":\n  - references/missing.md\n---\n');
    assert.throws(() => checkTrees(f.source, f.destinations), /Unsupported required_reading key/);
  }],
  ['quoted mandatory references and CRLF are supported', () => {
    const f = fixture();
    write(f.source, 'SKILL.md', '---\r\nrequired_reading:\r\n  - "references/required.md"\r\n  - \'references/nested/example.json\'\r\n---\r\n');
    assert.equal(checkTrees(f.source, f.destinations).requiredReading.length, 2);
  }],
  ['relative, overlapping and duplicate roots are rejected', () => {
    const f = fixture();
    assert.throws(() => checkTrees('relative/source', f.destinations), /absolute/);
    for (const roots of [[f.source], [path.join(f.source, 'copy')], [f.root], [f.destination, f.destination]]) {
      assert.throws(() => checkTrees(f.source, roots), /Overlapping paths/);
    }
  }],
  ['artifacts must be task-local and separate from the trees', () => {
    const f = fixture();
    assert.throws(() => createPlan({ ...f, taskDir: path.join(projectRoot, 'outside-task') }), /Task directory must/);
    assert.throws(() => createPlan({ ...f, out: path.join(f.root, 'outside-plan.json') }), /inside the task/);
    assert.throws(() => createPlan({ ...f, taskDir: path.join(f.source, 'receipts') }), /Overlapping paths/);
  }],
  ['junction/symlink in a scanned tree and in a root ancestor are rejected', () => {
    const f = fixture();
    const outside = path.join(f.root, 'outside');
    write(outside, 'keep.txt', 'Outside owned trees');
    fs.symlinkSync(outside, path.join(f.source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => checkTrees(f.source, f.destinations), /Symlink|junction|Reparse/);
    const clean = fixture();
    const alias = path.join(clean.root, 'alias');
    fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => checkTrees(clean.source, [path.join(alias, 'new-copy')]), /Symlink|junction|Reparse/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'Outside owned trees');
  }],
  ['hardlinked files are rejected before a shared inode could be overwritten', () => {
    const f = fixture();
    write(f.destination, 'SKILL.md', 'External original');
    fs.linkSync(path.join(f.destination, 'SKILL.md'), path.join(f.root, 'linked-original'));
    assert.throws(() => checkTrees(f.source, f.destinations), /hardlinks/);
    assert.equal(fs.readFileSync(path.join(f.root, 'linked-original'), 'utf8'), 'External original');
  }],
  ['plan digest and derived operation list are checked', () => {
    const f = fixture();
    const plan = createPlan(f);
    assert.throws(() => applyPlan({ planPath: plan.planPath }), /reviewed --plan-sha256/);
    const edited = JSON.parse(fs.readFileSync(plan.planPath));
    edited.destinations[0].changes.added.push('unreviewed.txt');
    fs.writeFileSync(plan.planPath, JSON.stringify(edited));
    assert.throws(() => applyPlan(plan), /digest mismatch/);
    assert.throws(() => applyPlan({ ...plan, planSha256: hash(fs.readFileSync(plan.planPath)) }), /manifest\/operations/);
    assert.equal(fs.existsSync(f.destination), false);
  }],
  ['existing directory at canonical file path blocks apply without deleting it', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.destination, 'SKILL.md'), { recursive: true });
    const plan = createPlan(f);
    assert.deepEqual(plan.plan.destinations[0].changes.conflicts, ['SKILL.md']);
    assert.throws(() => applyPlan(plan), /conflicts block apply/);
    assert.equal(fs.statSync(path.join(f.destination, 'SKILL.md')).isDirectory(), true);
  }],
  ['two destinations apply exactly; backups support explicit file-level recovery', () => {
    const f = fixture();
    const second = path.join(f.root, 'distribution');
    write(f.destination, 'SKILL.md', 'Installed old content\r\n');
    write(second, 'references/required.md', 'Distribution old content\n');
    f.destinations.push(second);
    const before = f.destinations.map(destination => snapshot(destination).files);
    const plan = createPlan(f);
    const result = applyPlan(plan);
    assert.equal(result.status, 'applied');
    assert.equal(checkTrees(f.source, f.destinations).exactMatch, true);
    assert.equal(run(['check', '--source', f.source, '--destination', f.destination, '--destination', second]).status, 0);
    assert.equal(hash(fs.readFileSync(result.journalPath)), result.journalSha256);
    const journal = JSON.parse(fs.readFileSync(result.journalPath));
    assert.equal(journal.status, 'complete');
    assert.equal(journal.pending, null);
    assert.equal(journal.completed.length, journal.operations.length);
    assert.equal(hash(fs.readFileSync(path.join(path.dirname(result.journalPath), 'reviewed-plan.json'))), plan.planSha256);
    for (const operation of journal.operations) {
      const target = path.join(operation.destination, operation.path);
      assert.equal(hash(fs.readFileSync(target)), operation.afterSha256);
      if (operation.backup) {
        const backup = path.join(path.dirname(result.journalPath), operation.backup);
        const original = fs.readFileSync(backup);
        assert.equal(hash(original), operation.beforeSha256);
        fs.writeFileSync(target, original);
      } else {
        // This fixture owns these exact files. Production recovery requires
        // separate authorization before deleting introduced destination files.
        fs.unlinkSync(target);
      }
    }
    assert.deepEqual(f.destinations.map(destination => snapshot(destination).files), before);
  }],
  ['CLI plan/apply uses digest and replay refuses stale snapshots', () => {
    const f = fixture();
    const planned = run(['plan', '--source', f.source, '--destination', f.destination, '--task-dir', f.taskDir, '--out', f.out]);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    const applied = run(['apply', '--plan', plan.planPath, '--plan-sha256', plan.planSha256]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).exactMatch, true);
    const replay = run(['apply', '--plan', plan.planPath, '--plan-sha256', plan.planSha256]);
    assert.equal(replay.status, 2);
    assert.match(replay.stderr, /Destination drift/);
    const next = createPlan({ ...f, out: path.join(f.taskDir, 'matching.json') });
    assert.equal(applyPlan(next).status, 'already-matching');
  }],
  ['partial write failure retains all backups and identifies the pending exact path', () => {
    const f = fixture();
    const second = path.join(f.root, 'second');
    write(f.destination, 'SKILL.md', 'First original');
    write(second, 'SKILL.md', 'Second original');
    f.destinations.push(second);
    const plan = createPlan(f);
    const target = path.join(f.destination, 'SKILL.md');
    const originalWrite = fs.writeFileSync;
    let failure;
    try {
      // Inject a real partial write failure at the filesystem boundary, without
      // adding a production bypass or failure-injection flag to the CLI.
      fs.writeFileSync = function (file, data, options) {
        if (typeof file === 'string' && file === target) {
          originalWrite(file, data.subarray(0, 7), options);
          throw new Error('Simulated disk write interruption');
        }
        return originalWrite(file, data, options);
      };
      assert.throws(() => applyPlan(plan), error => {
        failure = error.message;
        return /Simulated disk write interruption.*Recovery journal:/.test(error.message);
      });
    } finally { fs.writeFileSync = originalWrite; }
    const journalPath = failure.split('Recovery journal: ')[1];
    const journal = JSON.parse(fs.readFileSync(journalPath));
    assert.equal(journal.status, 'interrupted');
    assert.equal(journal.operations[journal.pending].path, 'SKILL.md');
    assert.ok(journal.completed.length > 0);
    for (const operation of journal.operations.filter(operation => operation.backup)) {
      const backup = path.join(path.dirname(journalPath), operation.backup);
      assert.equal(hash(fs.readFileSync(backup)), operation.beforeSha256);
    }
    assert.equal(fs.readFileSync(path.join(second, 'SKILL.md'), 'utf8'), 'Second original');
    assert.throws(() => applyPlan(plan), /Destination drift/);
  }],
];

let failed = 0;
fs.mkdirSync(fixtureRoot, { recursive: true });
try {
  for (const [name, test] of tests) {
    try { test(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack}\n`); }
  }
} finally {
  // Only this run's resolved fixture directory is recursively removed. No
  // destination, canonical copy, tactical memory or pre-existing task is removed.
  const resolved = fs.realpathSync(fixtureRoot);
  const allowed = fs.realpathSync(taskRoot);
  if (path.dirname(resolved) !== allowed || !path.basename(resolved).startsWith('skill-distribution-tests-')) {
    throw new Error(`Unsafe fixture cleanup refused: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: false });
}
process.stdout.write(`${tests.length - failed}/${tests.length} skill distribution tests passed\n`);
process.exitCode = failed ? 1 : 0;
