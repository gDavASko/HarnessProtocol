import { runCliModel, isBinLikelyAvailable } from './cliTransport.js';
import { findRepoRoot } from './harnessPaths.js';

// ─── Регрессионный тест надёжности CLI-транспорта ────────────────────────────
// Главная цель: доказать, что БОЛЬШОЙ payload (имитация git diff) НЕ вызывает
// ENAMETOOLONG — потому что контент идёт в файл/stdin, а не в argv.
// Тест НЕ проверяет качество ответа модели; короткий таймаут гасит реальный CLI.

const HUGE = 'diff --git a/file b/file\n+' + 'x'.repeat(400000); // ~400 КБ
const workDir = findRepoRoot();
const TIMEOUT = 6000;

async function testBin(bin) {
    if (!isBinLikelyAvailable(bin)) {
        console.log(`  ⏭️  ${bin}: не установлен, пропуск (не влияет на регрессию argv).`);
        return true;
    }
    try {
        const res = await runCliModel({
            bin,
            workDir,
            systemText: 'Ты судья. Верни JSON {"pass":true}.',
            userText: `Оцени изменения:\n${HUGE}`,
            timeoutMs: TIMEOUT
        });
        // Структурированный результат без выброса — уже успех транспорта.
        const err = (res.error || '').toUpperCase();
        if (err.includes('ENAMETOOLONG') || err.includes('E2BIG')) {
            console.error(`  ❌ ${bin}: payload утёк в argv → ${res.error}`);
            return false;
        }
        console.log(`  ✅ ${bin}: транспорт устойчив (ok=${res.ok}${res.ok ? '' : `, graceful: ${(res.error || '').slice(0, 60)}`}).`);
        return true;
    } catch (e) {
        const msg = String(e.message || e).toUpperCase();
        if (msg.includes('ENAMETOOLONG') || msg.includes('E2BIG')) {
            console.error(`  ❌ ${bin}: исключение ENAMETOOLONG — ${e.message}`);
            return false;
        }
        console.error(`  ❌ ${bin}: неожиданное исключение — ${e.message}`);
        return false;
    }
}

async function main() {
    console.log('=== Регрессия CLI-транспорта: большой payload не должен вызывать ENAMETOOLONG ===');
    let ok = true;
    // codex — режим A (stdin + файл-вывод); agy — режим B (payload в IN-файле).
    ok = (await testBin('codex')) && ok;
    ok = (await testBin('agy')) && ok;

    if (ok) {
        console.log('\n=== PASS: контент не попадает в argv, ENAMETOOLONG исключён. ===');
        process.exit(0);
    }
    console.error('\n=== FAIL: транспорт пропустил контент в argv. ===');
    process.exit(1);
}

main().catch(err => {
    console.error('Непредвиденная ошибка теста транспорта:', err);
    process.exit(1);
});
