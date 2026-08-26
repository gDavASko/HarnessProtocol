// ─── Взвешенная рубрика судьи (идея из openclaw-harness) ─────────────────────
// Поверх бинарного pass/fail: судья оценивает 4 измерения 0..10; взвешенный балл
// ниже порога ИЛИ security-измерение ниже пола → вердикт понижается до FAIL,
// даже если pass=true. «Формально закрыл DoD, но сыро/дырявo по безопасности»
// не проходит. Backward-compat: если судья не вернул рубрику — не штрафуем
// (рубрика аддитивна к существующим судьям).

export const RUBRIC = {
    weights: { functionality: 0.30, quality: 0.25, security: 0.25, edge_cases: 0.20 },
    get threshold() {
        const t = parseFloat(process.env.HARNESS_RUBRIC_THRESHOLD);
        return Number.isFinite(t) ? t : 7.0;
    },
    security_floor: 5.0
};

/**
 * @param {object|undefined} rubric — { functionality, quality, security, edge_cases } 0..10
 * @returns {{ok:boolean, score:number|null, dims?:object, reason:string}}
 */
export function evaluateRubric(rubric) {
    if (!rubric || typeof rubric !== 'object') return { ok: true, score: null, reason: 'рубрика не предоставлена' };
    const dims = ['functionality', 'quality', 'security', 'edge_cases'];
    const vals = {};
    for (const d of dims) {
        const v = Number(rubric[d]);
        if (!Number.isFinite(v)) return { ok: true, score: null, reason: 'неполная рубрика (проигнорирована)' };
        vals[d] = Math.max(0, Math.min(10, v));
    }
    const score = dims.reduce((s, d) => s + RUBRIC.weights[d] * vals[d], 0);
    if (vals.security < RUBRIC.security_floor) {
        return { ok: false, score, dims: vals, reason: `security-измерение ${vals.security}<${RUBRIC.security_floor} (security-floor → авто-FAIL)` };
    }
    if (score < RUBRIC.threshold) {
        return { ok: false, score, dims: vals, reason: `взвешенный балл ${score.toFixed(1)} < порога ${RUBRIC.threshold}` };
    }
    return { ok: true, score, dims: vals, reason: `взвешенный балл ${score.toFixed(1)} ≥ ${RUBRIC.threshold}` };
}
