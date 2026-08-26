import { strategyRegistry } from './graph/strategies/strategyRegistry.js';

// ─── Линтер бюджета инструментов (идея из thu-nmrc/OpenHarness) ──────────────
// «≤ N core tools, чтобы снизить энтропию контекста». Проверяет Plugin Weapon
// Manifest каждой стратегии: число авторизованных инструментов ≤ cap и без
// дубликатов. Разрастание манифеста = раздувание контекста и размывание фокуса.
//
// CLI: node toolBudgetLint.js [--cap 10]   (env HARNESS_TOOL_BUDGET)

export function lintToolBudgets(strategies, cap) {
    const violations = [];
    for (const s of strategies) {
        const weapons = Array.isArray(s.weapons) ? s.weapons : [];
        if (weapons.length > cap) {
            violations.push({ strategy: s.id, kind: 'over_budget', count: weapons.length, cap, weapons });
        }
        const dupes = weapons.filter((w, i) => weapons.indexOf(w) !== i);
        if (dupes.length > 0) {
            violations.push({ strategy: s.id, kind: 'duplicate_tools', duplicates: [...new Set(dupes)] });
        }
    }
    return { ok: violations.length === 0, cap, violations };
}

function main() {
    const args = process.argv.slice(2);
    const capIdx = args.indexOf('--cap');
    const envCap = parseInt(process.env.HARNESS_TOOL_BUDGET, 10);
    const cap = capIdx >= 0 ? (parseInt(args[capIdx + 1], 10) || 10)
        : (Number.isFinite(envCap) ? envCap : 10);

    const strategies = strategyRegistry.list();
    const report = lintToolBudgets(strategies, cap);

    console.log(JSON.stringify({
        cap,
        strategies: strategies.map(s => ({ id: s.id, tools: (s.weapons || []).length })),
        ok: report.ok,
        violations: report.violations,
        message: report.ok
            ? `Все ${strategies.length} стратегий в бюджете (≤${cap} инструментов).`
            : `Нарушения бюджета инструментов: ${report.violations.length}. Сократи манифест или подними cap осознанно.`
    }, null, 2));
    process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('toolBudgetLint.js')) {
    main();
}
