import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { resolveTmp, findRepoRoot } from './harnessPaths.js';
import { resolveModelForBin, getLimits } from './harnessConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function validateSecurityPolicy(bin, argv) {
    const policyPath = path.resolve(__dirname, 'llm-security-policy.json');
    try {
        const policyContent = await fs.readFile(policyPath, 'utf-8');
        const policy = JSON.parse(policyContent.replace(/^﻿/, ''));
        
        // 1. Check if binary is allowed
        if (policy.allowed_binaries && !policy.allowed_binaries.includes(bin)) {
            throw new Error(`Блокировка запуска: бинарник "${bin}" не разрешен политикой безопасности.`);
        }
        
        // 2. Check forbidden commands/substrings
        const fullCmd = [bin, ...argv].join(' ').toLowerCase();
        if (policy.forbidden_commands) {
            for (const forbidden of policy.forbidden_commands) {
                const forbiddenLower = forbidden.toLowerCase();
                if (forbiddenLower.includes(' ')) {
                    if (fullCmd.includes(forbiddenLower)) {
                        throw new Error(`Блокировка запуска: команда содержит запрещенную фразу "${forbidden}".`);
                    }
                } else {
                    if (bin.toLowerCase() === forbiddenLower || argv.some(arg => arg.toLowerCase() === forbiddenLower)) {
                        throw new Error(`Блокировка запуска: команда использует запрещенное слово "${forbidden}".`);
                    }
                }
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
}

export async function validateMcpServer(serverName) {
    const policyPath = path.resolve(__dirname, 'llm-security-policy.json');
    try {
        const policyContent = await fs.readFile(policyPath, 'utf-8');
        const policy = JSON.parse(policyContent.replace(/^﻿/, ''));
        
        if (policy.allowed_mcp_servers && !policy.allowed_mcp_servers.includes(serverName)) {
            if (policy.restricted_mcp_servers && policy.restricted_mcp_servers[serverName]) {
                throw new Error(`Ограничение безопасности: MCP-сервер "${serverName}" ограничен. ${policy.restricted_mcp_servers[serverName]}`);
            }
            throw new Error(`Блокировка MCP: сервер "${serverName}" не разрешен в allowed_mcp_servers.`);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

// ─── Надёжный CLI-транспорт для внешних ИИ ────────────────────────────────────
//
// Три правила надёжности (см. HarnessProtocol/raw/token-economy.md и cli-transport):
//   1. Контент (промпт/дифф/сис-промпт) НИКОГДА не попадает в argv — только в
//      файл или stdin. Это устраняет ENAMETOOLONG и весь ад экранирования.
//   2. Не используем PowerShell как лаунчер (он манглит UTF-8 на пайпах и
//      оборачивает stderr). Запуск через shell с ручным квотированием ТОЛЬКО
//      контролируемых токенов (пути, имя модели, короткая ASCII-инструкция).
//   3. Завершение = выход процесса И непустой OUT-файл (в режиме instruct ещё и
//      сентинел). Иначе — таймаут, kill, ошибка.
//
// Три режима транспорта (по убыванию надёжности):
//   A. file_out_flag     — CLI сам пишет ответ в файл нативным флагом (codex -o).
//   B. file_out_instruct — агентный CLI пишет ответ в файл по инструкции (agy/gemini).
//   C. stdout            — ответ читается из stdout (claude -p --output-format text).

export const SENTINEL = '<<<HARNESS_DONE>>>';
const DEFAULT_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;

// Emergency fallback ONLY. The authoritative judge order is `cli_transport.judge_chain`
// in llm-config.json (resolved via aiProbe). gemini is intentionally excluded here until
// its account tier is fixed (IneligibleTierError).
export const EMERGENCY_JUDGE_CHAIN = ['agy', 'claude', 'codex'];

// Встроенная таблица транспортов, привязанная к бинарнику CLI. Режим — свойство
// бинарника (определяется его возможностями), поэтому конфиг задаёт лишь порядок
// перебора бинарников.
const TRANSPORTS = {
    codex: {
        mode: 'file_out_flag',
        // Промпт по stdin (символ '-'), ответ в OUT-файл (-o), песочница read-only.
        build: ({ model, outFile, workDir }) => ({
            argv: [
                'exec', '--skip-git-repo-check', '-s', 'read-only',
                ...(model ? ['-m', model] : []),
                '-o', outFile, '-'
            ],
            promptVia: 'stdin',
            cwd: os.tmpdir()
        })
    },
    claude: {
        mode: 'stdout',
        // Judge is read-only: whitelist Read/Grep/Glob only (no Write/Edit/Bash),
        // never --dangerously-skip-permissions. The verdict comes back on stdout.
        // Session support (B1): --session-id <uuid> on the first worker turn,
        // --resume <uuid> afterwards so later turns send only a delta prompt.
        build: ({ model, sessionId, resume }) => ({
            argv: [
                '-p', '--output-format', 'text',
                '--allowedTools', 'Read', 'Grep', 'Glob',
                ...(resume && sessionId ? ['--resume', sessionId]
                    : sessionId ? ['--session-id', sessionId] : []),
                ...(model ? ['--model', model] : [])
            ],
            promptVia: 'stdin',
            cwd: os.tmpdir()
        })
    },
    agy: {
        // agy print mode returns its answer on stdout. Requiring it to write an
        // output file conflicts with the read-only headless permission policy.
        mode: 'stdout',
        input_file_prompt: true,
        // Короткая ASCII-инструкция в -p (только пути), тяжёлый контент — в IN-файле.
        // Worker/judge is read-only: run in --sandbox (terminal restrictions), NOT
        // --dangerously-skip-permissions.
        build: ({ model, instruction, workDir }) => {
            const docDir = path.resolve(findRepoRoot(), 'Assets/KBPro/kbpro-ai-docs');
            return {
                argv: [
                    '-p', instruction,
                    '--new-project',
                    '--sandbox',
                    '--add-dir', docDir,
                    ...(model ? ['--model', model] : [])
                ],
                promptVia: 'none',
                cwd: os.tmpdir()
            };
        }
    },
    gemini: {
        mode: 'file_out_instruct',
        build: ({ model, instruction, workDir }) => {
            const docDir = path.resolve(findRepoRoot(), 'Assets/KBPro/kbpro-ai-docs');
            return {
                argv: [
                    '-p', instruction,
                    '--approval-mode', 'yolo',
                    '-o', 'text',
                    '--include-directories', docDir,
                    ...(model ? ['-m', model] : [])
                ],
                promptVia: 'none',
                cwd: os.tmpdir()
            };
        }
    }
};

// ─── Квотирование controlled-аргументов ──────────────────────────────────────

function quoteArg(arg) {
    const s = String(arg);
    if (process.platform === 'win32') {
        // Оборачиваем в двойные кавычки — нейтрализует пробелы и метасимволы cmd
        // (< > & | ^). Внутренние кавычки удваиваем. Наши аргументы контролируемы
        // (пути/имена/ASCII-инструкция), untrusted-контент сюда не попадает.
        return `"${s.replace(/"/g, '""')}"`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Низкоуровневый запуск ───────────────────────────────────────────────────

function spawnCli(bin, argv, { cwd, input, timeoutMs }) {
    return new Promise(async (resolve) => {
        try {
            await validateSecurityPolicy(bin, argv);
        } catch (err) {
            resolve({
                code: -1,
                stdout: '',
                stderr: `[AgentShield] ${err.message}`,
                spawnError: true
            });
            return;
        }
        const commandString = [bin, ...argv.map(quoteArg)].join(' ');
        const child = spawn(commandString, {
            shell: true,
            cwd: cwd || process.cwd(),
            windowsHide: true,
            env: { ...process.env, NO_COLOR: '1', CI: '1', TERM: 'dumb' }
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/F', '/T', '/PID', child.pid]);
                } else {
                    child.kill('SIGKILL');
                }
            } catch { /* ignore */ }
            try { child.stdout?.destroy(); } catch {}
            try { child.stderr?.destroy(); } catch {}
            resolve({ code: -1, stdout, stderr, timedOut: true });
        }, timeoutMs || DEFAULT_TIMEOUT_MS);

        child.stdout?.on('data', (d) => { stdout += d.toString('utf-8'); });
        child.stderr?.on('data', (d) => { stderr += d.toString('utf-8'); });

        child.on('error', (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: stderr + `\n${err.message}`, spawnError: true });
        });

        child.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut: false });
        });

        if (child.stdin) {
            // Устойчивость: если CLI-судья умер/закрыл stdin рано (частый случай с
            // флапающими бинарями), запись в stdin поднимает EPIPE/EOF как СОБЫТИЕ
            // 'error' на стриме — отдельное от child.on('error'). Без обработчика
            // оно роняло ВЕСЬ прогон харнеса вместо graceful-fallback на другого
            // судью. Гасим его в спокойный результат.
            child.stdin.on('error', (err) => {
                resolve({ code: -1, stdout, stderr: stderr + `\n[stdin] ${err.message}`, spawnError: true });
            });
            try {
                if (input != null) child.stdin.write(input, 'utf-8');
                child.stdin.end();
            } catch (err) {
                resolve({ code: -1, stdout, stderr: stderr + `\n[stdin-write] ${err.message}`, spawnError: true });
            }
        }
    });
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function stripNoise(text) {
    return String(text || '')
		.replace(/^\s*Warning: .*$/gim, '')
        .replace(/\x1b\[[0-9;]*m/g, '') // ANSI
        .trim();
}

async function readOutFile(outFile, expectSentinel, closed) {
    // После закрытия процесса файл уже должен быть на месте; на всякий случай
    // делаем несколько коротких поллов (агентные CLI пишут файл до завершения).
    const attempts = closed ? 3 : 10;
    for (let i = 0; i < attempts; i++) {
        try {
            const raw = await fs.readFile(outFile, 'utf-8');
            const clean = raw.replace(/^﻿/, '');
            if (clean.trim().length > 0) {
                if (!expectSentinel || clean.includes(SENTINEL)) {
                    return clean.replace(SENTINEL, '').trim();
                }
            }
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return null;
}

async function cleanup(files) {
    for (const f of files) {
        try { await fs.unlink(f); } catch { /* ignore */ }
    }
}

// ─── Публичный API ───────────────────────────────────────────────────────────

/**
 * Запускает одну конкретную CLI-модель надёжным каналом.
 * @param {object} opts
 * @param {string} opts.bin - codex | claude | agy | gemini
 * @param {string} opts.workDir - каталог задачи (воркспейс/cwd для CLI)
 * @param {string} opts.systemText - системная часть промпта
 * @param {string} opts.userText - пользовательская часть промпта (может быть большой)
 * @param {string} [opts.model] - имя модели (опционально)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, text?:string, bin:string, error?:string}>}
 */
export async function runCliModel({ bin, workDir, systemText = '', userText = '', model = null, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId = null, resume = false }) {
    const transport = TRANSPORTS[bin];
    if (!transport) {
        return { ok: false, bin, error: `Неизвестный CLI-бинарник: ${bin}` };
    }

    const tmpDir = resolveTmp(workDir);
    try { await fs.mkdir(tmpDir, { recursive: true }); } catch { /* ignore */ }

    const id = randomUUID();
    const inFile = path.join(tmpDir, `${id}.in.txt`);
    const outFile = path.join(tmpDir, `${id}.out.txt`);
    const combined = systemText ? `${systemText}\n\n${userText}` : userText;
    const filesToClean = [inFile, outFile];

    try {
        let input = null;
        let instruction = null;

        if (transport.mode === 'file_out_instruct' || transport.input_file_prompt) {
            // Полный промпт + указание записать ответ в OUT — в IN-файл.
            let inBody = `${combined}\n\n---\n` +
                `ВАЖНО: Запиши ТОЛЬКО итоговый ответ в файл: ${outFile}\n` +
                `Последней строкой файла добавь маркер: ${SENTINEL}\n` +
                `Не задавай уточняющих вопросов.`;
            if (transport.input_file_prompt) {
                inBody = `${combined}\n\n---\nIMPORTANT: Return only the final answer to stdout. Do not ask questions.`;
            }
            await fs.writeFile(inFile, inBody, 'utf-8');
            // В argv идёт короткая ASCII-инструкция — только пути, без контента.
            instruction = transport.input_file_prompt
                ? `Read task from file: ${inFile} . Return only the final answer to stdout. Do not ask questions.`
                : `Read task from file: ${inFile} . Write only the final answer to file: ${outFile} . End that file with the marker line ${SENTINEL} . Do not ask questions.`;
        } else {
            // Режимы A/C: полный промпт по stdin.
            input = combined;
        }

        const built = transport.build({ model, outFile, workDir, instruction, sessionId, resume });
        const runInput = built.promptVia === 'stdin' ? input : null;

        const res = await spawnCli(bin, built.argv, {
            cwd: built.cwd || workDir,
            input: runInput,
            timeoutMs
        });

        if (res.spawnError) {
            return { ok: false, bin, error: `Не удалось запустить ${bin}: ${stripNoise(res.stderr)}` };
        }
        if (res.timedOut) {
            return { ok: false, bin, error: `Таймаут ${bin} (${timeoutMs} мс)` };
        }

        let text = null;
        if (transport.mode === 'stdout') {
            text = stripNoise(res.stdout);
        } else {
            const expectSentinel = transport.mode === 'file_out_instruct';
            text = await readOutFile(outFile, expectSentinel, true);
        }

        if (!text || text.length === 0) {
            return {
                ok: false,
                bin,
                error: `Пустой ответ от ${bin} (code=${res.code}). stderr: ${stripNoise(res.stderr).slice(0, 200)}`
            };
        }

        return { ok: true, bin, text };
    } catch (err) {
        return { ok: false, bin, error: err.message };
    } finally {
        await cleanup(filesToClean);
    }
}

/**
 * Вызывает внешнего независимого судью ПОСЛЕДОВАТЕЛЬНО по цепочке (first-alive-wins).
 * ИИ-агент НИКОГДА не валидирует собственный результат сам.
 * @param {object} opts
 * @param {string} opts.workDir
 * @param {string} opts.systemText
 * @param {string} opts.userText
 * @param {string[]} [opts.chain] - порядок бинарников (источник истины — judge_chain из llm-config.json)
 * @param {string} [opts.model] - модель для первого бинарника
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, text?:string, bin?:string, error?:string, attempts:Array}>}
 */
export async function callExternalJudge({ workDir, systemText, userText, chain = EMERGENCY_JUDGE_CHAIN, model = null, timeoutMs = null, role = 'judge' }) {
    // Phase-2 wiring: if the caller did not pass an explicit timeout, use the per-role
    // limit from harness.config.json (falls back to DEFAULT_TIMEOUT_MS when config is
    // missing/broken so the pre-phase-2 behavior is preserved).
    if (timeoutMs == null) {
        try {
            const lim = getLimits(role);
            timeoutMs = (lim && Number.isFinite(lim.timeout_ms) && lim.timeout_ms > 0) ? lim.timeout_ms : DEFAULT_TIMEOUT_MS;
        } catch { timeoutMs = DEFAULT_TIMEOUT_MS; }
    }
    // Sequential first-alive-wins: the full prompt goes to ONE judge at a time in
    // chain order; on the first valid verdict we stop. Only one verdict is ever used,
    // so parallel fan-out would just duplicate the prompt tokens across every judge.
    const attempts = [];
    for (const bin of chain) {
        const useModel = (bin === 'agy' || bin === 'gemini') ? model : null;
        let res;
        try {
            res = await runCliModel({ bin, workDir, systemText, userText, model: useModel, timeoutMs });
        } catch (err) {
            attempts.push({ bin, ok: false, error: err.message });
            continue;
        }
        attempts.push({ bin, ok: res.ok, error: res.error || null });
        if (res.ok) {
            return { ok: true, text: res.text, bin, attempts };
        }
    }
    return { ok: false, error: 'Все CLI-судьи недоступны или завершились с ошибкой', attempts };
}

/**
 * Вызывает ОДНОГО конкретного судью (без цепочки/fallback). Используется L3-квoрумом
 * и dual_order-режимом, где selectJudge уже выбрал конкретных судей и мы должны
 * запустить КАЖДОГО из них, а не «первый живой». Возвращает тот же shape, что и
 * runCliModel, плюс поля bin/role для агрегатора.
 * @param {object} opts
 * @param {string} opts.bin
 * @param {string} opts.workDir
 * @param {string} opts.systemText
 * @param {string} opts.userText
 * @param {string|null} [opts.model]
 * @param {number|null} [opts.timeoutMs]
 * @param {string} [opts.role='judge']
 * @returns {Promise<{ok:boolean, text?:string, bin:string, error?:string}>}
 */
export async function callSingleJudge({ workDir, systemText, userText, bin, model = null, timeoutMs = null, role = 'judge' }) {
    if (timeoutMs == null) {
        try {
            const lim = getLimits(role);
            timeoutMs = (lim && Number.isFinite(lim.timeout_ms) && lim.timeout_ms > 0) ? lim.timeout_ms : DEFAULT_TIMEOUT_MS;
        } catch { timeoutMs = DEFAULT_TIMEOUT_MS; }
    }
    const useModel = (bin === 'agy' || bin === 'gemini') ? model : null;
    try {
        return await runCliModel({ bin, workDir, systemText, userText, model: useModel, timeoutMs });
    } catch (err) {
        return { ok: false, bin, error: err.message };
    }
}

/**
 * Проверяет доступность бинарника в PATH (без запуска модели).
 * @param {string} bin
 * @returns {boolean}
 */
export function isBinLikelyAvailable(bin) {
    const pathVar = process.env.PATH || process.env.Path || '';
    const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
    for (const dir of pathVar.split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            if (fssync.existsSync(path.join(dir, bin + ext))) return true;
        }
    }
    return false;
}

// ─── Persistent worker sessions (B1) ─────────────────────────────────────────
// Multi-stage WORKER conversations reuse one CLI session so later turns send only
// a delta prompt instead of re-sending rules/preamble every stage. NOTE: judges
// (callExternalJudge) intentionally do NOT use this — a judge must stay a fresh,
// independent context each time. Registry maps run-id → per-CLI session-id.

// Tier → concrete model (B3). claude uses aliases haiku/sonnet/opus; other CLIs
// fall back to their account default (null) until per-account mapping is set.
// Legacy fallback table kept for backward-compat with the old (bin,tier) space
// (mechanical/standard/deep). Phase-2: the authoritative mapping now comes from
// harness.config.json via resolveModelForBin(bin, tier). The legacy tiers are
// mapped to the config-native ones (cheap/medium/max) before lookup.
export const TIER_MODEL = {
    claude: { mechanical: 'haiku', standard: 'sonnet', deep: 'opus' }
};
const LEGACY_TIER_MAP = { mechanical: 'cheap', standard: 'medium', deep: 'max' };
export function modelForTier(bin, tier) {
    if (!tier) return null;
    const configTier = LEGACY_TIER_MAP[tier] || tier;
    // Config-first (phase 2 wiring); fall back to legacy alias table if config
    // provides no variant for this bin/tier. Never crash on config errors.
    try {
        const fromConfig = resolveModelForBin(bin, configTier);
        if (fromConfig) return fromConfig;
    } catch { /* config path is best-effort — legacy behavior preserved */ }
    return (TIER_MODEL[bin] && TIER_MODEL[bin][tier]) || null;
}
export function estimateTokens(text) {
    return Math.ceil(Buffer.byteLength(String(text || ''), 'utf8') / 3.5);
}

function sessionRegistryPath(taskDir) {
    return path.join(taskDir, '.harness_sessions.json');
}

async function loadSessionRegistry(taskDir) {
    try {
        const raw = await fs.readFile(sessionRegistryPath(taskDir), 'utf-8');
        return JSON.parse(raw.replace(/^﻿/, '')) || { runs: {} };
    } catch {
        return { runs: {} };
    }
}

async function saveSessionRegistry(taskDir, reg) {
    try {
        await fs.writeFile(sessionRegistryPath(taskDir), JSON.stringify(reg, null, 2) + '\n', 'utf-8');
    } catch { /* registry is best-effort */ }
}

/**
 * Один ход многоэтапного воркера с переиспользованием сессии.
 * Первый ход по (runId,bin) создаёт сессию и шлёт полный промпт; последующие
 * возобновляют её и шлют ТОЛЬКО userText (delta) — правила/преамбула уже в контексте.
 * Только claude умеет чистый resume; остальные CLI деградируют к холодному запуску
 * с МИНИМАЛЬНОЙ преамбулой (тяжёлые правила и так лежат на диске в AGENTS.md).
 * @returns {Promise<{ok:boolean, text?:string, bin:string, error?:string, resumed:boolean, sessionId:string|null, delta:boolean}>}
 */
export async function runWorkerTurn({ taskDir, bin, runId = 'default', systemText = '', userText = '', model = null, tier = 'standard', budgetTokens = null, dryRun = false, timeoutMs = null, role = 'worker' }) {
    // Phase-2 wiring: pull per-role limits from harness.config.json when the caller
    // didn't override them explicitly. Config missing/broken → fall back to old
    // hard-coded defaults so nothing regresses.
    let roleLimits = null;
    try { roleLimits = getLimits(role); } catch { /* fallback below */ }
    if (timeoutMs == null) {
        timeoutMs = (roleLimits && Number.isFinite(roleLimits.timeout_ms) && roleLimits.timeout_ms > 0)
            ? roleLimits.timeout_ms : DEFAULT_TIMEOUT_MS;
    }
    if (budgetTokens == null && roleLimits && Number.isFinite(roleLimits.budget_tokens) && roleLimits.budget_tokens > 0) {
        budgetTokens = roleLimits.budget_tokens;
    }
    const reg = await loadSessionRegistry(taskDir);
    reg.runs = reg.runs || {};
    const run = reg.runs[runId] = reg.runs[runId] || { sessions: {} };
    const canResume = bin === 'claude';

    let sessionId = run.sessions[bin] || null;
    let resume = false;
    let sys = systemText;
    let delta = false;

    if (canResume) {
        if (!sessionId) {
            sessionId = randomUUID();          // first turn: create the session
        } else {
            resume = true; sys = ''; delta = true; // later turn: resume + delta only
        }
    } else if (sessionId) {
        sys = ''; delta = true;                // non-resumable: cold + minimal preamble
    }

    // Tiering (B3): explicit model wins, else map the node tier to a model.
    const resolvedModel = model || modelForTier(bin, tier);

    // Hard per-stage budget cap: refuse BEFORE spawning if the prompt already
    // exceeds the budget — abort cleanly, never silently burn tokens.
    const estTokens = estimateTokens((sys ? sys + '\n\n' : '') + userText);
    if (budgetTokens != null && estTokens > budgetTokens) {
        return { ok: false, bin, status: 'BUDGET_EXCEEDED', budgetExceeded: true, estTokens, budgetTokens,
                 error: `BUDGET_EXCEEDED: ~${estTokens} токенов > лимит ${budgetTokens}`, resumed: resume, delta };
    }

    if (dryRun) {
        return { ok: true, dryRun: true, bin, model: resolvedModel, tier, estTokens, resumed: resume, delta,
                 sessionId: canResume ? sessionId : null };
    }

    const res = await runCliModel({
        bin, workDir: taskDir, systemText: sys, userText, model: resolvedModel, timeoutMs,
        sessionId: canResume ? sessionId : null, resume
    });

    if (res.ok) {
        run.sessions[bin] = canResume ? sessionId : 'cold';
        await saveSessionRegistry(taskDir, reg);
    }
    return { ...res, model: resolvedModel, tier, estTokens, resumed: resume, sessionId: canResume ? sessionId : null, delta };
}
