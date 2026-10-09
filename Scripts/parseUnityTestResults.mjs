#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';

// A summary is not proof: require a complete document and matching leaf results.
export function parseUnityTestResults(xml, { expectedCount } = {}) {
    try {
        if (typeof xml !== 'string' || Buffer.byteLength(xml) > 64 * 1024 * 1024) throw new Error('Invalid or oversized XML report');
        if (expectedCount !== undefined && (!Number.isSafeInteger(expectedCount) || expectedCount < 1)) throw new Error('expectedCount must be a positive integer');
        let root;
        let depth = 0;
        let caseDepth = null;
        const cases = [];
        const parser = new SaxesParser();
        parser.on('doctype', () => { throw new Error('DOCTYPE is not allowed in test reports'); });
        parser.on('opentag', tag => {
            if (depth++ === 0) {
                if (tag.name !== 'test-run') throw new Error('Expected NUnit3 test-run root');
                root = tag.attributes;
            } else if (tag.name === 'test-run') throw new Error('Nested test-run is not allowed');
            if (tag.name === 'test-case') {
                if (caseDepth !== null) throw new Error('Nested test-case is not a leaf test result');
                caseDepth = depth;
                cases.push(tag.attributes.result);
            }
            if (tag.name === 'test-suite' && tag.attributes.result && tag.attributes.result !== 'Passed') throw new Error('A test suite did not pass');
        });
        parser.on('closetag', () => { if (depth === caseDepth) caseDepth = null; depth--; });
        parser.write(xml.replace(/^\uFEFF/, '')).close();
        if (!root) throw new Error('Missing test-run');
        const count = (key, optional = false) => {
            const value = root[key];
            if (value === undefined && optional) return 0;
            if (!/^(0|[1-9]\d*)$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid or missing ${key} count`);
            return Number(value);
        };
        const total = count('total');
        const passed = count('passed');
        const failed = count('failed');
        const skipped = count('skipped', true);
        const inconclusive = count('inconclusive', true);
        const ok = root.result === 'Passed' && total > 0 && passed === total && failed === 0 && skipped === 0 && inconclusive === 0
            && cases.length === total && cases.every(result => result === 'Passed')
            && (expectedCount === undefined || total === expectedCount);
        return { result: root.result || 'unknown', total, passed, failed, skipped, inconclusive, cases: cases.length, ok,
            message: ok ? `All ${total} Unity tests passed.` : 'Unity report has missing, non-passing, or inconsistent results.' };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    try {
        const [file, flag, value, ...extra] = process.argv.slice(2);
        if (!file || (flag && (flag !== '--expected-count' || !/^[1-9]\d*$/.test(value || ''))) || extra.length) throw new Error('Usage: node parseUnityTestResults.mjs results.xml [--expected-count N]');
        if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('XML report exceeds 64 MiB');
        const result = parseUnityTestResults(fs.readFileSync(file, 'utf8'), { expectedCount: value ? Number(value) : undefined });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
        console.error(JSON.stringify({ ok: false, error: error.message }));
        process.exitCode = 2;
    }
}
