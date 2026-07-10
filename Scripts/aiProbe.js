import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { runCliModel, isBinLikelyAvailable } from './cliTransport.js';
import { findRepoRoot } from './harnessPaths.js';
import { readClean } from './harnessState.js';

// ─── Preflight-опрос доступности CLI-ИИ (судей) ──────────────────────────────
//
// Проблема: цепочка судей опрашивается ВСЛЕПУЮ в момент валидации. Каждый
// недоступный бинарник = до HARNESS_JUDGE_TIMEOUT_MS висания, вся цепочка —
// минуты простоя, цикл харнеса замирает и ломается.
//
// Решение: ДО старта цикла (contextAssembler --mode init) все бинарники
// опрашиваются ПАРАЛЛЕЛЬНО коротким health-check промптом. Результат кэшируется
// в <repoRoot>/.harness/ai_probe.json (TTL). Все потребители судей (validator,
// cli-judge, syncCheck) фильтруют цепочку по результатам опроса:
//   - живые бинарники → используются в порядке judge_chain;
//   - ни одного живого → деградация в режим "субагент-судья" (fallback):
//     валидацию выполняет НЕЗАВИСИМЫЙ субагент IDE-агента со свежим контекстом.
//     Самовалидация в том же контексте по-прежнему запрещена.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_BINS = ['codex', 'claude', 'agy', 'gemini'];
const DEFAULT_TTL_MS = parseInt(process.env.HARNESS_PROBE_TTL_MS, 10) || 60 * 60 * 1000;
// Agentic CLIs (agy ~30s, claude ~9s) cold-start slower than the old 10s probe,
// which wrongly declared live judges dead. Base 40s + adaptive per-binary below.
const DEFAULT_PROBE_TIMEOUT_MS = parseInt(process.env.HARNESS_PROBE_TIMEOUT_MS, 10) || 40000;
// Quarantine window for binaries that fail with a PERMANENT error (broken config,
// account tier), so they are not re-spawned on every init.
const DISABLED_TTL_MS = parseInt(process.env.HARNESS_PROBE_DISABLED_TTL_MS, 10) || 24 * 60 * 60 * 1000;

// The probe proves AUTHENTICATION, not mere reachability: it asks the model to
// echo a fresh random nonce and only counts the binary ONLINE if the exact nonce
// comes back. Non-empty junk (login prompts, help text) must NOT count as alive.
function makeNonce() {
    return 'HNONCE-' + randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
}
function probePrompt(nonce) {
    return `Output this exact token and nothing else: ${nonce}`;
}

// Failures that will not fix themselves on the next spawn — quarantine, don't retry.
const PERMANENT_ERROR_PATTERNS = [
    /IneligibleTierError/i,
    /no longer supported/i,
    /Error loading config\.toml/i,
    /unknown variant/i
];
function isPermanentError(msg) {
    const s = String(msg || '');
    return PERMANENT_ERROR_PATTERNS.some(re => re.test(s));
}

// Signatures of an UNAUTHENTICATED / non-answer response — treat as OFFLINE even
// when stdout is non-empty (the exact guarantee-breaker: "Not logged in" junk).
const AUTH_FAIL_SIGNATURES = [
    /not logged in/i,
    /please run\s+\/?login/i,
    /\/login\b/i,
    /unauthoriz/i,
    /IneligibleTier/i,
    /no longer supported/i,
    /Error loading config\.toml/i,
    /unknown variant/i,
    /^\s*usage:/im,
    /Available subcommands/i,
    /invalid api key/i,
    /authentication/i
];
function looksLikeAuthFailure(text) {
    const s = String(text || '');
    if (!s.trim()) return true; // empty/whitespace is never a valid answer
    return AUTH_FAIL_SIGNATURES.some(re => re.test(s));
}

// CLI → model family. Used to pick a judge of a DIFFERENT family than the worker
// (an executor must never be graded by a sibling of its own model).
export const BIN_FAMILY = { claude: 'anthropic', agy: 'google', gemini: 'google', codex: 'openai' };
export function familyOf(bin) { return BIN_FAMILY[bin] || 'unknown'; }

function probeFilePath() {
    return path.join(findRepoRoot(), '.harness', 'ai_probe.json');
}

async function loadJudgeConfig() {
    try {
        const raw = await readClean(path.resolve(__dirname, 'llm-config.json'));
        const config = JSON.parse(raw);
        const chain = config.cli_transport?.judge_chain;
        const model = config.roles?.judge?.model_id || null;
        if (Array.isArray(chain) && chain.length > 0) return { chain, model };
    } catch { /* дефолт ниже */ }
    return { chain: ['agy', 'claude', 'codex'], model: null };
}

async function probeOne(bin, { workDir, timeoutMs }) {
    if (!isBinLikelyAvailable(bin)) {
        return { bin, ok: false, status: 'not_installed', latency_ms: null, error: 'Бинарник не найден в PATH', permanent: false };
    }

    const start = Date.now();
    const nonce = makeNonce();
    try {
        // Запускаем реальный пинг в пустой временной папке os.tmpdir(),
        // чтобы минимизировать контекст и исключить сканирование репозитория.
        const res = await runCliModel({
            bin,
            workDir: os.tmpdir(),
            systemText: '',
            userText: probePrompt(nonce),
            timeoutMs: timeoutMs || DEFAULT_PROBE_TIMEOUT_MS
        });
        const latency = Date.now() - start;
        const text = res.text || '';
        // AUTHENTICATED only if the exact nonce came back and the response carries
        // no auth-failure signature. res.ok is necessary but NOT sufficient — a CLI
        // can exit 0 while printing "Not logged in".
        if (res.ok && text.includes(nonce) && !looksLikeAuthFailure(text)) {
            return { bin, ok: true, status: 'online', latency_ms: latency, error: null, permanent: false };
        }
        const authFail = looksLikeAuthFailure(text) || looksLikeAuthFailure(res.error);
        const detail = res.error || (text ? `неожиданный ответ (нонс не подтверждён): ${text.slice(0, 80)}` : 'пустой ответ');
        return {
            bin, ok: false,
            status: authFail ? 'unauthenticated' : 'unauthorized_or_error',
            latency_ms: latency,
            error: detail,
            permanent: isPermanentError(res.error) || isPermanentError(text)
        };
    } catch (err) {
        return { bin, ok: false, status: 'exception', latency_ms: Date.now() - start, error: err.message, permanent: isPermanentError(err.message) };
    }
}

/**
 * Параллельно опрашивает все бинарники и пишет кэш ai_probe.json.
 * @param {object} [opts]
 * @param {string[]} [opts.bins] - список бинарников (по умолчанию judge_chain ∪ известные)
 * @param {number} [opts.timeoutMs] - таймаут на один бинарник
 * @param {string} [opts.workDir] - рабочий каталог для CLI (по умолчанию корень репо)
 * @returns {Promise<{checked_at:string, timeout_ms:number, results:Object}>}
 */
export async function runProbe({ bins = null, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, workDir = null } = {}) {
    const { chain } = await loadJudgeConfig();
    const targets = [...new Set([...(bins || []), ...chain, ...KNOWN_BINS])];
    const cwd = workDir || findRepoRoot();

    // Prior cache (TTL ignored): reused for adaptive timeouts and the permanent-
    // failure quarantine so quarantined binaries survive cache expiry.
    const prior = await loadProbeRaw();
    const priorResults = prior?.results || {};
    const now = Date.now();

    const probed = await Promise.all(targets.map(async (bin) => {
        const priorBin = priorResults[bin];
        // Still quarantined → carry the record forward without re-spawning.
        if (priorBin?.disabled_until && Date.parse(priorBin.disabled_until) > now) {
            return {
                bin, ok: false, status: 'disabled_permanent', latency_ms: priorBin.latency_ms ?? null,
                error: priorBin.error || 'Отключён из-за постоянной ошибки', permanent: true,
                disabled_until: priorBin.disabled_until
            };
        }
        // Adaptive per-binary timeout: at least the base, or 2× the last successful
        // probe latency (agentic CLIs can cold-start for tens of seconds).
        const adaptiveTimeout = (priorBin?.ok && priorBin.latency_ms)
            ? Math.max(timeoutMs, 2 * priorBin.latency_ms)
            : timeoutMs;
        const r = await probeOne(bin, { workDir: cwd, timeoutMs: adaptiveTimeout });
        if (!r.ok && r.permanent) {
            r.disabled_until = new Date(now + DISABLED_TTL_MS).toISOString();
        }
        return r;
    }));

    const results = {};
    for (const item of probed) {
        results[item.bin] = {
            ok: item.ok, status: item.status, latency_ms: item.latency_ms, error: item.error,
            ...(item.disabled_until ? { disabled_until: item.disabled_until } : {})
        };
    }

    const payload = {
        checked_at: new Date().toISOString(),
        timeout_ms: timeoutMs,
        results
    };

    const file = probeFilePath();
    try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    } catch { /* кэш опционален — .harness может быть недоступен */ }

    return payload;
}

/**
 * Читает кэш опроса БЕЗ проверки свежести (для adaptive-таймаутов и карантина).
 */
async function loadProbeRaw() {
    try {
        const raw = await fs.readFile(probeFilePath(), 'utf-8');
        const parsed = JSON.parse(raw.replace(/^﻿/, ''));
        return parsed?.results ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Читает кэш опроса, если он свежее maxAgeMs. Иначе null.
 */
export async function loadProbe({ maxAgeMs = DEFAULT_TTL_MS } = {}) {
    try {
        const raw = await fs.readFile(probeFilePath(), 'utf-8');
        const parsed = JSON.parse(raw.replace(/^﻿/, ''));
        if (!parsed.checked_at || !parsed.results) return null;
        if (Date.now() - Date.parse(parsed.checked_at) > maxAgeMs) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Возвращает цепочку судей, отфильтрованную по фактической доступности.
 * При отсутствии/устаревании кэша выполняет опрос (autoProbe).
 * @returns {Promise<{chain:string[], model:string|null, probe:object, fallback:boolean}>}
 *          fallback=true, когда живых внешних судей нет — валидировать должен
 *          независимый субагент IDE-агента (свежий контекст).
 */
export async function getAvailableJudgeChain({ autoProbe = true, maxAgeMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, excludeFamily = null } = {}) {
    const { chain, model } = await loadJudgeConfig();
    // Drop judges of the worker's own family, but never down to zero — a
    // same-family live judge still beats degrading to the subagent fallback.
    const dropFamily = (list) => {
        if (!excludeFamily) return list;
        const diff = list.filter(b => familyOf(b) !== excludeFamily);
        return diff.length > 0 ? diff : list;
    };
    let probe = await loadProbe({ maxAgeMs });
    if (!probe && autoProbe) {
        probe = await runProbe({ timeoutMs });
    }
    if (!probe) {
        // Опрос невозможен — работаем как раньше (полная цепочка, риск таймаутов).
        return { chain: dropFamily(chain), model, probe: null, fallback: false };
    }
    const available = dropFamily(chain.filter(bin => probe.results[bin]?.ok));
    return { chain: available, model, probe, fallback: available.length === 0 };
}

/** Короткая сводка для вывода в контекст/логи. */
export function probeSummary(probe) {
    if (!probe) return 'опрос не выполнялся';
    return Object.entries(probe.results)
        .map(([bin, r]) => `${bin}: ${r.ok ? `online (${r.latency_ms} мс)` : `${r.status}${r.error ? ` — ${String(r.error).slice(0, 80)}` : ''}`}`)
        .join(' | ');
}

async function cliMain() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const timeoutIdx = args.indexOf('--timeout');
    const timeoutMs = timeoutIdx >= 0 && args[timeoutIdx + 1]
        ? parseInt(args[timeoutIdx + 1], 10)
        : DEFAULT_PROBE_TIMEOUT_MS;

    let probe = force ? null : await loadProbe();
    if (!probe) {
        console.log(`🛰️  Опрос CLI-ИИ (таймаут ${timeoutMs} мс на бинарник, параллельно)...`);
        probe = await runProbe({ timeoutMs });
    } else {
        console.log(`📦 Кэш опроса от ${probe.checked_at} (обновить: --force)`);
    }

    const { chain } = await loadJudgeConfig();
    const available = chain.filter(bin => probe.results[bin]?.ok);

    console.log(JSON.stringify({
        checked_at: probe.checked_at,
        results: probe.results,
        judge_chain: chain,
        available_judges: available,
        validation_mode: available.length > 0 ? 'external' : 'subagent_fallback'
    }, null, 2));
    process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    cliMain().catch(err => {
        console.error(`❌ Ошибка aiProbe: ${err.message}`);
        process.exit(1);
    });
}
