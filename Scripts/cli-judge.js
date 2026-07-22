import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { callExternalJudge } from './cliTransport.js';
import { getAvailableJudgeChain, probeSummary, familyOf, liveJudgesFromProbe } from './aiProbe.js';
import { selectJudge, toFamily } from './judgeSelector.js';
import { findRepoRoot } from './harnessPaths.js';

// ─── Ручной внешний ИИ-судья ─────────────────────────────────────────────────
// Запускает НЕЗАВИСИМОГО внешнего ИИ (другой CLI) для объективной оценки файла.
// Контент файла передаётся судье через файл/stdin внутри cliTransport, а НЕ через
// argv — поэтому большие файлы/диффы не вызывают ENAMETOOLONG.
//
// Использование:
//   node cli-judge.js --file <path> [--prompt "..."] [--workdir <dir>] [--tier <1|2|3>]

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {
        file: null,
        prompt: 'Дай объективную, честную, жёсткую оценку. Что не так и что можно улучшить.',
        workdir: null,
        tier: 3,
        workerFamily: null
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) parsed.file = args[++i];
        else if (args[i] === '--prompt' && args[i + 1]) parsed.prompt = args[++i];
        else if (args[i] === '--workdir' && args[i + 1]) parsed.workdir = args[++i];
        else if (args[i] === '--tier' && args[i + 1]) parsed.tier = parseInt(args[++i], 10);
        else if (args[i] === '--worker-family' && args[i + 1]) parsed.workerFamily = args[++i].toLowerCase();
    }
    return parsed;
}

async function main() {
    const args = parseArgs();

    if (args.tier === 1) {
        console.log(`\n✅ УСПЕХ (Tier 1):\nВнешний судья пропущен. Ожидается только локальная валидация линтером и компилятором.\n`);
        process.exit(0);
    }

    if (!args.file || !fs.existsSync(args.file)) {
        console.error('❌ Ошибка: файл не указан или не существует (--file).');
        process.exit(1);
    }

    const workDir = args.workdir || findRepoRoot();
    let fileContent = '';
    let systemText = 'Ты — независимый внешний рецензент. Оцени материал строго и по существу. Никаких лишних действий, оценивай только то, о чем спрашивают.';
    let prompt = args.prompt;

    if (args.tier === 2) {
        try {
            const diff = execSync('git diff HEAD', { cwd: workDir, encoding: 'utf-8' });
            fileContent = diff.trim() ? diff : 'Нет изменений в git (возможно, файлы не добавлены или коммит уже сделан). Оцени локальный контекст задачи: ' + fs.readFileSync(args.file, 'utf-8').replace(/^﻿/, '');
        } catch (e) {
            fileContent = fs.readFileSync(args.file, 'utf-8').replace(/^﻿/, '');
        }
        systemText = 'Ты — быстрый внешний рецензент (Tier 2). Оцени предоставленный diff. Проверь базовую корректность, отсутствие очевидных багов. Не придирайся к архитектуре, если локальный контекст работает.';
        prompt = 'Оцени этот git diff:\n' + prompt;
    } else {
        fileContent = fs.readFileSync(args.file, 'utf-8').replace(/^﻿/, '');
    }

    // Phase-2 wiring: dispatch judges via judgeSelector using LIVE judges from the
    // aiProbe cache. UNVALIDATED must never PASS. Independence is guaranteed by
    // SESSION ISOLATION (fresh-context subagent), not by family difference — a
    // same-family isolated judge is valid; cross-family is preferred, not required.
    const workerFam = toFamily(args.workerFamily);
    const { chain, model, probe, fallback, live_judges = [] } = await getAvailableJudgeChain();
    // Map tier (1..3) to a criticality level for the selector calculus.
    const critMap = { 1: 'L0', 2: 'L1', 3: 'L2' };
    const criticality = critMap[args.tier] || 'L2';
    const sel = selectJudge({
        worker_family: args.workerFamily,
        artifact_kind: 'code',
        criticality,
        live_judges: live_judges.length > 0 ? live_judges : [{ id: 'claude-subagent', family: 'anthropic' }]
    });

    if (sel.decision === 'oracle_only') {
        console.log('\n✅ УСПЕХ (Tier 1 / L0): deterministic oracle only. LLM judge skipped.');
        process.exit(0);
    }
    if (sel.decision === 'UNVALIDATED') {
        console.log(`🚨 НЕТ ДОСТУПНЫХ ВНЕШНИХ CLI-СУДЕЙ (preflight): ${probeSummary(probe)}`);
        console.log(`🛑 UNVALIDATED: ${sel.reason}`);
        process.exit(3);
    }

    const chosenIds = sel.judges.map(j => j.id);
    if (chosenIds.every(id => id === 'claude-subagent')) {
        console.log(`🚨 НЕТ ДОСТУПНЫХ ВНЕШНИХ CLI-СУДЕЙ (preflight): ${probeSummary(probe)}`);
        console.log(`➡️ Fallback: используй НЕЗАВИСИМОГО субагента со СВЕЖИМ контекстом как судью. ${sel.reason}`);
        process.exit(2);
    }
    const strictChain = chosenIds.filter(id => id !== 'claude-subagent');

    if (fallback || strictChain.length === 0) {
        console.log(`🚨 НЕТ ДОСТУПНЫХ ВНЕШНИХ CLI-СУДЕЙ (preflight): ${probeSummary(probe)}`);
        console.log('🛑 UNVALIDATED: selector дал пустую CLI-цепочку.');
        process.exit(3);
    }

    const hasSameFamily = strictChain.some(bin => familyOf(bin) === workerFam);
    const desc = hasSameFamily ? 'цепочка с резервом того же семейства' : 'кросс-семейная цепочка';
    console.log(`🤖 Внешний судья (selector: ${sel.mode}). Живая ${desc} CLI: [${strictChain.join(' → ')}]...`);

    const judged = await callExternalJudge({
        workDir,
        systemText,
        userText: `${prompt}\n\n===== МАТЕРИАЛ =====\n${fileContent}`,
        chain: strictChain,
        model: args.tier === 2 ? null : model, // For tier 2 we let cliTransport pick default or fast model if implemented, here we just don't force slow model
        timeoutMs: 90000
    });

    if (judged.ok) {
        console.log(`\n✅ УСПЕХ (${judged.bin}):\n`);
        console.log(judged.text);
        process.exit(0);
    }

    const tried = (judged.attempts || []).map(a => `${a.bin}: ${a.error}`).join(' | ');
    console.log(`\n🚨 ВНЕШНИЙ СУДЬЯ НЕДОСТУПЕН. Попытки: ${tried}`);
    console.log('⚠️ Самовалидация запрещена. Повторите позже или подключите доступный CLI-ИИ.');
    process.exit(1);
}

main().catch(err => {
    console.error(`❌ Непредвиденная ошибка cli-judge: ${err.message}`);
    process.exit(1);
});
