export const DEFAULT_WORKFLOW_LIMITS = Object.freeze({
    max_concurrent_workers: 3,
    max_workers_per_run: 8,
    token_budget: 120000
});

const WORKFLOW_PROFILES = Object.freeze({
    'unity-compile-fix': { max_concurrent_workers: 1, max_workers_per_run: 1, token_budget: 30000, writes_code: true },
    'readonly-code-audit': { max_concurrent_workers: 3, max_workers_per_run: 8, token_budget: 60000, writes_code: false },
    'safe-migration': { max_concurrent_workers: 3, max_workers_per_run: 8, token_budget: 120000, writes_code: true },
    'research-map-reduce': { max_concurrent_workers: 3, max_workers_per_run: 8, token_budget: 60000, writes_code: false }
});

export function isKnownWorkflowProfile(profile) {
    return Boolean(WORKFLOW_PROFILES[profile]);
}

export function getWorkflowLimits(profile) {
    const limits = profile ? WORKFLOW_PROFILES[profile] : DEFAULT_WORKFLOW_LIMITS;
    return { ...limits };
}

export function selectScale(node, options = {}) {
    const independentParts = Math.max(0, Number.parseInt(options.independentParts, 10) || 0);
    const hasOracle = Boolean(options.hasOracle);
    const requestedProfile = options.profile || null;
    const explicitMode = options.mode || null;
    const artifactKind = node?.artifact_kind || 'code';
    const criticality = node?.criticality || 'L1';

    if (requestedProfile && !WORKFLOW_PROFILES[requestedProfile]) {
        return refuse(`Неизвестный workflow-профиль: ${requestedProfile}.`);
    }
    if (requestedProfile && !isCompatibleWithArtifact(requestedProfile, artifactKind)) {
        return refuse(`Профиль ${requestedProfile} несовместим с artifact_kind=${artifactKind}.`);
    }
    if (requestedProfile && !withinLimits(WORKFLOW_PROFILES[requestedProfile])) {
        return refuse(`Профиль ${requestedProfile} превышает безопасные лимиты.`);
    }
    if (criticality === 'L3') {
        if (explicitMode === 'workflow' || requestedProfile) {
            return refuse('L3 запрещает workflow fan-out: требуется последовательная обработка и усиленная валидация.');
        }
        return buildDecision(hasOracle ? 'goal_loop' : 'classic', null, 'L3 требует последовательной обработки и усиленной валидации.');
    }
    if (explicitMode && ['classic', 'goal_loop', 'workflow'].includes(explicitMode)) {
        return buildDecision(explicitMode, requestedProfile, 'Явное переопределение пользователя.');
    }
    if (requestedProfile) {
        return buildDecision('workflow', requestedProfile, 'Выбран повторяемый workflow-профиль.');
    }
    if (independentParts >= 3) {
        const profile = inferProfile(node, artifactKind);
        return buildDecision('workflow', profile, `Три или более независимые части; artifact_kind=${artifactKind}.`);
    }
    if (hasOracle) {
        return buildDecision('goal_loop', null, 'Есть детерминированное доказательство завершения.');
    }
    return buildDecision('classic', null, 'Один исполнитель без безопасного основания для масштабирования.');
}

function inferProfile(node, artifactKind) {
    const title = String(node?.title || '').toLowerCase();
    if (/миграц|migrat/.test(title)) return 'safe-migration';
    if (/аудит|review|провер/.test(title)) return 'readonly-code-audit';
    if (/исслед|research/.test(title)) return 'research-map-reduce';
    return artifactKind === 'text' ? 'research-map-reduce' : 'safe-migration';
}

function buildDecision(mode, profile, reason) {
    const limits = getWorkflowLimits(profile);
    return { mode, profile, reason, limits, refused: false };
}

function refuse(reason) {
    return { mode: 'classic', profile: null, reason, limits: DEFAULT_WORKFLOW_LIMITS, refused: true };
}

function withinLimits(limits) {
    return limits.max_concurrent_workers <= DEFAULT_WORKFLOW_LIMITS.max_concurrent_workers
        && limits.max_workers_per_run <= DEFAULT_WORKFLOW_LIMITS.max_workers_per_run
        && limits.token_budget <= DEFAULT_WORKFLOW_LIMITS.token_budget;
}

function isCompatibleWithArtifact(profile, artifactKind) {
    return !WORKFLOW_PROFILES[profile].writes_code || artifactKind === 'code';
}
