#!/usr/bin/env node
// Парсер результатов Unity Test Framework (NUnit3 XML) для рунга `tests` лестницы
// доказательств. Читает results.xml, печатает сводку и ВЫХОДИТ С НЕНУЛЕВЫМ кодом,
// если хоть один тест провален/не Passed — так рунг `tests` становится честным
// детерминированным оракулом для Unity behavioral-узлов.
//
// Использование: node parseUnityTestResults.mjs <results.xml>
import fs from 'fs';

const file = process.argv[2];
if (!file) {
    console.error(JSON.stringify({ error: 'Использование: node parseUnityTestResults.mjs <results.xml>' }));
    process.exit(2);
}

let xml;
try {
    xml = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
} catch (err) {
    console.error(JSON.stringify({ error: `Не удалось прочитать ${file}: ${err.message}` }));
    process.exit(2);
}

// NUnit3: <test-run result="Passed" total="N" passed="N" failed="0" ...>
const attr = (name) => {
    const m = xml.match(new RegExp(`<test-run\\b[^>]*\\b${name}="([^"]*)"`, 'i'));
    return m ? m[1] : null;
};
const result = attr('result');
const total = parseInt(attr('total') || '0', 10);
const passed = parseInt(attr('passed') || '0', 10);
const failed = parseInt(attr('failed') || '0', 10);
const skipped = parseInt(attr('skipped') || '0', 10);

// Фолбэк, если атрибута failed нет: считаем <test-case ... result="Failed">.
const failedCases = (xml.match(/<test-case\b[^>]*\bresult="Failed"/gi) || []).length;
const effectiveFailed = Number.isFinite(failed) && failed >= 0 ? Math.max(failed, failedCases) : failedCases;

const ok = (result ? /^passed$/i.test(result) : true) && effectiveFailed === 0 && total > 0;

console.log(JSON.stringify({
    result: result || 'unknown', total, passed, failed: effectiveFailed, skipped,
    ok, message: ok ? `Все ${total} тестов Unity прошли.` : `Unity-тесты не зелёные: failed=${effectiveFailed}, result=${result}.`
}, null, 2));

process.exit(ok ? 0 : 1);
