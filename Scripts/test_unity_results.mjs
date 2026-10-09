import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const parser = fileURLToPath(new URL('./parseUnityTestResults.mjs', import.meta.url));
const good = '<test-run result="Passed" total="2" passed="2" failed="0"><test-suite result="Passed"><test-case name="input" result="Passed"/><test-case name="save" result="Passed"/></test-suite></test-run>';

function run(xml, args = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-unity-xml-'));
    try {
        const file = path.join(dir, 'results.xml');
        fs.writeFileSync(file, xml);
        const result = spawnSync(process.execPath, [parser, file, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        return { status: result.status, data: JSON.parse(result.stdout || result.stderr) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('accepts complete NUnit results with actual passing test cases', () => {
    const result = run(good);
    assert.equal(result.status, 0);
    assert.equal(result.data.ok, true);
});

for (const [name, xml] of [
    ['truncated XML', '<test-run result="Passed" total="3" passed="3" failed="0">'],
    ['missing verdict and skipped tests', '<test-run total="3" passed="0" skipped="3"></test-run>'],
    ['invented passing summary without cases', '<test-run result="Passed" total="3" passed="3" failed="0"/>'],
    ['zero discovered tests', '<test-run result="Passed" total="0" passed="0" failed="0"/>'],
    ['mismatching count', good.replace('total="2"', 'total="20"')],
    ['invalid numeric count', good.replace('total="2"', 'total="2garbage"')],
    ['failing case hidden by passing summary', good.replace('name="save" result="Passed"', 'name="save" result="Failed"')],
    ['failing suite hidden by passing summary', good.replace('<test-suite result="Passed">', '<test-suite result="Failed">')],
    ['skipped case hidden by passing summary', good.replace('name="save" result="Passed"', 'name="save" result="Skipped"')],
    ['duplicate roots', good + good],
    ['nested test cases', '<test-run result="Passed" total="2" passed="2" failed="0"><test-case result="Passed"><test-case result="Passed"/></test-case></test-run>'],
    ['DTD', '<!DOCTYPE test-run [<!ENTITY x "test">]>' + good],
]) {
    test(`rejects ${name}`, () => {
        const result = run(xml);
        assert.notEqual(result.status, 0);
        assert.equal(result.data.ok, false);
    });
}

test('supports XML declarations, comments, CDATA and single-quoted attributes', () => {
    const xml = '<?xml version="1.0"?><!-- test-run result="Failed" -->' + good.replaceAll('"', "'").replace('</test-suite>', '<output><![CDATA[<test-case result="Failed"/>]]></output></test-suite>');
    assert.equal(run(xml).status, 0);
});

test('requires the expected discovered count when supplied', () => {
    assert.equal(run(good, ['--expected-count', '2']).status, 0);
    assert.notEqual(run(good, ['--expected-count', '3']).status, 0);
    assert.notEqual(run(good, ['--expected-count', '0']).status, 0);
});
