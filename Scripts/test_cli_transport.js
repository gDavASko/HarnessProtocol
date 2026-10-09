// Hermetic transport regression: real local Node fixture, never provider CLIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCliModel } from './cliTransport.js';
import { createModelTestHarness } from './modelPolicy.js';

process.env.HARNESS_OFFLINE = '1';
const fixture = fileURLToPath(new URL('./fixtures/model-policy-cli.mjs', import.meta.url));
const huge = 'diff --git a/file b/file\n+PAYLOAD_ONLY_4A23\n' + 'x'.repeat(400000);
const systemText = 'Return a payload delivery receipt.';
const userText = `Оцени изменения:\n${huge}`;
const combined = `${systemText}\n\n${userText}`;

for (const bin of ['codex', 'agy']) {
    test(`${bin}: all 400 KB arrive through ${bin === 'codex' ? 'stdin' : 'file'}, never argv`, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-transport-test-'));
        t.after(async () => {
            if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('harness-transport-test-')) throw new Error('unsafe test cleanup');
            await fs.rm(root, { recursive: true, force: true });
        });
        const studioProfile = path.join(root, 'policy.json');
        await fs.writeFile(studioProfile, JSON.stringify({
            kind: 'harness-model-policy', schema_version: 1,
            id: 'offline-transport-fixture', authorization_reference: 'fixture-only',
            allowed: [{ provider: bin, model: 'fixture-model', role: 'judge', effort: 'default' }],
            limits: { max_calls: 1, max_output_tokens: 1024, output_tokens_per_call: 1024, max_elapsed_ms: 15000, call_timeout_ms: 6000 }
        }));
        let dispatched = 0;
        const testHarness = createModelTestHarness({
            cli({ argv, input }) {
                dispatched += 1;
                assert.ok(argv.every(arg => !arg.includes('PAYLOAD_ONLY_4A23')));
                assert.ok(Buffer.byteLength(argv.join('\0'), 'utf8') < 4096);
                assert.equal(input, bin === 'codex' ? combined : null);
                return spawn(process.execPath, [fixture, 'receipt', bin, ...argv], {
                    windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe'
                });
            }
        });
        const result = await runCliModel({
            bin, workDir: root, systemText, userText, model: 'fixture-model', role: 'judge',
            studioProfile, runDir: root, runId: 'large-payload', testHarness
        });
        assert.equal(result.ok, true, result.error);
        assert.equal(dispatched, 1, 'a refusal or skipped executable must never pass this regression');
        const receipt = JSON.parse(result.text);
        const expected = bin === 'codex' ? combined
            : `${combined}\n\n---\nIMPORTANT: Return only the final answer to stdout. Do not ask questions.`;
        assert.equal(receipt.channel, bin === 'codex' ? 'stdin' : 'file');
        assert.equal(receipt.inputBytes, Buffer.byteLength(expected, 'utf8'));
        assert.ok(receipt.inputBytes >= 400000);
        assert.equal(receipt.inputSha256, createHash('sha256').update(expected).digest('hex'));
        assert.equal(receipt.stdinBytes, bin === 'codex' ? Buffer.byteLength(combined, 'utf8') : 0);
        assert.ok(receipt.argvBytes < 4096);
        assert.ok(receipt.maxArgBytes < 2048);
        const budgetDir = path.join(root, '.harness', 'model-budgets');
        const ledgerName = (await fs.readdir(budgetDir)).find(name => name.endsWith('.json'));
        const ledger = JSON.parse(await fs.readFile(path.join(budgetDir, ledgerName), 'utf8'));
        assert.equal(ledger.calls, 1);
        assert.equal(ledger.reservedOutputTokens, 1024);
        assert.deepEqual(await fs.readdir(path.join(root, '.harness_tmp')), []);
    });
}
