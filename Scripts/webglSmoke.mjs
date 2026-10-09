#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from 'playwright-core';
import { parseUnityLog } from './unityRunner.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function requireValue(value, message) { if (!value) throw new Error(message); }
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const assertion = value => plainObject(value) && Object.keys(value).length > 0;
const hashPattern = /^[a-f0-9]{64}$/i;
async function bounded(promise, timeoutMs, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, timeoutMs)); })]); }
    finally { clearTimeout(timer); }
}

export async function verifyBuildReceipt(receiptPath, expectedReceiptHash) {
    requireValue(typeof receiptPath === 'string' && path.isAbsolute(receiptPath), 'An absolute buildReceiptPath is required');
    const receiptBytes = await fs.readFile(receiptPath);
    const receiptHash = digest(receiptBytes);
    requireValue(expectedReceiptHash === undefined || receiptHash === expectedReceiptHash, 'Build receipt changed during browser verification');
    const receipt = JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/, ''));
    requireValue(receipt.schemaVersion === 1 && typeof receipt.jobId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(receipt.jobId), 'A supported receipt schema and job identity are required');
    requireValue(receipt.ok === true && receipt.status === 'passed' && receipt.operation === 'build' && receipt.editorLaunched === true, 'A successful Unity build receipt is required');
    requireValue(receipt.lockRetained !== true && (receipt.failures === undefined || Array.isArray(receipt.failures) && receipt.failures.length === 0), 'Build receipt contradicts its successful outcome');
    requireValue(receipt.process?.jobId === receipt.jobId && receipt.process.state === 'exited' && receipt.process.processClosed === true && receipt.process.timedOut === false && receipt.process.exitCode === 0 && !receipt.process.signal, 'Build process evidence must show the matching job closed successfully without timeout');
    requireValue(receipt.source?.unchanged === true && hashPattern.test(receipt.source.before?.sha256 ?? '') && receipt.source.before.sha256 === receipt.source.after?.sha256 && Number.isSafeInteger(receipt.source.before.fileCount) && receipt.source.before.fileCount > 0 && receipt.source.before.fileCount === receipt.source.after?.fileCount, 'Build source fingerprint must be unchanged and internally consistent');
    requireValue(receipt.readback?.jobId === receipt.jobId && receipt.readback.operation === 'build' && receipt.readback.success === true && receipt.readback.buildResult === 'Succeeded' && receipt.readback.buildTarget === 'WebGL' && receipt.readback.totalErrors === 0 && receipt.readback.editorVersion === receipt.editorVersion, 'Matching successful WebGL readback evidence is required');
    requireValue(typeof receipt.editorVersion === 'string' && /^\d+\.\d+\.\d+[abfp]\d+$/.test(receipt.editorVersion), 'Exact Editor version evidence is required');
    for (const file of [receipt.jobDirectory, receipt.projectPath, receipt.readback.projectPath, receipt.readback.outputPath]) requireValue(typeof file === 'string' && path.isAbsolute(file), 'Absolute job, project and output paths are required');
    const jobDirectory = await fs.realpath(receipt.jobDirectory);
    requireValue(pathKey(path.dirname(await fs.realpath(receiptPath))) === pathKey(jobDirectory), 'Build receipt must belong to its declared job directory');
    requireValue(pathKey(await fs.realpath(receipt.projectPath)) === pathKey(await fs.realpath(receipt.readback.projectPath)), 'Build readback project identity mismatch');
    const root = await fs.realpath(receipt.readback.outputPath);
    requireValue(inside(pathKey(jobDirectory), pathKey(root)) && pathKey(root) !== pathKey(jobDirectory), 'Build output escaped its job directory');
    requireValue(pathKey(root) === pathKey(receipt.readback.outputPath), 'Build output path redirects');
    requireValue(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, 'Build receipt has no artifact hashes');
    const files = [], content = new Map();
    for (const file of receipt.artifacts) {
        requireValue(plainObject(file) && typeof file.path === 'string' && path.isAbsolute(file.path) && Number.isSafeInteger(file.size) && file.size > 0 && hashPattern.test(file.sha256 ?? ''), 'Every artifact requires an absolute path, nonempty size and SHA-256');
        requireValue(inside(pathKey(jobDirectory), pathKey(file.path)), 'Artifact path is outside the job directory');
        const actualPath = await fs.realpath(file.path);
        requireValue(pathKey(actualPath) === pathKey(file.path) && inside(pathKey(jobDirectory), pathKey(actualPath)), 'Artifact path redirected outside its expected job location');
        requireValue((await fs.stat(actualPath)).isFile(), 'Artifact must be a regular file');
        requireValue(!content.has(pathKey(actualPath)), 'Duplicate artifact path in build receipt');
        const bytes = await fs.readFile(file.path);
        requireValue(bytes.length === file.size && digest(bytes) === file.sha256.toLowerCase(), `Build artifact changed: ${file.path}`);
        content.set(pathKey(actualPath), bytes);
        if (inside(pathKey(root), pathKey(actualPath))) files.push({ ...file, path: actualPath });
    }
    requireValue(files.some(file => pathKey(file.path) === pathKey(path.join(root, 'index.html'))), 'Missing Unity build artifact: root index.html');
    for (const pattern of [/\.loader\.js$/, /\.framework\.js(?:\.gz|\.br|\.unityweb)?$/, /\.wasm(?:\.gz|\.br|\.unityweb)?$/, /\.data(?:\.gz|\.br|\.unityweb)?$/]) {
        requireValue(files.some(file => pattern.test(file.path)), `Missing Unity build artifact: ${pattern}`);
    }
    const logBytes = content.get(pathKey(path.join(jobDirectory, 'Editor.log')));
    const readbackBytes = content.get(pathKey(path.join(jobDirectory, 'readback.json')));
    requireValue(logBytes && readbackBytes, 'Hashed Editor log and readback evidence are required');
    const log = parseUnityLog(logBytes.toString('utf8'));
    requireValue(log.present && log.errorCount === 0 && logBytes.toString('utf8').includes(`HARNESS_UNITY_COMPLETED:${receipt.jobId}:build`), 'Editor log contradicts successful build evidence');
    requireValue(isDeepStrictEqual(JSON.parse(readbackBytes.toString('utf8').replace(/^\uFEFF/, '')), receipt.readback), 'Hashed readback evidence contradicts the receipt readback');
    return { root, files, content, jobDirectory, bytes: files.reduce((sum, file) => sum + file.size, 0), jobId: receipt.jobId, receiptHash };
}

export async function runWebglSmoke(request) {
    requireValue(request && Number.isSafeInteger(request.timeoutMs) && request.timeoutMs >= 1000 && request.timeoutMs <= 300000, 'Explicit timeoutMs between 1000 and 300000 is required');
    requireValue(typeof request.stateGlobal === 'string' && /^[A-Za-z_$][\w$]*$/.test(request.stateGlobal), 'stateGlobal must name an observable Unity-to-JavaScript state object');
    requireValue(Array.isArray(request.steps) && request.steps.length > 0 && request.steps.length <= 20, 'At least one real input/assertion step is required');
    for (const step of request.steps) {
        requireValue(plainObject(step) && ['click', 'key'].includes(step.type) && assertion(step.expected), 'Each input step requires a plain expected-state object');
        if (step.type === 'key') requireValue(typeof step.key === 'string' && step.key.length > 0 && step.key.length <= 100 && !/[\r\n\0]/.test(step.key), 'Each key step requires a key string');
        if (step.type === 'click') {
            requireValue(step.selector === undefined || typeof step.selector === 'string' && step.selector.length > 0 && step.selector.length <= 1000, 'Click step selector must be a nonempty string');
            if (step.position !== undefined) requireValue(plainObject(step.position) && Number.isFinite(step.position.x) && Number.isFinite(step.position.y) && step.position.x >= 0 && step.position.y >= 0, 'Click step position must contain finite nonnegative x/y coordinates');
        }
    }
    requireValue(assertion(request.initial), 'Initial ready-state assertions require a nonempty plain object');
    requireValue(request.reloadExpected === undefined || assertion(request.reloadExpected), 'Reload expected state must be a nonempty plain object');
    requireValue(request.stateGlobal !== '__harnessWasmInstances', 'stateGlobal conflicts with runtime instrumentation');
    const startedAt = Date.now();
    const deadlineAt = startedAt + request.timeoutMs;
    const remaining = () => { const budget = deadlineAt - Date.now(); requireValue(budget > 0, 'WebGL smoke deadline exhausted'); return budget; };
    const withinDeadline = (action, label) => { const budget = remaining(); return bounded(action(), budget, label); };
    const build = await withinDeadline(() => verifyBuildReceipt(request.buildReceiptPath), 'Build evidence verification');
    requireValue(typeof request.browserExecutable === 'string' && path.isAbsolute(request.browserExecutable) && hashPattern.test(request.browserSha256 || ''), 'Browser executable and SHA-256 pin are required');
    requireValue(digest(await withinDeadline(() => fs.readFile(request.browserExecutable), 'Browser executable verification')) === request.browserSha256.toLowerCase(), 'Browser executable pin mismatch');
    const browserRoot = path.join(build.jobDirectory, 'browser');
    await fs.mkdir(browserRoot, { recursive: true });
    requireValue(pathKey(await fs.realpath(browserRoot)) === pathKey(browserRoot), 'Browser output directory redirects outside its expected job location');
    const jobDirectory = path.join(browserRoot, randomUUID());
    await fs.mkdir(jobDirectory);
    requireValue(pathKey(await fs.realpath(jobDirectory)) === pathKey(jobDirectory), 'Browser job directory redirects');
    await fs.writeFile(path.join(jobDirectory, 'request.json'), JSON.stringify(request, null, 2), { flag: 'wx' });
    const result = { ok: false, kind: 'unity-webgl-behavior', buildJobId: build.jobId, buildReceiptSha256: build.receiptHash, browserExecutable: request.browserExecutable, browserSha256: request.browserSha256, jobDirectory, assertions: [], errors: [], requests: [], metrics: {}, platformAcceptance: 'unverified' };
    let browser, browserServer, context;
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.css': 'text/css', '.png': 'image/png' };
    const server = http.createServer((req, res) => {
        try {
            requireValue(req.method === 'GET' || req.method === 'HEAD', 'Unsupported HTTP method');
            const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
            const file = path.resolve(build.root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
            requireValue(inside(pathKey(build.root), pathKey(file)), 'Path outside build');
            const verifiedBytes = build.content.get(pathKey(file));
            requireValue(verifiedBytes, 'File is not in the build receipt');
            const encoding = file.endsWith('.br') ? 'br' : file.endsWith('.gz') ? 'gzip' : null;
            res.setHeader('Content-Type', mime[path.extname(file.replace(/\.(br|gz)$/, ''))] || 'application/octet-stream');
            if (encoding) res.setHeader('Content-Encoding', encoding);
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cache-Control', 'no-store');
            // Serve the captured verified bytes, never a file changed between integrity checks.
            res.end(req.method === 'HEAD' ? undefined : verifiedBytes);
        } catch { res.writeHead(404); res.end(); }
    });
    server.on('error', error => { result.errors.push(`HTTP server: ${error.message}`); });
    try {
        await withinDeadline(() => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'HTTP server startup');
        const origin = `http://127.0.0.1:${server.address().port}`;
        // launchServer exposes our owned browser process for bounded, accountable cleanup.
        // Its own timeout covers launch before the whole-session deadline race below starts.
        browserServer = await chromium.launchServer({ executablePath: request.browserExecutable, headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout: remaining() });
        result.browserProcess = { pid: browserServer.process().pid, exitConfirmed: false };
        const sessionBudget = remaining();
        await bounded((async () => {
        browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: remaining() });
        result.browserVersion = browser.version();
        context = await browser.newContext({ viewport: { width: 960, height: 600 }, serviceWorkers: 'block' });
        context.setDefaultTimeout(remaining());
        await context.route('**/*', async route => {
            try {
                const url = new URL(route.request().url());
                if (url.origin !== origin) { result.errors.push(`External request blocked: ${url.origin}`); await route.abort(); return; }
                await route.continue();
            } catch (error) { result.errors.push(`Route: ${error.message}`); await route.abort().catch(() => {}); }
        });
        await context.addInitScript(() => {
            let instances = 0;
            Object.defineProperty(window, '__harnessWasmInstances', { configurable: false, get: () => instances });
            for (const key of ['instantiate', 'instantiateStreaming']) {
                const original = WebAssembly[key];
                if (!original) continue;
                WebAssembly[key] = async function(...args) {
                    const instance = await original.apply(this, args);
                    if (instance instanceof WebAssembly.Instance || instance?.instance instanceof WebAssembly.Instance) instances++;
                    return instance;
                };
            }
        });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const page = await context.newPage();
        page.on('pageerror', error => result.errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
        page.on('requestfailed', req => result.errors.push(`${req.url()}: ${req.failure()?.errorText}`));
        page.on('response', response => { result.requests.push({ url: response.url(), status: response.status() }); if (response.status() >= 400) result.errors.push(`HTTP ${response.status()}: ${response.url()}`); });
        const assertState = async expected => {
            await page.waitForFunction(({name, values}) => {
                const state = window[name];
                return !!state && Object.entries(values).every(([key, value]) => Object.hasOwn(state, key) && JSON.stringify(state[key]) === JSON.stringify(value));
            }, { name: request.stateGlobal, values: expected }, { timeout: remaining() });
            const observed = await page.evaluate(name => window[name], request.stateGlobal);
            result.assertions.push({ expected, observed });
        };
        const started = Date.now();
        await page.goto(origin, { waitUntil: 'load', timeout: remaining() });
        await assertState(request.initial);
        result.metrics.loadMs = Date.now() - started;
        requireValue(await page.evaluate(() => window.__harnessWasmInstances > 0), 'No real WebAssembly instance was observed');
        for (const step of request.steps) {
            const alreadyExpected = await page.evaluate(({name, expected}) => {
                const state = window[name];
                return !!state && Object.entries(expected).every(([key, value]) => Object.hasOwn(state, key) && JSON.stringify(state[key]) === JSON.stringify(value));
            }, { name: request.stateGlobal, expected: step.expected });
            requireValue(!alreadyExpected, 'Input step expected state already held before input; no observable transition would be proved');
            if (step.type === 'click') await page.locator(step.selector || '#unity-canvas').click({ ...(step.position ? { position: step.position } : {}), timeout: remaining() });
            else { remaining(); await page.keyboard.press(step.key); }
            await assertState(step.expected);
        }
        if (request.reloadExpected) {
            await page.reload({ waitUntil: 'load', timeout: remaining() });
            await assertState(request.reloadExpected);
            requireValue(await page.evaluate(() => window.__harnessWasmInstances > 0), 'No real WebAssembly instance was observed after reload');
        }
        requireValue(result.requests.some(req => req.status >= 200 && req.status < 300 && /\.wasm(?:[.?]|$)/.test(req.url)) && result.requests.some(req => req.status >= 200 && req.status < 300 && /\.data(?:[.?]|$)/.test(req.url)), 'Unity WASM/data were not successfully loaded');
        result.metrics.buildBytes = build.bytes;
        result.metrics.jsHeapBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
        result.metrics.note = 'Load and JavaScript heap observations only; this is not Unity FPS, total browser memory, device or performance certification.';
        await page.screenshot({ path: path.join(jobDirectory, 'player.png'), timeout: remaining() });
        await verifyBuildReceipt(request.buildReceiptPath, build.receiptHash);
        requireValue(result.errors.length === 0, 'Browser console/network errors occurred');
        })(), sessionBudget, 'WebGL smoke session');
        result.ok = true;
    } catch (error) { result.errors.push(error.message); }
    finally {
        const cleanupDeadline = Date.now() + 20_000;
        const cleanup = async (label, action, cap) => {
            try { await bounded(action(), Math.min(cap, Math.max(1, cleanupDeadline - Date.now())), label); return true; }
            catch (error) { result.ok = false; result.errors.push(error.message); return false; }
        };
        if (context) await cleanup('Trace cleanup', () => context.tracing.stop({ path: path.join(jobDirectory, 'trace.zip') }), 4000);
        // Close player contexts and disconnect the RPC client before stopping its
        // server; otherwise live renderer sessions can delay graceful shutdown.
        if (context) await cleanup('Browser context cleanup', () => context.close(), 5000);
        if (browser) await cleanup('Browser connection cleanup', () => browser.close(), 2000);
        if (browserServer) {
            const closed = await cleanup('Browser cleanup', () => browserServer.close(), 6000);
            if (!closed) await cleanup('Owned browser termination', () => browserServer.kill(), 2000);
            const owned = browserServer.process();
            if (owned.exitCode === null && owned.signalCode === null) {
                // Only this invocation's owned handle; never a persisted or discovered PID.
                try { owned.kill('SIGKILL'); owned.unref(); }
                catch (error) { result.errors.push(`Owned browser termination: ${error.message}`); }
                result.errors.push('Browser process exit remains unverified after bounded cleanup');
            }
            result.browserProcess.exitConfirmed = owned.exitCode !== null || owned.signalCode !== null;
        }
        if (server.listening) await cleanup('HTTP server cleanup', () => new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections?.();
        }), 1000);
        result.metrics.totalMs = Date.now() - startedAt;
        result.ok = result.ok && result.errors.length === 0 && result.browserProcess?.exitConfirmed === true;
        await fs.writeFile(path.join(jobDirectory, 'result.json'), JSON.stringify(result, null, 2));
    }
    return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    try {
        requireValue(process.argv.length === 3 && path.isAbsolute(process.argv[2]), 'Usage: node webglSmoke.mjs <absolute-request.json>');
        const result = await runWebglSmoke(JSON.parse(await fs.readFile(process.argv[2], 'utf8')));
        console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
    } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 2; }
}
