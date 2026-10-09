// Optional studio dispatch policy. This bounds calls made by Harness transports;
// it is NOT an OS sandbox, an account quota, or a restriction on other programs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TEST_HARNESSES = new WeakSet();
const PROVIDERS = new Set(['gemini-http', 'codex', 'claude', 'agy', 'gemini']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export class ModelPolicyError extends Error {
    constructor(message) { super(`[model-policy] ${message}`); this.code = 'MODEL_POLICY_DENIED'; }
}

export function hasStudioPolicy(options = {}) {
    return options.studioProfile !== undefined || Object.hasOwn(process.env, 'HARNESS_STUDIO_PROFILE');
}

export function loadModelPolicy(options = {}) {
    if (!hasStudioPolicy(options)) return null;
    const selected = options.studioProfile !== undefined ? options.studioProfile : process.env.HARNESS_STUDIO_PROFILE;
    if (!nonempty(selected) || !path.isAbsolute(selected)) throw new ModelPolicyError('selected profile must be an absolute JSON path');
    let policy;
    try { policy = JSON.parse(fs.readFileSync(selected, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new ModelPolicyError('selected profile is missing or invalid JSON'); }
    if (policy?.kind !== 'harness-model-policy' || policy.schema_version !== 1 ||
        !nonempty(policy.id) || !nonempty(policy.authorization_reference)) {
        throw new ModelPolicyError('profile kind, schema_version, id and authorization_reference are required');
    }
    if (!Array.isArray(policy.allowed) || policy.allowed.length === 0 || policy.allowed.some(entry =>
        !entry || !PROVIDERS.has(entry.provider) || !['model', 'role', 'effort'].every(key => nonempty(entry[key])) ||
        ['model', 'role', 'effort'].some(key => entry[key].includes('*')))) {
        throw new ModelPolicyError('profile requires a nonempty exact provider/model/role/effort allowlist');
    }
    const limits = policy.limits;
    if (!limits || !['max_calls', 'max_output_tokens', 'max_elapsed_ms', 'call_timeout_ms', 'output_tokens_per_call'].every(key => positive(limits[key])) ||
        limits.output_tokens_per_call > limits.max_output_tokens || limits.call_timeout_ms > limits.max_elapsed_ms) {
        throw new ModelPolicyError('profile requires finite positive call, output and time limits');
    }
    return { ...policy, fingerprint: createHash('sha256').update(JSON.stringify(policy)).digest('hex') };
}

// An explicit in-process test double, available only under node --test. Even
// offline, this can dispatch ONLY through the supplied fake transport, never the
// production spawn/fetch. Authorization and persistent reservations still run.
export function createModelTestHarness(transports) {
    if (!process.env.NODE_TEST_CONTEXT) throw new ModelPolicyError('test transport requires node --test');
    const harness = Object.freeze({ ...transports });
    TEST_HARNESSES.add(harness);
    return harness;
}

export function testTransport(options, name) {
    const harness = options?.testHarness;
    if (harness === undefined) return null;
    if (!TEST_HARNESSES.has(harness) || typeof harness[name] !== 'function') {
        throw new ModelPolicyError(`invalid ${name} test transport`);
    }
    return harness[name];
}

export function assertOnline(options = {}, transport = 'cli') {
    const fake = testTransport(options, transport);
    if (process.env.HARNESS_OFFLINE === '1' && !fake) {
        const error = new ModelPolicyError('HARNESS_OFFLINE=1 forbids live HTTP, CLI and probe calls');
        error.code = 'HARNESS_OFFLINE';
        throw error;
    }
    return fake;
}

function validateRequest(policy, request) {
    if (!policy.allowed.some(entry => ['provider', 'model', 'role', 'effort'].every(key => entry[key] === request[key]))) {
        throw new ModelPolicyError(`not allowed: ${request.provider}/${request.model ?? '(unset)'}/${request.role ?? '(unset)'}/${request.effort ?? '(unset)'}`);
    }
}

export function policyAllows(policy, request) {
    return !!policy?.allowed.some(entry => ['provider', 'model', 'role', 'effort'].every(key => entry[key] === request[key]));
}

export function policyModelFor(provider, role, effort = 'default', options = {}) {
    const policy = loadModelPolicy(options);
    if (!policy) return null;
    const models = [...new Set(policy.allowed.filter(entry => entry.provider === provider && entry.role === role && entry.effort === effort).map(entry => entry.model))];
    if (models.length !== 1) throw new ModelPolicyError(`one explicit model required for ${provider}/${role}/${effort}`);
    return models[0];
}

// One ledger per caller-supplied run, shared across processes and providers.
// mkdir is the cross-process lock; rename publishes the complete ledger. We do
// not reclaim stale locks or corrupt state: recovery needs an explicit operator
// decision. Reservations are never refunded, including errors/unknown usage.
export async function authorizeModelCall(request, options = {}) {
    const policy = loadModelPolicy(options);
    assertOnline(options, request.provider === 'gemini-http' ? 'http' : 'cli');
    if (!policy) return { timeoutMs: positive(options.timeoutMs) ? options.timeoutMs : 30000, maxOutputTokens: null };
    validateRequest(policy, request);
    const runId = options.runId ?? process.env.HARNESS_RUN_ID;
    const runDir = options.runDir ?? process.env.HARNESS_RUN_DIR;
    if (!nonempty(runId) || !nonempty(runDir) || !path.isAbsolute(runDir)) throw new ModelPolicyError('HARNESS_RUN_ID and absolute HARNESS_RUN_DIR (or runId/runDir) are required');
    const requested = options.maxOutputTokens ?? policy.limits.output_tokens_per_call;
    if (!positive(requested) || requested > policy.limits.output_tokens_per_call) throw new ModelPolicyError('requested output exceeds per-call allowance');
    if (options.timeoutMs != null && !positive(options.timeoutMs)) throw new ModelPolicyError('invalid call timeout');
    const directory = path.join(runDir, '.harness', 'model-budgets');
    const ledgerPath = path.join(directory, `${createHash('sha256').update(runId).digest('hex')}.json`);
    const lockPath = `${ledgerPath}.lock`;
    await fsp.mkdir(directory, { recursive: true });
    const lockDeadline = Date.now() + 2000;
    while (true) {
        try { await fsp.mkdir(lockPath); break; }
        catch (err) {
            if (err.code !== 'EEXIST' || Date.now() >= lockDeadline) throw new ModelPolicyError('budget ledger unavailable or locked; refusing dispatch');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    const tempPath = `${ledgerPath}.${randomUUID()}.tmp`;
    try {
        let ledger;
        try { ledger = JSON.parse(await fsp.readFile(ledgerPath, 'utf8')); }
        catch (err) {
            if (err.code !== 'ENOENT') throw new ModelPolicyError('budget ledger is corrupt or unreadable');
            ledger = { schema_version: 1, runId, profile: policy.fingerprint, startedAt: Date.now(), calls: 0, reservedOutputTokens: 0 };
        }
        if (ledger.schema_version !== 1 || ledger.runId !== runId || ledger.profile !== policy.fingerprint ||
            !positive(ledger.startedAt) || ledger.startedAt > Date.now() ||
            !Number.isSafeInteger(ledger.calls) || ledger.calls < 0 ||
            !Number.isSafeInteger(ledger.reservedOutputTokens) || ledger.reservedOutputTokens < 0) {
            throw new ModelPolicyError('budget ledger does not match this run/profile or is invalid');
        }
        const remainingMs = policy.limits.max_elapsed_ms - (Date.now() - ledger.startedAt);
        if (remainingMs <= 0 || ledger.calls >= policy.limits.max_calls || ledger.reservedOutputTokens + requested > policy.limits.max_output_tokens) {
            throw new ModelPolicyError('run call/output/time budget exhausted');
        }
        ledger.calls += 1;
        ledger.reservedOutputTokens += requested;
        const handle = await fsp.open(tempPath, 'wx');
        try { await handle.writeFile(JSON.stringify(ledger) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await fsp.rename(tempPath, ledgerPath);
        const dispatchRemainingMs = policy.limits.max_elapsed_ms - (Date.now() - ledger.startedAt);
        if (dispatchRemainingMs <= 0) throw new ModelPolicyError('run time budget exhausted during reservation');
        return { timeoutMs: Math.min(options.timeoutMs ?? policy.limits.call_timeout_ms, policy.limits.call_timeout_ms, dispatchRemainingMs), maxOutputTokens: requested, ledgerPath };
    } finally {
        await fsp.unlink(tempPath).catch(() => {});
        await fsp.rmdir(lockPath);
    }
}
