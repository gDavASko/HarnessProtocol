// judgeSelector.js — pure, side-effect-free judge selection calculus.
//
// Decides WHICH judge(s) grade a node's artifact, given the worker's family, the
// artifact kind, the node criticality, and the set of judges the auth-probe found
// LIVE. No fs, no network, no process exit — unit-testable. Consumed by validator.js
// / cli-judge.js (F5 wire) and documented in config/judge-selection.md.
//
// Guarantees encoded here:
//   * L0 (trivial/predefined) -> deterministic oracle only, NO LLM judge.
//   * A judge must be a DIFFERENT model family than the worker (cross-family rule).
//     Since claude-subagent's family is 'anthropic', this alone makes a claude
//     subagent INVALID when the worker is Claude, and VALID when it is agy/codex.
//   * If no valid cross-family judge is live -> UNVALIDATED (never PASS).
//   * Optimize by (fit to artifact_kind x criticality), then latency, then cost.

import { pathToFileURL } from 'url';

// ── Normalization ────────────────────────────────────────────────────────────
const BIN_TO_FAMILY = { claude: 'anthropic', 'claude-subagent': 'anthropic', agy: 'google', gemini: 'google', codex: 'openai' };

export function toFamily(familyOrBin) {
    if (!familyOrBin) return null;
    const s = String(familyOrBin).toLowerCase();
    if (s === 'anthropic' || s === 'google' || s === 'openai') return s;
    return BIN_TO_FAMILY[s] || s;
}

export function normalizeCriticality(c) {
    if (c === null || c === undefined) return 'L1';
    const s = String(c).toUpperCase();
    if (['L0', 'L1', 'L2', 'L3'].includes(s)) return s;
    const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
    if (n >= 0 && n <= 3) return `L${n}`;
    return 'L1';
}

// ── Scoring tables ───────────────────────────────────────────────────────────
// Fit of a judge FAMILY to an artifact kind (higher = better). Coarse, tunable.
const FAMILY_FIT = {
    code: { openai: 3, anthropic: 2, google: 2 },
    text: { anthropic: 3, google: 2, openai: 2 },
    default: { anthropic: 2, google: 2, openai: 2 }
};
function fitScore(family, artifactKind) {
    const table = FAMILY_FIT[artifactKind] || FAMILY_FIT.default;
    return table[family] ?? 1;
}
// Cheaper is preferred; lower rank = cheaper.
const COST_RANK = { free_tier: 0, included: 1, paid: 2 };
function costRank(cost) { return COST_RANK[cost] ?? 1; }

// Criticality -> required judge tier + judge count.
const CRIT_POLICY = {
    L0: { mode: 'oracle_only', tier: null, count: 0 },
    L1: { mode: 'single', tier: 'medium', count: 1 },
    L2: { mode: 'single', tier: 'high', count: 1 },
    L3: { mode: 'quorum', tier: 'max', count: 2 }
};

/**
 * @param {object} input
 * @param {string} input.worker_family  family or bin of the worker (excluded from judges)
 * @param {string} input.artifact_kind  'code' | 'text' | other
 * @param {string|number} input.criticality  L0..L3 (or 0..3)
 * @param {Array<{id:string,family:string,cost?:string,latency?:number}>} input.live_judges
 *        judges proven LIVE by the auth-probe (id + family required).
 * @returns {{decision:'oracle_only'|'judges'|'UNVALIDATED', judges:Array, tier:string|null,
 *           mode:string, reason:string}}
 */
export function selectJudge({ worker_family, artifact_kind = 'code', criticality = 'L1', live_judges = [] } = {}) {
    const crit = normalizeCriticality(criticality);
    const policy = CRIT_POLICY[crit];
    const workerFam = toFamily(worker_family);

    // L0: deterministic oracle decides; no paid LLM judge is spent.
    if (policy.mode === 'oracle_only') {
        return { decision: 'oracle_only', judges: [], tier: null, mode: 'oracle_only',
            reason: 'L0 trivial/predefined: deterministic oracle (compile/test) is the verdict.' };
    }

    // Keep all LIVE judges that have valid metadata.
    // We prioritize cross-family (different family than worker) in sorting,
    // but we no longer drop same-family models completely. This allows same-family
    // subagent fallbacks when no cross-family judges are available, as long as
    // session isolation rules are respected.
    const candidates = (live_judges || [])
        .filter(j => j && j.id && toFamily(j.family))
        .map(j => ({
            id: j.id,
            family: toFamily(j.family),
            cost: j.cost || 'paid',
            latency: Number.isFinite(j.latency) ? j.latency : Infinity
        }));

    if (candidates.length === 0) {
        return { decision: 'UNVALIDATED', judges: [], tier: policy.tier, mode: policy.mode,
            reason: `No live judges available at all. Never PASS -> UNVALIDATED.` };
    }

    // Rank: cross-family first (desc) -> fit (desc) -> latency (asc) -> cost (asc) -> id (stable).
    const ranked = candidates.slice().sort((a, b) => {
        const aIsCross = workerFam ? (a.family !== workerFam) : true;
        const bIsCross = workerFam ? (b.family !== workerFam) : true;
        if (aIsCross !== bIsCross) {
            return aIsCross ? -1 : 1; // Prioritize cross-family judges
        }

        const f = fitScore(b.family, artifact_kind) - fitScore(a.family, artifact_kind);
        if (f !== 0) return f;
        if (a.latency !== b.latency) return a.latency - b.latency;
        const c = costRank(a.cost) - costRank(b.cost);
        if (c !== 0) return c;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // L3 quorum: prefer TWO judges of distinct families; if only one candidate is
    // live, fall back to dual-order (same judge, two evidence orderings).
    if (policy.mode === 'quorum') {
        const picked = [];
        const usedFamilies = new Set();
        for (const c of ranked) {
            if (!usedFamilies.has(c.family)) { picked.push(c); usedFamilies.add(c.family); }
            if (picked.length >= policy.count) break;
        }
        // top up with any remaining (same-family allowed) if still short of count
        for (const c of ranked) {
            if (picked.length >= policy.count) break;
            if (!picked.includes(c)) picked.push(c);
        }
        if (picked.length >= 2) {
            return { decision: 'judges', judges: picked.slice(0, policy.count), tier: policy.tier,
                mode: 'quorum', reason: `L3 critical: strong quorum of ${policy.count} judges.` };
        }
        return { decision: 'judges', judges: [picked[0]], tier: policy.tier, mode: 'dual_order',
            reason: 'L3 critical but only one judge live: strong judge run dual-order (two evidence orderings).' };
    }

    // L1 / L2: a single best-fit judge.
    const chosen = ranked[0];
    const isCross = workerFam ? (chosen.family !== workerFam) : true;
    const desc = isCross ? 'cross-family' : 'same-family fallback';
    return { decision: 'judges', judges: [chosen], tier: policy.tier, mode: 'single',
        reason: `${crit}: one ${policy.tier} ${desc} judge (best fit for artifact_kind='${artifact_kind}').` };
}

export default selectJudge;

// ── Self-test (node-runnable): `node judgeSelector.js` ───────────────────────
function runSelfTest() {
    let failures = 0;
    const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

    // 1) L0 -> oracle_only (no LLM judge)
    const t1 = selectJudge({ worker_family: 'anthropic', artifact_kind: 'code', criticality: 'L0',
        live_judges: [{ id: 'agy', family: 'google' }] });
    check('L0 -> oracle_only', t1.decision === 'oracle_only' && t1.judges.length === 0);

    // 2) claude worker + only claude-subagent live -> chooses claude-subagent (as same-family fallback)
    const t2 = selectJudge({ worker_family: 'claude', artifact_kind: 'code', criticality: 'L1',
        live_judges: [{ id: 'claude-subagent', family: 'anthropic' }] });
    check('claude worker + only claude-subagent -> chooses claude-subagent as fallback', 
        t2.decision === 'judges' && t2.judges.length === 1 && t2.judges[0].id === 'claude-subagent');

    // 3) agy worker + claude-subagent live -> claude-subagent chosen
    const t3 = selectJudge({ worker_family: 'agy', artifact_kind: 'code', criticality: 'L1',
        live_judges: [{ id: 'claude-subagent', family: 'anthropic' }] });
    check('agy worker + claude-subagent -> claude-subagent chosen',
        t3.decision === 'judges' && t3.judges.length === 1 && t3.judges[0].id === 'claude-subagent');

    // 4) L3 -> strong + quorum (two distinct-family judges)
    const t4 = selectJudge({ worker_family: 'google', artifact_kind: 'code', criticality: 'L3',
        live_judges: [{ id: 'codex', family: 'openai', latency: 15000 }, { id: 'claude-subagent', family: 'anthropic', latency: 12000 }] });
    check('L3 -> quorum of 2', t4.decision === 'judges' && t4.mode === 'quorum' && t4.judges.length === 2 && t4.tier === 'max');

    // 4b) L3 with a single live cross-family judge -> dual_order (still validated)
    const t4b = selectJudge({ worker_family: 'anthropic', artifact_kind: 'code', criticality: 'L3',
        live_judges: [{ id: 'agy', family: 'google' }] });
    check('L3 single judge -> dual_order', t4b.decision === 'judges' && t4b.mode === 'dual_order' && t4b.judges.length === 1);

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    runSelfTest();
}
