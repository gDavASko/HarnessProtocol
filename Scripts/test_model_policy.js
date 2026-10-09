import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createModelTestHarness, loadModelPolicy } from './modelPolicy.js';
import { runCliModel, runWorkerTurn, callSingleJudge, callExternalJudge } from './cliTransport.js';
import { callLLM, callLLMDirect, callLLMWithFallback } from './llmClient.js';
import { runProbe, loadProbe, liveJudgesFromProbe, getAvailableJudgeChain, probeCliReport } from './aiProbe.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
process.env.HARNESS_OFFLINE = '1';
delete process.env.HARNESS_STUDIO_PROFILE;
delete process.env.HARNESS_RUN_ID;
delete process.env.HARNESS_RUN_DIR;

const entry = (provider = 'claude', role = 'worker', model = 'fixture-model', effort = 'high') => ({ provider, role, model, effort });
const defaultLimits = { max_calls: 3, max_output_tokens: 768, max_elapsed_ms: 10000, call_timeout_ms: 2000, output_tokens_per_call: 256 };

async function context(t, { allowed = [entry()], limits = {}, mode = 'normal', http } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-model-policy-'));
    t.after(async () => {
        if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('harness-model-policy-')) throw new Error('unsafe test cleanup');
        await fs.rm(root, { recursive: true, force: true });
    });
    const profile = { kind: 'harness-model-policy', schema_version: 1, id: 'offline-fixture', authorization_reference: 'test-fixtures-only', allowed, limits: { ...defaultLimits, ...limits } };
    const studioProfile = path.join(root, 'policy.json');
    await fs.writeFile(studioProfile, JSON.stringify(profile));
    const calls = [];
    const testHarness = createModelTestHarness({
        cli(args) {
            calls.push(args);
            return spawn(process.execPath, [path.join(fixtureDir, 'model-policy-cli.mjs'), mode, args.bin, ...args.argv], { windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
        },
        http: http || (async (url, options) => {
            calls.push({ url, options });
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fixture-ok' }] } }] }), { status: 200 });
        })
    });
    return { root, profile, calls, options: { studioProfile, runDir: root, runId: 'shared-run', testHarness }, rewrite: async () => fs.writeFile(studioProfile, JSON.stringify(profile)) };
}

async function ledger(ctx) {
    const dir = path.join(ctx.root, '.harness', 'model-budgets');
    const files = (await fs.readdir(dir)).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    return JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
}

const cli = (ctx, more = {}) => runCliModel({ ...ctx.options, bin: 'claude', model: 'fixture-model', role: 'worker', effort: 'high', workDir: ctx.root, userText: 'safe fixture request', ...more });

test('missing, malformed, desired-state, empty and wildcard policies deny public dispatch before any fake spawn', async t => {
    const ctx = await context(t);
    for (const value of [null, {}, { kind: 'studio-profile-desired-state' }, { ...ctx.profile, allowed: [] }, { ...ctx.profile, allowed: [entry('claude', '*')] }, { ...ctx.profile, limits: { ...defaultLimits, max_calls: 0 } }, { ...ctx.profile, authorization_reference: '' }]) {
        await fs.writeFile(ctx.options.studioProfile, JSON.stringify(value));
        const result = await cli(ctx);
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, 'MODEL_POLICY_DENIED');
    }
    await fs.writeFile(ctx.options.studioProfile, '{');
    assert.equal((await cli(ctx)).errorCode, 'MODEL_POLICY_DENIED');
    assert.equal((await cli(ctx, { studioProfile: path.join(ctx.root, 'missing.json') })).errorCode, 'MODEL_POLICY_DENIED');
    assert.equal((await cli(ctx, { studioProfile: '' })).errorCode, 'MODEL_POLICY_DENIED');
    assert.equal(ctx.calls.length, 0);
});

test('exact provider, model, role, effort and explicit run scope required', async t => {
    const ctx = await context(t);
    for (const override of [{ bin: 'codex' }, { model: 'other' }, { model: null }, { role: 'judge' }, { effort: 'default' }, { runId: '' }, { runDir: '' }, { resume: true }, { sessionId: 'reused' }, { maxOutputTokens: 257 }, { testHarness: { cli() { throw new Error('not a branded fake'); } } }]) {
        assert.equal((await cli(ctx, override)).errorCode, 'MODEL_POLICY_DENIED');
    }
    assert.equal(ctx.calls.length, 0);
    assert.equal((await cli(ctx)).ok, true);
    assert.equal(ctx.calls.length, 1);
    assert.ok(ctx.calls[0].argv.includes('--effort'));
    assert.ok(ctx.calls[0].argv.includes('high'));
    assert.ok(ctx.calls[0].argv.includes('fixture-model'));
    assert.equal((await ledger(ctx)).reservedOutputTokens, 256);
});

test('offline applies to every public HTTP/CLI/worker/judge/probe entry without a fake seam', async t => {
    const ctx = await context(t);
    const opts = { ...ctx.options, testHarness: undefined };
    for (const call of [
        () => callLLM('worker', '', 'offline', opts),
        () => callLLM('maker', '', 'offline', opts),
        () => callLLMDirect({ name: 'Claude Fixture' }, '', 'offline', opts),
        () => callLLMWithFallback('worker', '', 'offline', opts),
        () => runProbe({ ...opts, workDir: ctx.root })
    ]) await assert.rejects(call, /HARNESS_OFFLINE/);
    assert.equal((await cli(ctx, { testHarness: undefined })).errorCode, 'HARNESS_OFFLINE');
    assert.equal((await callSingleJudge({ ...opts, bin: 'claude', model: 'fixture-model', workDir: ctx.root })).errorCode, 'HARNESS_OFFLINE');
    const judge = await callExternalJudge({ ...opts, chain: ['claude', 'codex'], model: 'fixture-model', workDir: ctx.root });
    assert.equal(judge.errorCode, 'HARNESS_OFFLINE');
    assert.equal(judge.attempts.length, 1);
    assert.equal((await runWorkerTurn({ ...opts, bin: 'claude', model: 'fixture-model', taskDir: ctx.root })).errorCode, 'HARNESS_OFFLINE');
    assert.equal(ctx.calls.length, 0);
});

test('no profile preserves legacy dry runs but real CLI remains blocked offline', async t => {
    const ctx = await context(t);
    const result = await runWorkerTurn({ taskDir: ctx.root, bin: 'claude', dryRun: true, userText: 'tiny' });
    assert.equal(result.ok, true);
    assert.equal(loadModelPolicy(), null);
    assert.equal((await runCliModel({ bin: 'claude', workDir: ctx.root })).errorCode, 'HARNESS_OFFLINE');
    await assert.rejects(() => callLLM('maker', '', 'offline'), /HARNESS_OFFLINE/);
    await assert.rejects(() => callLLMDirect({ name: 'Claude Fixture' }, '', 'offline'), /HARNESS_OFFLINE/);
});

test('dotenv cannot disable offline or implicitly change a studio selection, including Windows casing', async t => {
    const ctx = await context(t);
    await fs.writeFile(path.join(ctx.root, '.env'), 'HARNESS_OFFLINE=0\nHarness_Offline=0\nHARNESS_STUDIO_PROFILE=unexpected.json\n');
    const previousCwd = process.cwd();
    process.chdir(ctx.root);
    try {
        await assert.rejects(() => callLLM('worker', '', 'offline'), /HARNESS_OFFLINE/);
        assert.equal(process.env.HARNESS_OFFLINE, '1');
        assert.equal(process.env.HARNESS_STUDIO_PROFILE, undefined);
    } finally { process.chdir(previousCwd); }
});

test('public CLI concurrent dispatch never overspends call or output budget', async t => {
    const ctx = await context(t, { limits: { max_calls: 20, max_output_tokens: 512 } });
    const results = await Promise.all(Array.from({ length: 10 }, () => cli(ctx)));
    assert.equal(results.filter(result => result.ok).length, 2);
    assert.equal(ctx.calls.length, 2);
    assert.equal((await ledger(ctx)).calls, 2);
    assert.equal((await ledger(ctx)).reservedOutputTokens, 512);
});

test('atomic reservations also serialize separate Node processes', async t => {
    const ctx = await context(t, { limits: { max_calls: 2 } });
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(fixtureDir, 'model-policy-reserve.mjs'), ctx.options.studioProfile, ctx.root, ctx.options.runId], { env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }, windowsHide: true });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, output }));
    })));
    assert.equal(results.filter(result => result.code === 0).length, 2);
    assert.equal((await ledger(ctx)).calls, 2);
});

test('failed CLI usage remains reserved and cannot be retried past budget', async t => {
    const ctx = await context(t, { mode: 'error', limits: { max_calls: 1 } });
    assert.equal((await cli(ctx)).ok, false);
    assert.equal((await cli(ctx)).errorCode, 'MODEL_POLICY_DENIED');
    assert.equal(ctx.calls.length, 1);
    assert.equal((await ledger(ctx)).reservedOutputTokens, 256);
});

test('stdout/file output ceilings and process timeouts stop fake executable output', async t => {
    const stdoutCtx = await context(t, { mode: 'large' });
    assert.equal((await cli(stdoutCtx)).errorCode, 'MODEL_POLICY_DENIED');
    const fileCtx = await context(t, { mode: 'large', allowed: [entry('codex')] });
    assert.equal((await cli(fileCtx, { bin: 'codex' })).errorCode, 'MODEL_POLICY_DENIED');
    const timedCtx = await context(t, { mode: 'hang', limits: { call_timeout_ms: 80 } });
    const start = Date.now();
    const result = await cli(timedCtx);
    assert.equal(result.ok, false);
    assert.match(result.error, /Таймаут/);
    assert.ok(Date.now() - start < 3000);
    assert.equal(timedCtx.calls[0].timeoutMs, 80);
});

test('HTTP model override is authorized after resolution and payload includes output cap', async t => {
    const ctx = await context(t, { allowed: [entry('gemini-http', 'worker', 'fixture-http', 'default')] });
    await assert.rejects(() => callLLM('worker', '', 'request', { ...ctx.options, model: 'unapproved-http' }), /not allowed/);
    assert.equal(ctx.calls.length, 0);
    const output = await callLLM('worker', '', 'request', { ...ctx.options, model: 'fixture-http' });
    assert.equal(output, 'fixture-ok');
    assert.equal(JSON.parse(ctx.calls[0].options.body).generationConfig.maxOutputTokens, 256);
    assert.match(ctx.calls[0].url, /models\/fixture-http:/);
    await assert.rejects(() => callLLMDirect({ name: 'Gemini Fixture', model_id: 'fixture-http' }, '', 'request', ctx.options), /not allowed/);
});

test('HTTP excess output denied, failures reserved and fallback cannot change role/effort', async t => {
    let requests = 0;
    const ctx = await context(t, { allowed: [entry('gemini-http', 'worker', 'fixture-http', 'default')], limits: { max_calls: 1 }, http: async () => {
        requests += 1;
        return new Response('limited', { status: 429 });
    } });
    await assert.rejects(() => callLLMWithFallback('worker', '', 'request', { ...ctx.options, model: 'fixture-http' }), /budget exhausted|not allowed/);
    assert.equal(requests, 1);
    assert.equal((await ledger(ctx)).calls, 1);
    const large = await context(t, { allowed: [entry('gemini-http', 'worker', 'fixture-http', 'default')], http: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x'.repeat(20000) }] } }] })) });
    await assert.rejects(() => callLLM('worker', '', 'request', { ...large.options, model: 'fixture-http' }), /allowance exceeded/);
});

test('judge wrappers preserve model, role and effort; policy denial stops fallback', async t => {
    const ctx = await context(t, { allowed: [entry('codex', 'judge')] });
    const result = await callSingleJudge({ ...ctx.options, bin: 'codex', model: 'fixture-model', effort: 'high', role: 'judge', workDir: ctx.root, userText: 'request' });
    assert.equal(result.ok, true);
    assert.ok(ctx.calls[0].argv.includes('fixture-model'));
    assert.ok(ctx.calls[0].argv.includes('model_reasoning_effort="high"'));
    const chain = await callExternalJudge({ ...ctx.options, chain: ['claude', 'codex'], model: 'fixture-model', effort: 'high', workDir: ctx.root });
    assert.equal(chain.errorCode, 'MODEL_POLICY_DENIED');
    assert.equal(chain.attempts.length, 1);
    assert.equal(ctx.calls.length, 1);
});

test('probes only use exact authorized model and separate probe role; no implicit subagent', async t => {
    const ctx = await context(t, { allowed: [entry('claude', 'judge', 'fixture-model', 'default'), entry('claude', 'probe', 'fixture-model', 'default')] });
    const probe = await runProbe({ ...ctx.options, workDir: ctx.root });
    assert.deepEqual(Object.keys(probe.results), ['claude']);
    assert.equal(probe.results.claude.ok, true);
    assert.equal(ctx.calls.length, 1);
    assert.equal((await ledger(ctx)).calls, 1);
    assert.equal(liveJudgesFromProbe(probe, { ...ctx.options, poolIds: ['claude', 'claude-subagent'] }).length, 1);
    assert.deepEqual(liveJudgesFromProbe({ results: { claude: { ok: true } } }, { ...ctx.options, poolIds: ['claude', 'claude-subagent'] }), []);
    const missingProbe = await context(t, { allowed: [entry('claude', 'judge', 'fixture-model', 'default')] });
    await assert.rejects(() => runProbe({ ...missingProbe.options, workDir: missingProbe.root }), /explicit model required/);
    assert.equal(missingProbe.calls.length, 0);
    const cached = await getAvailableJudgeChain({ ...ctx.options, autoProbe: false });
    assert.deepEqual(cached.chain, ['claude']);
    assert.equal(ctx.calls.length, 1, 'valid cached evidence must not cause another model call');
});

test('public cache and CLI report reject invalid/future dates and incompatible model/effort/profile evidence', async t => {
    const ctx = await context(t, { allowed: [
        entry('claude', 'judge', 'fixture-model', 'default'),
        entry('claude', 'judge', 'fixture-model', 'high'),
        entry('claude', 'probe', 'fixture-model', 'default')
    ] });
    const cacheFile = path.join(ctx.root, '.harness', 'ai_probe.json');
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const valid = {
        checked_at: new Date(Date.now() - 10).toISOString(),
        policy_fingerprint: loadModelPolicy(ctx.options).fingerprint,
        results: { claude: { ok: true, model: 'fixture-model', effort: 'default', latency_ms: 1 } }
    };
    await fs.writeFile(cacheFile, JSON.stringify(valid));
    assert.equal((await loadProbe(ctx.options)).results.claude.ok, true);
    assert.deepEqual((await probeCliReport({ ...ctx.options, autoProbe: false })).available_judges, ['claude']);
    const invalid = [
        ...[undefined, null, 123, 'not-a-date', new Date(Date.now() + 60000).toISOString(), new Date(Date.now() - 7200000).toISOString()]
            .map(checked_at => ({ ...valid, checked_at })),
        { ...valid, policy_fingerprint: 'another-profile' },
        { ...valid, results: { claude: { ...valid.results.claude, model: 'another-model' } } },
        { ...valid, results: { claude: { ...valid.results.claude, effort: 'high' } } },
        { ...valid, results: { claude: { ...valid.results.claude, effort: undefined } } },
        { ...valid, results: { claude: { ...valid.results.claude, ok: 'true' } } }
    ];
    for (const payload of invalid) {
        await fs.writeFile(cacheFile, JSON.stringify(payload));
        assert.notEqual((await loadProbe(ctx.options))?.results.claude?.ok, true);
        assert.deepEqual(liveJudgesFromProbe(payload, { ...ctx.options, poolIds: ['claude'] }), []);
        const report = await probeCliReport({ ...ctx.options, autoProbe: false });
        assert.deepEqual(report.available_judges, []);
        assert.equal(report.validation_mode, 'subagent_fallback');
    }
    assert.equal(ctx.calls.length, 0, 'cache-only paths never dispatch');
});

test('CLI report replaces future cached evidence only through a newly authorized probe', async t => {
    const ctx = await context(t, { allowed: [entry('claude', 'judge', 'fixture-model', 'default'), entry('claude', 'probe', 'fixture-model', 'default')] });
    const cacheFile = path.join(ctx.root, '.harness', 'ai_probe.json');
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({
        checked_at: new Date(Date.now() + 60000).toISOString(),
        policy_fingerprint: loadModelPolicy(ctx.options).fingerprint,
        results: { claude: { ok: true, model: 'fixture-model', effort: 'default', disabled_until: new Date(Date.now() + 3600000).toISOString() } }
    }));
    const report = await probeCliReport(ctx.options);
    assert.deepEqual(report.available_judges, ['claude']);
    assert.equal(ctx.calls.length, 1, 'future raw cache must not quarantine or stand in for a new probe');
    assert.equal((await ledger(ctx)).calls, 1);
    assert.ok(Date.parse(report.checked_at) <= Date.now());
});

test('expired, corrupt or profile-switched ledger denies further dispatch', async t => {
    const ctx = await context(t);
    assert.equal((await cli(ctx)).ok, true);
    const dir = path.join(ctx.root, '.harness', 'model-budgets');
    const file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.json')));
    const saved = await ledger(ctx);
    await fs.writeFile(file, JSON.stringify({ ...saved, startedAt: Date.now() - 20000 }));
    assert.equal((await cli(ctx)).errorCode, 'MODEL_POLICY_DENIED');
    await fs.writeFile(file, '{');
    assert.equal((await cli(ctx)).errorCode, 'MODEL_POLICY_DENIED');
    await fs.writeFile(file, JSON.stringify(saved));
    ctx.profile.authorization_reference = 'another-authorization';
    await ctx.rewrite();
    assert.equal((await cli(ctx)).errorCode, 'MODEL_POLICY_DENIED');
    assert.equal(ctx.calls.length, 1);
});
