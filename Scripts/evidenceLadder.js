import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { findRepoRoot } from './harnessPaths.js';

// ─── Evidence Ladder (Lever 1′) ──────────────────────────────────────────────
// Каждый узел проверяется СИЛЬНЕЙШИМ оракулом, который допускает его артефакт.
// Пол доказательства (deterministic rungs) обязателен и НЕ понижается: человек
// или модель могут только ДОБАВИТЬ строгости. LLM-судья закрывает лишь слой,
// до которого не дотягивается ни один детерминированный оракул, и НИКОГДА не
// подменяет оракул, который существовал.
//
// Классы артефактов:
//   code.testable  — бэкенд/либы/CLI/чистая логика (в т.ч. C#-логика Unity):
//                    compile + tests. LLM-судья = только замысел/дизайн.
//   code.behavioral— геймплей Unity/GUI/рендер (приёмка = поведение):
//                    compile + console_clean + tests(playmode/editmode).
//                    Чисто-визуальный остаток → артефакт-свидетельство (судья/человек).
//   text           — GDD/спека/сценарий/доки: детерминированного пола кода нет,
//                    главный проверяющий — состязательный LLM-судья (Lever 2).
//
// Рецепты рунгов пишутся вызовами `validator.js --type oracle --rung <name> --cmd`
// (или штатным `--type auto`) и живут в <taskDir>/evidence_receipts.json,
// привязанные к узлу и его ТЕКУЩЕЙ итерации (freshness: после ретрая с новой
// итерацией старые рецепты считаются протухшими — оракул надо прогнать заново).

export const RUNGS = {
    COMPILE: 'compile',        // сборка / typecheck / syntax-check прошли начисто
    TESTS: 'tests',            // unit/integration/PlayMode/EditMode тесты зелёные
    CONSOLE_CLEAN: 'console_clean', // рантайм-лог перехвачен, ноль Error/Exception
    LINT: 'lint',              // линтер без ошибок (опциональный рунг)
    SECURITY: 'security',      // скан секретов/опасных паттернов (auto-FAIL при утечке)
    STRUCTURE: 'structure'     // механическая проверка структуры текст-артефакта
};

// class → обязательные детерминированные рунги (пол). security — первоклассный
// гейт для кода (auto-FAIL на секретах/auth-bypass), автозапускается floor-гейтом.
const LADDER_POLICY = {
    'code.testable': [RUNGS.COMPILE, RUNGS.TESTS, RUNGS.SECURITY],
    'code.behavioral': [RUNGS.COMPILE, RUNGS.CONSOLE_CLEAN, RUNGS.TESTS, RUNGS.SECURITY],
    'text': [] // судья — легитимно главный; детерминированного пола нет
};

/**
 * Классифицирует узел. Приоритет — явное node.artifact_class. Иначе выводит из
 * artifact_kind: text → 'text'; code → 'code.testable' (behavioral требует явного
 * объявления, т.к. это ослабление детерминизма в пользу свидетельств).
 * @param {object} node
 * @returns {'code.testable'|'code.behavioral'|'text'}
 */
export function classifyNode(node) {
    const explicit = (node.artifact_class || '').toLowerCase();
    if (explicit && LADDER_POLICY[explicit]) return explicit;
    const kind = (node.artifact_kind || 'code').toLowerCase();
    if (kind === 'text') return 'text';
    return 'code.testable';
}

/** Обязательные детерминированные рунги для класса. */
export function requiredRungs(cls) {
    return (LADDER_POLICY[cls] || []).slice();
}

/** Нужно ли жёстко энфорсить детерминированный пол для этого класса. */
export function floorEnforced(cls) {
    return requiredRungs(cls).length > 0;
}

// Детектор фиктивных no-op оракулов. Пол доказательства бессмыслен, если рунг
// «зелёный» через команду, которая ничего не проверяет (`node -e 0`, `echo ok`,
// `true`, `exit 0`). Такие команды НЕ засчитываются в пол — иначе ленивая модель
// ставит зелёную галочку на сырой забагованный код (ровно исходная болезнь).
// Консервативно: ловим только очевидные пустышки, не трогая реальные команды
// вида `node -e "assert(...)"`, `npm test`, `node --check file`, `dotnet build`.
const TRIVIAL_PATTERNS = [
    /^\s*(true|:|exit\s+0|cd\s+\S+)\s*$/i,
    /^\s*echo\b/i,
    /^\s*node\s+-e\s+["']?\s*(0|1|["']{2})?\s*["']?\s*$/i,
    /^\s*node\s+-e\s+["']?\s*process\.exit\(\s*0\s*\)\s*["']?\s*$/i,
    /^\s*(printf|:\s*)\s*/i
];

export function isTrivialOracleCommand(cmd) {
    const c = String(cmd || '').trim();
    if (!c) return true;
    return TRIVIAL_PATTERNS.some(re => re.test(c));
}

function receiptsPath(taskDir) {
    return path.resolve(taskDir, 'evidence_receipts.json');
}

/** Читает хранилище рецептов (map: nodeId → {iteration, rungs:{name:{...}}}). */
export async function readReceipts(taskDir) {
    try {
        const raw = await fs.readFile(receiptsPath(taskDir), 'utf-8');
        return JSON.parse(raw.replace(/^﻿/, ''));
    } catch {
        return {};
    }
}

async function writeReceipts(taskDir, data) {
    await fs.writeFile(receiptsPath(taskDir), '﻿' + JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Записывает рецепт рунга для узла на его ТЕКУЩЕЙ итерации. При смене итерации
 * рецепты узла обнуляются (протухли — работа изменилась после ретрая).
 * result: 'PASS' | 'FAIL' | 'WAIVED'.
 * WAIVED — явный, залогированный отвод рунга (напр. чисто-визуальное поведение,
 * которое физически нельзя проверить headless). Требует reason. Это честный
 * клапан вместо старой тихой дыры «ai-only для кода».
 */
export async function recordRung(taskDir, node, rung, result, detail = '') {
    const store = await readReceipts(taskDir);
    const nodeId = node.id;
    const iter = node.iteration || 0;
    const entry = store[nodeId];
    if (!entry || entry.iteration !== iter) {
        store[nodeId] = { iteration: iter, rungs: {} };
    }
    store[nodeId].rungs[rung] = {
        result,
        detail: String(detail || '').slice(0, 500),
        at: new Date().toISOString()
    };
    await writeReceipts(taskDir, store);
    return store[nodeId];
}

// ─── Финальная интеграция (гейт целостности всей задачи) ─────────────────────
// Пол держит КАЖДЫЙ узел, но набор индивидуально-зелёных узлов может не
// собираться/не проходить тесты вместе. Перед TASK_COMPLETE требуется зелёный
// интеграционный оракул на всю кодовую базу. Свежесть — по сигнатуре состояния
// всех узлов (id#iteration): любое повторное прохождение узла протухляет её.
const TASK_KEY = '__task__';

export function taskSignature(roadmap) {
    return (roadmap.nodes || []).map(n => `${n.id}#${n.iteration || 0}`).join('|');
}

export async function recordTaskIntegration(taskDir, roadmap, result, detail = '') {
    const store = await readReceipts(taskDir);
    store[TASK_KEY] = {
        signature: taskSignature(roadmap),
        result,
        detail: String(detail || '').slice(0, 500),
        at: new Date().toISOString()
    };
    await writeReceipts(taskDir, store);
    return store[TASK_KEY];
}

/**
 * Есть ли свежий зелёный интеграционный прогон для текущего состояния роадмапа.
 * @returns {{ok:boolean, reason:string}}
 */
export async function evaluateTaskIntegration(taskDir, roadmap) {
    const store = await readReceipts(taskDir);
    const rec = store[TASK_KEY];
    if (!rec) return { ok: false, reason: 'нет интеграционного прогона' };
    if (rec.result !== 'PASS') return { ok: false, reason: `последний интеграционный прогон: ${rec.result}` };
    if (rec.signature !== taskSignature(roadmap)) return { ok: false, reason: 'интеграция протухла (узлы менялись после прогона)' };
    return { ok: true, reason: 'интеграция зелёная и свежая' };
}

// Проверяет, что объявленный deliverable реально существует и непуст. Резолвит
// относительный путь по нескольким корням (task_dir, task_dir/workspace, репо).
function deliverableResolvesNonEmpty(taskDir, dep) {
    if (!dep) return true;
    let roots;
    try { roots = [taskDir, path.join(taskDir, 'workspace'), findRepoRoot(taskDir)]; }
    catch { roots = [taskDir, path.join(taskDir, 'workspace')]; }
    const candidates = path.isAbsolute(dep) ? [dep] : roots.map(r => path.resolve(r, dep));
    for (const p of candidates) {
        try {
            const st = fsSync.statSync(p);
            if (st.isFile() && st.size > 0) return true;
            if (st.isDirectory()) return true; // каталог-артефакт — допустимо
        } catch { /* нет файла */ }
    }
    return false;
}

/**
 * Оценивает, выполнен ли детерминированный пол доказательства для узла.
 * @returns {{cls, enforce, required:string[], met:string[], waived:string[], missing:string[], missing_deliverables:string[], floorMet:boolean, iteration:number}}
 */
export async function evaluateFloor(taskDir, node) {
    const cls = classifyNode(node);
    const required = requiredRungs(cls);
    const enforce = floorEnforced(cls);
    const iter = node.iteration || 0;

    const store = await readReceipts(taskDir);
    const entry = store[node.id];
    const rungs = (entry && entry.iteration === iter) ? (entry.rungs || {}) : {};

    const met = [];
    const waived = [];
    const missing = [];
    for (const r of required) {
        const rec = rungs[r];
        if (rec && rec.result === 'PASS') met.push(r);
        else if (rec && rec.result === 'WAIVED') waived.push(r);
        else missing.push(r);
    }

    // Заявленные deliverables code-узла обязаны существовать и быть непустыми:
    // «узел заявил файл X, но не создал» больше не проходит пол.
    const missing_deliverables = [];
    if (enforce && Array.isArray(node.deliverables)) {
        for (const dep of node.deliverables) {
            // deliverables нормализованы в объекты {path}; принимаем и строку.
            const depPath = typeof dep === 'string' ? dep : (dep && dep.path);
            if (depPath && !deliverableResolvesNonEmpty(taskDir, depPath)) missing_deliverables.push(depPath);
        }
    }

    return {
        cls,
        enforce,
        required,
        met,
        waived,
        missing,
        missing_deliverables,
        floorMet: !enforce || (missing.length === 0 && missing_deliverables.length === 0),
        iteration: iter
    };
}
