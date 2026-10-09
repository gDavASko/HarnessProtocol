import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const validator = fileURLToPath(new URL('./validator.js', import.meta.url));
const root = path.dirname(path.dirname(validator));
const fixtureParent = path.join(root, '.harness');
const environment = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    HARNESS_OFFLINE: '1',
    HARNESS_PROBE_SKIP: '1',
};

async function fixture(fn) {
    await fs.mkdir(fixtureParent, { recursive: true });
    const dir = await fs.mkdtemp(path.join(fixtureParent, 'validator-boundaries-'));
    try {
        const taskDir = path.join(dir, 'task with spaces');
        const source = path.join(taskDir, 'workspace');
        const checks = path.join(taskDir, 'checks');
        await fs.mkdir(source, { recursive: true });
        await fs.mkdir(checks);
        const artifact = path.join(source, 'core.mjs');
        await fs.writeFile(artifact, 'export const value = 0;\n');
        await fs.writeFile(path.join(taskDir, 'evidence-scope.json'), JSON.stringify({
            schema_version: 1, source_roots: [source],
        }));
        await fs.writeFile(path.join(taskDir, '.harness_roadmap.json'), JSON.stringify({
            nodes: [{ id: 'N1', artifact_kind: 'code', iteration: 0, deliverables: [artifact] }],
        }));

        function validate(args, overrides = {}) {
            const env = { ...environment };
            for (const key of Object.keys(env)) {
                if (key.toUpperCase() === 'HARNESS_STUDIO_PROFILE') delete env[key];
            }
            const result = spawnSync(process.execPath, [validator, taskDir, '--node', 'N1', ...args], {
                encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...env, ...overrides },
            });
            assert.ifError(result.error);
            assert.equal(result.signal, null, result.stderr);
            const output = (result.stdout || result.stderr).trim();
            let data;
            try { data = JSON.parse(output); }
            catch { assert.fail(`Validator did not emit JSON: ${output}`); }
            return { status: result.status, data };
        }

        function oracle(rung, command) {
            const args = ['--type', 'oracle', '--rung', rung];
            if (command) args.push('--cmd', command);
            return validate(args);
        }

        async function receipt(rung) {
            const store = JSON.parse((await fs.readFile(path.join(taskDir, 'evidence_receipts.json'), 'utf8')).replace(/^\uFEFF/, ''));
            return rung === 'integration' ? store.__task__ : store.N1.rungs[rung];
        }

        await fn({ taskDir, source, checks, artifact, oracle, receipt, validate });
    } finally {
        // Only remove this test's mkdtemp child; never a computed repository root.
        const cleanup = path.resolve(dir);
        assert.equal(path.dirname(cleanup), path.resolve(fixtureParent));
        assert.ok(path.basename(cleanup).startsWith('validator-boundaries-'));
        await fs.rm(cleanup, { recursive: true, force: true });
    }
}

test('failed ordinary oracle reports failure through both the CLI exit and receipt', () => fixture(async ({ oracle, receipt }) => {
    const result = oracle('tests', 'node --check checks/does-not-exist.mjs');
    assert.equal(result.status, 1);
    assert.equal(result.data.result, 'FAIL');
    assert.equal(result.data.checks[0].status, 'FAIL');
    assert.equal((await receipt('tests')).result, 'FAIL');
}));

test('an unchanged passing oracle still succeeds through the CLI', () => fixture(async ({ checks, oracle, receipt }) => {
    await fs.writeFile(path.join(checks, 'pass.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../workspace/core.mjs';\nassert.equal(value, 0);\n");
    const result = oracle('tests', 'node checks/pass.mjs');
    assert.equal(result.status, 0);
    assert.equal(result.data.result, 'PASS');
    assert.equal((await receipt('tests')).result, 'PASS');
}));

test('security reads ignored deliverables beyond the judge evidence truncation limit', () => fixture(async ({ artifact, oracle, receipt }) => {
    await fs.writeFile(artifact, `${'// harmless padding\n'.repeat(10000)}export const isAdmin = true;\n`);
    const ignored = spawnSync('git', ['check-ignore', '--', artifact], {
        cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(ignored.error);
    assert.equal(ignored.status, 0, 'The security regression must use a genuinely Git-ignored deliverable.');
    const result = oracle('security');
    assert.equal(result.status, 1);
    assert.equal(result.data.result, 'FAIL');
    assert.ok(result.data.findings.some(finding => finding.rule === 'auth-bypass'));
    assert.equal((await receipt('security')).result, 'FAIL');
}));

test('missing declared security evidence cannot produce a passing receipt', () => fixture(async ({ artifact, taskDir, oracle }) => {
    await fs.unlink(artifact);
    const result = oracle('security');
    assert.equal(result.status, 1);
    assert.notEqual(result.data.result, 'PASS');
    assert.match(result.data.error, /ENOENT|missing|evidence/i);
    await assert.rejects(fs.access(path.join(taskDir, 'evidence_receipts.json')), { code: 'ENOENT' });
}));

for (const byteOrder of ['little', 'big']) {
    test(`security scans both unsafe and safe UTF-16 ${byteOrder}-endian C# source`, () => fixture(async ({ artifact, source, taskDir, oracle }) => {
        const sourceFile = path.join(source, 'Auth.cs');
        await fs.rename(artifact, sourceFile);
        const content = Buffer.from('public class Auth { public bool isAdmin = true; }', 'utf16le');
        const encoded = byteOrder === 'little'
            ? Buffer.concat([Buffer.from([0xff, 0xfe]), content])
            : Buffer.concat([Buffer.from([0xfe, 0xff]), content.swap16()]);
        await fs.writeFile(sourceFile, encoded);
        const roadmapFile = path.join(taskDir, '.harness_roadmap.json');
        const roadmap = JSON.parse(await fs.readFile(roadmapFile, 'utf8'));
        roadmap.nodes[0].deliverables = [sourceFile];
        await fs.writeFile(roadmapFile, JSON.stringify(roadmap));
        const result = oracle('security');
        assert.equal(result.status, 1, 'Either decode and detect the auth bypass or reject unsupported source encoding.');
        assert.notEqual(result.data.result, 'PASS');
        assert.ok(result.data.error || result.data.findings?.some(finding => finding.rule === 'auth-bypass'));
        const safeText = Buffer.from('public class Auth { public bool isAdmin = false; }', 'utf16le');
        await fs.writeFile(sourceFile, byteOrder === 'little'
            ? Buffer.concat([Buffer.from([0xff, 0xfe]), safeText])
            : Buffer.concat([Buffer.from([0xfe, 0xff]), safeText.swap16()]));
        const safe = oracle('security');
        assert.equal(safe.status, 0);
        assert.equal(safe.data.result, 'PASS');
    }));
}

for (const [name, bytes] of [
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['unrecognized binary', Buffer.from([0x00, 0x01, 0x02])],
]) {
    test(`security refuses ${name} instead of scanning a placeholder`, () => fixture(async ({ artifact, oracle }) => {
        await fs.writeFile(artifact, bytes);
        const result = oracle('security');
        assert.equal(result.status, 1);
        assert.notEqual(result.data.result, 'PASS');
        assert.match(result.data.error, /encoding unsupported or binary/i);
    }));
}

test('security reads an undeclared tracked binary change rather than accepting Git binary-diff text', () => fixture(async ({ taskDir, source, oracle }) => {
    const src = path.join(taskDir, 'src');
    await fs.rename(source, src); // No conventional workspace or declared files: use Git gathering.
    await fs.writeFile(path.join(src, 'core.mjs'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(taskDir, 'evidence-scope.json'), JSON.stringify({ schema_version: 1, source_roots: [src] }));
    await fs.writeFile(path.join(taskDir, '.harness_roadmap.json'), JSON.stringify({ nodes: [{ id: 'N1', artifact_kind: 'code', iteration: 0, deliverables: [] }] }));
    await fs.writeFile(path.join(taskDir, '.gitignore'), '/.harness*\n/evidence*\n/checks/\n');
    const hooks = path.join(taskDir, 'checks', 'empty-hooks');
    await fs.mkdir(hooks);
    const gitOptions = [
        '-c', 'user.name=Harness Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`,
    ];
    function git(args) {
        const result = spawnSync('git', [...gitOptions, ...args], { cwd: taskDir, encoding: 'utf8', timeout: 10000, windowsHide: true });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    }
    // Git writes are confined to this throwaway fixture, with user hooks/signing disabled.
    git(['init', '--quiet']);
    git(['add', '--', '.gitignore', 'src/core.mjs']);
    git(['commit', '--quiet', '-m', 'Fixture baseline']);
    await fs.writeFile(path.join(src, 'core.mjs'), Buffer.from([0, 1, 3]));
    assert.match(git(['diff', 'HEAD', '--', 'src/core.mjs']), /Binary files/);
    const result = oracle('security');
    assert.equal(result.status, 1);
    assert.notEqual(result.data.result, 'PASS');
    assert.match(result.data.error, /encoding unsupported or binary/i);
}));

for (const selectedPolicy of [false, true]) {
    test(`cached native-judge fallback cannot override offline denial ${selectedPolicy ? 'with a selected policy' : 'without a policy'}`, () => fixture(async ({ taskDir, checks, oracle, validate }) => {
        await fs.writeFile(path.join(checks, 'pass.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../workspace/core.mjs';\nassert.equal(value, 0);\n");
        assert.equal(oracle('compile', 'node --check workspace/core.mjs').data.result, 'PASS');
        assert.equal(oracle('tests', 'node checks/pass.mjs').data.result, 'PASS');
        assert.equal(oracle('security').data.result, 'PASS');
        // This isolated fixture models persisted state from a former runtime;
        // no model is invoked to create or authorize that obsolete state.
        const stateFile = path.join(taskDir, '.harness_state.json');
        const priorState = { stage: 'awaiting_subagent_validation', current_node: 'N1', validation_mode: 'subagent_fallback' };
        await fs.writeFile(stateFile, JSON.stringify(priorState));
        await fs.writeFile(path.join(taskDir, 'judge.json'), JSON.stringify({
            pass: true, dod_results: [{ index: 0, pass: true }],
            rubric: { functionality: 10, quality: 10, security: 10, edge_cases: 10 },
        }));
        const overrides = {};
        if (selectedPolicy) {
            const policyFile = path.join(taskDir, 'policy.json');
            await fs.writeFile(policyFile, JSON.stringify({
                kind: 'harness-model-policy', schema_version: 1, id: 'fixture-only',
                authorization_reference: 'offline test fixture; no live dispatch',
                allowed: [{ provider: 'claude', model: 'fixture-model', role: 'judge', effort: 'low' }],
                limits: { max_calls: 1, max_output_tokens: 100, max_elapsed_ms: 1000, call_timeout_ms: 1000, output_tokens_per_call: 100 },
            }));
            overrides.HARNESS_STUDIO_PROFILE = policyFile;
        }
        const result = validate(['--type', 'ai', '--judge-file', 'judge.json'], overrides);
        assert.equal(result.status, 1);
        assert.equal(result.data.gate, 'native_judge_not_authorized');
        assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), priorState, 'Denied fallback must not certify or rewrite the cached state.');
    }));
}

test('L0 without an oracle is UNVALIDATED before any offline probe can be attempted', () => fixture(async ({ taskDir, validate }) => {
    const roadmapFile = path.join(taskDir, '.harness_roadmap.json');
    const roadmap = JSON.parse(await fs.readFile(roadmapFile, 'utf8'));
    roadmap.nodes[0].criticality = 'L0';
    roadmap.nodes[0].validation_type = 'ai';
    await fs.writeFile(roadmapFile, JSON.stringify(roadmap));
    await fs.writeFile(path.join(taskDir, '.harness_state.json'), JSON.stringify({ stage: 'report_ready', current_node: 'N1' }));
    const result = validate(['--type', 'ai'], { HARNESS_REQUIRE_SUMMARY: '0', HARNESS_REQUIRE_SELFREVIEW: '0' });
    assert.equal(result.status, 0);
    assert.equal(result.data.result, 'UNVALIDATED');
    assert.match(result.data.comment, /L0.*deterministic oracle required/);
    assert.equal(result.data.error, undefined, 'Reaching the probe API would fail the hard offline boundary instead.');
    const state = JSON.parse(await fs.readFile(path.join(taskDir, '.harness_state.json'), 'utf8'));
    assert.equal(state.stage, 'report_ready');
    assert.equal(state.validation_result, 'UNVALIDATED');
}));

for (const rung of ['tests', 'integration']) {
    for (const restore of [false, true]) {
        test(`${rung} CLI rejects ${restore ? 'rewritten then restored' : 'persistently changed'} source even when its command passes`, () => fixture(async ({ checks, artifact, oracle, receipt }) => {
            const original = await fs.readFile(artifact, 'utf8');
            const script = [
                "import fs from 'node:fs/promises';",
                "import assert from 'node:assert/strict';",
                "const file = new URL('../workspace/core.mjs', import.meta.url);",
                "const original = await fs.readFile(file, 'utf8');",
                'try {',
                "  await fs.writeFile(file, 'export const value = 1;\\n');",
                '  const { value } = await import(file.href);',
                '  assert.equal(value, 1);',
                `} finally { ${restore ? 'await fs.writeFile(file, original);' : ''} }`,
            ].join('\n');
            await fs.writeFile(path.join(checks, 'mutate.mjs'), script);
            const result = oracle(rung, 'node checks/mutate.mjs');
            assert.equal(result.data.checks[0].status, 'PASS', 'The oracle command must actually succeed before freshness rejects it.');
            assert.equal(result.status, 1);
            assert.equal(result.data.result, 'FAIL');
            const recorded = await receipt(rung);
            assert.equal(recorded.result, 'FAIL');
            assert.match(recorded.detail, /SOURCE_CHANGED_DURING_CHECK/);
            if (restore) assert.equal(await fs.readFile(artifact, 'utf8'), original);
        }));
    }

    test(`${rung} CLI rejects a dependency created only for the check and removed afterward`, () => fixture(async ({ checks, artifact, oracle, receipt }) => {
        await fs.writeFile(artifact, "export { value } from './temporary.mjs';\n");
        await fs.writeFile(path.join(checks, 'temporary-dependency.mjs'), [
            "import fs from 'node:fs/promises';",
            "import assert from 'node:assert/strict';",
            "const temporary = new URL('../workspace/temporary.mjs', import.meta.url);",
            'try {',
            "  await fs.writeFile(temporary, 'export const value = 1;\\n');",
            "  const { value } = await import('../workspace/core.mjs');",
            '  assert.equal(value, 1);',
            '} finally { await fs.unlink(temporary); }',
        ].join('\n'));
        const result = oracle(rung, 'node checks/temporary-dependency.mjs');
        assert.equal(result.data.checks[0].status, 'PASS');
        const finalSource = spawnSync(process.execPath, [artifact], {
            encoding: 'utf8', timeout: 10000, windowsHide: true, env: environment,
        });
        assert.ifError(finalSource.error);
        assert.equal(finalSource.status, 1);
        assert.match(finalSource.stderr, /ERR_MODULE_NOT_FOUND/);
        assert.equal(result.status, 1, 'A successful check must not certify a source tree with its required dependency removed.');
        assert.equal(result.data.result, 'FAIL');
        assert.equal((await receipt(rung)).result, 'FAIL');
    }));
}
