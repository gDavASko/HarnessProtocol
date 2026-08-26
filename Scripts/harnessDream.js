import fs from 'fs/promises';
import path from 'path';
import { readRoadmap } from './harnessState.js';
import { readReceipts } from './evidenceLadder.js';

// ─── harness_dream: самоулучшение ПРОЦЕССА (идея из thu-nmrc/OpenHarness) ─────
// SkillDistiller учится на УСПЕХАХ (L3). Этот проход учится на ПРОВАЛАХ: офлайн
// сканирует накопленные фейлы (история узлов + проваленные рунги), кластеризует
// повторяющиеся паттерны и синтезирует «уроки» — анти-паттерны с предложением
// ratchet-меры. Уроки копятся в <taskDir>/harness_lessons.md (append, dedup) и
// могут подниматься в глобальную память ТОЛЬКО человеком (Human Gate), как L3.
//
// CLI: node harnessDream.js <taskDir> [--min 2] [--global memory/harness_lessons.md]

/**
 * Нормализует текст ошибки в сигнатуру, чтобы разные конкретные фейлы одного
 * класса схлопывались в один паттерн: числа/пути/кавычки/хэши → плейсхолдеры.
 */
export function signature(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[a-z]:\\[^\s"']+|\/[^\s"':]+\/[^\s"':]+/g, '<path>')
        .replace(/["'][^"']*["']/g, '<str>')
        .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
}

/** Собирает все провалы из роадмапа и рецептов рунгов. */
export function extractFailures(roadmap, receipts = {}) {
    const failures = [];
    for (const node of roadmap.nodes || []) {
        for (const h of node.history || []) {
            if (/FAIL/i.test(h.result) && h.detail) {
                failures.push({ source: `node:${node.id}`, detail: h.detail });
            }
        }
        if (node.last_error) failures.push({ source: `node:${node.id}:last_error`, detail: node.last_error });
    }
    for (const [nodeId, rec] of Object.entries(receipts)) {
        for (const [rung, r] of Object.entries(rec.rungs || {})) {
            if (r && (r.result === 'FAIL' || r.result === 'TRIVIAL') && r.detail) {
                failures.push({ source: `rung:${nodeId}:${rung}`, detail: r.detail });
            }
        }
    }
    return failures;
}

const SUGGESTIONS = [
    { re: /trivial|no-op|node -e|echo/i, tip: 'Требовать реальный оракул, прогоняющий deliverables (анти-фейк уже активен).' },
    { re: /security|secret|token|password|auth/i, tip: 'Добавить security-рунг/секрет-скан как fence в шаблон узла этого класса.' },
    { re: /compile|typecheck|syntax|error cs|cannot find|is not defined/i, tip: 'Добавить обязательный compile-рунг раньше в цикл (verify-before-build).' },
    { re: /test|assert|expect|dod/i, tip: 'Зафиксировать провал как новый критерий DoD + защищающий тест (ratchet).' },
    { re: /timeout|econnrefused|enoent|network|api/i, tip: 'Обернуть внешний вызов в fallback/ретрай; не блокировать прогон на нём.' }
];
function suggestFor(sig) {
    const hit = SUGGESTIONS.find(s => s.re.test(sig));
    return hit ? hit.tip : 'Повторяющийся класс провалов — добавить целевой fence или под-узел в шаблон.';
}

/** Кластеризует провалы по сигнатуре; возвращает повторяющиеся (count ≥ min). */
export function clusterFailures(failures, min = 2) {
    const map = new Map();
    for (const f of failures) {
        const sig = signature(f.detail);
        if (!sig) continue;
        if (!map.has(sig)) map.set(sig, { pattern: sig, count: 0, example: f.detail.slice(0, 200), sources: [] });
        const c = map.get(sig);
        c.count++;
        if (c.sources.length < 5) c.sources.push(f.source);
    }
    return Array.from(map.values())
        .filter(c => c.count >= min)
        .sort((a, b) => b.count - a.count)
        .map(c => ({ ...c, suggestion: suggestFor(c.pattern) }));
}

function renderLessons(lessons) {
    if (lessons.length === 0) return '';
    const lines = lessons.map(l =>
        `### ⚠ Паттерн (×${l.count})\n- **Сигнатура:** \`${l.pattern}\`\n- **Пример:** ${l.example}\n- **Ratchet:** ${l.suggestion}\n- **Где:** ${l.sources.join(', ')}`
    );
    return lines.join('\n\n');
}

async function main() {
    const args = process.argv.slice(2);
    const taskDir = args[0];
    if (!taskDir) {
        console.error(JSON.stringify({ error: 'Использование: node harnessDream.js <taskDir> [--min 2]' }));
        process.exit(1);
    }
    const minIdx = args.indexOf('--min');
    const min = minIdx >= 0 ? parseInt(args[minIdx + 1], 10) || 2 : 2;

    const roadmap = await readRoadmap(taskDir);
    const receipts = await readReceipts(taskDir).catch(() => ({}));
    const failures = extractFailures(roadmap, receipts);
    const lessons = clusterFailures(failures, min);

    if (lessons.length > 0) {
        const lessonsPath = path.resolve(taskDir, 'harness_lessons.md');
        let existing = '';
        try { existing = await fs.readFile(lessonsPath, 'utf-8'); } catch { /* новый */ }
        const fresh = lessons.filter(l => !existing.includes(l.pattern));
        if (fresh.length > 0) {
            const header = existing ? '' : '# Harness Lessons (уроки из провалов)\n\n> Синтезировано harnessDream. Подъём в глобальную память — только человеком.\n\n';
            await fs.writeFile(lessonsPath, existing + header + renderLessons(fresh) + '\n\n', 'utf-8');
        }
    }

    console.log(JSON.stringify({
        task_dir: taskDir,
        failures_scanned: failures.length,
        recurring_patterns: lessons.length,
        lessons,
        note: lessons.length ? 'Уроки записаны в harness_lessons.md. Подъём в глобальную память требует Human Gate.' : 'Повторяющихся паттернов не найдено.'
    }, null, 2));
}

// Запуск как CLI, но безопасно для импорта в тестах.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('harnessDream.js')) {
    main().catch(err => { console.error(JSON.stringify({ error: err.message })); process.exit(1); });
}
