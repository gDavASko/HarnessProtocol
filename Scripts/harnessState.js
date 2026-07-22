import fs from 'fs/promises';
import path from 'path';
import { checkpoint } from './stateStore.js';
import { getWorkflowLimits, isKnownWorkflowProfile } from './scaleGate.js';

export const UTF8_BOM = '\ufeff';
export const ROADMAP_FILE = '.harness_roadmap.json';
export const STATE_FILE = '.harness_state.json';

const DEFAULT_MAX_ITERATIONS = 5;
const VALID_NODE_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'CRITICAL_FAIL']);
const DOD_REGEX = /^\s*(?:\d+\.|\*|-)?\s*\[([xX ]*)\]\s*(.+?)\s*$/;

export async function readClean(filePath) {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.replace(/^\uFEFF/, '');
}

export async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function getMtime(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return stat.mtime.toISOString();
    } catch {
        return null;
    }
}

export function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};

    const result = {};
    for (const line of match[1].split(/\r?\n/)) {
        const pair = line.match(/^(\w[\w_]*)\s*:\s*(.+)\s*$/);
        if (pair) result[pair[1]] = pair[2].trim();
    }
    return result;
}

export async function readState(taskDir) {
    const statePath = path.resolve(taskDir, STATE_FILE);
    try {
        return JSON.parse(await readClean(statePath));
    } catch {
        return {};
    }
}

export async function writeState(taskDir, state) {
    const statePath = path.resolve(taskDir, STATE_FILE);
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
    // Durable checkpoint after every state transition (best-effort, never throws).
    await checkpoint(taskDir, { node: state.current_node || null, status: state.stage || null, state });
}

export function createInitialRoadmap(taskId, title) {
    const now = new Date().toISOString();
    return normalizeRoadmap({
        schema_version: 1,
        task_id: taskId,
        title,
        status: 'PENDING',
        current_node_id: 'УЗЕЛ-01',
        last_completed_node_id: null,
        created_at: now,
        updated_at: now,
        nodes: [
            {
                id: 'УЗЕЛ-01',
                title: 'Инициализация и декомпозиция',
                status: 'PENDING',
                iteration: 0,
                max_iterations: DEFAULT_MAX_ITERATIONS,
                strategy: 'None',
                validation_type: 'ai',
                l1_file: null,
                last_error: null,
                deliverables: [],
                dod: [
                    {
                        criterion: 'Задача декомпозирована на понятные узлы.',
                        done: false
                    }
                ],
                history: []
            }
        ]
    });
}

export async function readRoadmap(taskDir) {
    const roadmapPath = path.resolve(taskDir, ROADMAP_FILE);
    if (await fileExists(roadmapPath)) {
        const roadmap = normalizeRoadmap(JSON.parse(await readClean(roadmapPath)));
        if (roadmap.current_node_id === null) {
            roadmap.current_node_id = getCurrentNode(roadmap)?.id || null;
        }
        return roadmap;
    }

    // JSON (.harness_roadmap.json) — ЕДИНСТВЕННЫЙ источник истины. Обратный
    // парсинг Markdown выполняется ТОЛЬКО здесь и ТОЛЬКО один раз (bootstrap
    // legacy-задач без JSON). После первого запуска Markdown лишь генерируется
    // из JSON и обратно не читается. Отключается переменной HARNESS_NO_BOOTSTRAP=1.
    if (process.env.HARNESS_NO_BOOTSTRAP === '1') {
        const master = await readMasterInfo(taskDir);
        const fresh = createInitialRoadmap(master.id, master.title);
        await writeRoadmap(taskDir, fresh, { syncMarkdown: true });
        return fresh;
    }

    console.warn(`[harnessState] .harness_roadmap.json отсутствует → одноразовый bootstrap из Markdown (${taskDir})`);
    const migrated = await migrateRoadmapFromMarkdown(taskDir);
    await writeRoadmap(taskDir, migrated, { syncMarkdown: true });
    return migrated;
}

export async function writeRoadmap(taskDir, roadmap, options = {}) {
    const normalized = normalizeRoadmap({
        ...roadmap,
        updated_at: new Date().toISOString()
    });

    const roadmapPath = path.resolve(taskDir, ROADMAP_FILE);
    await fs.writeFile(roadmapPath, JSON.stringify(normalized, null, 2), 'utf-8');

    if (options.syncMarkdown) {
        await syncRoadmapMarkdown(taskDir, normalized);
    }

    return normalized;
}

export function normalizeRoadmap(roadmap) {
    const normalized = {
        schema_version: roadmap.schema_version || 1,
        task_id: roadmap.task_id || 'UNKNOWN',
        title: roadmap.title || 'Без названия',
        status: normalizeTaskStatus(roadmap.status || 'PENDING'),
        current_node_id: roadmap.current_node_id || null,
        last_completed_node_id: roadmap.last_completed_node_id || null,
        // Drift-guard: сверка накопленной реализации с исходным ТЗ каждые
        // sync_interval закрытых узлов. nodes_since_sync — счётчик с последней сверки.
        sync_interval: clampSyncInterval(roadmap.sync_interval),
        nodes_since_sync: toInt(roadmap.nodes_since_sync, 0),
        created_at: roadmap.created_at || new Date().toISOString(),
        updated_at: roadmap.updated_at || new Date().toISOString(),
        nodes: Array.isArray(roadmap.nodes) ? roadmap.nodes.map(normalizeNode) : []
    };

    if (normalized.nodes.length === 0) {
        normalized.nodes.push(normalizeNode({
            id: 'УЗЕЛ-01',
            title: 'Инициализация и декомпозиция',
            status: 'PENDING',
            dod: [{ criterion: 'Задача декомпозирована на понятные узлы.', done: false }]
        }));
    }

    if (!normalized.current_node_id || !normalized.nodes.some(n => n.id === normalized.current_node_id)) {
        normalized.current_node_id = getCurrentNode(normalized)?.id || null;
    }

    return normalized;
}

// F4 mode-selection heuristic: reserve the expensive harness path (LLM judge,
// drift-guard, WAL) for work with NO cheap deterministic oracle. A node validated
// deterministically (auto: tests/compiler/linter) defaults to 'classic'; a node
// judged by an LLM ('ai') or a person ('human') defaults to 'harness'.
export function recommendNodeMode(validationType) {
    return normalizeValidationType(validationType || 'ai') === 'auto' ? 'classic' : 'harness';
}

export function normalizeNode(node) {
    const id = normalizeNodeId(node.id || 'УЗЕЛ-01');
    const status = normalizeNodeStatus(node.status || 'PENDING');
    const validationType = normalizeValidationType(node.validation_type || 'ai');

    const maxIterations = toInt(node.max_iterations, DEFAULT_MAX_ITERATIONS);
    return {
        id,
        title: String(node.title || id).trim(),
        status,
        iteration: toInt(node.iteration, 0),
        max_iterations: maxIterations,
        strategy: node.strategy || 'None',
        validation_type: validationType,
        // F4: 'classic' (cheap deterministic path) | 'harness' (full LLM-judge path).
        mode: (node.mode === 'classic' || node.mode === 'harness') ? node.mode : recommendNodeMode(validationType),
        artifact_kind: normalizeArtifactKind(node.artifact_kind),
        // Model family that produced this node ('anthropic'|'google'|'openai'); the
        // ai judge is then chosen from a DIFFERENT family. null = no constraint.
        worker_family: node.worker_family || null,
        tier: node.tier || null,
        // Phase-2: node criticality drives judgeSelector (L0=oracle-only, L1=medium,
        // L2=high, L3=quorum). Defaults to deterministic derivation from validation
        // type when the caller didn't set one explicitly.
        criticality: normalizeCriticalityLevel(node.criticality, validationType),
        // Phase-2: resolved model/tier snapshot recorded at initialization time
        // (task_initializer.js). Purely informational — not used to route calls.
        resolved_model: node.resolved_model || null,
        resolved_tier: node.resolved_tier || null,
        // Compact handoff summary (≤~300 tokens) of what this node produced;
        // next-node context is assembled from these, not raw artifacts (B2).
        summary: node.summary || null,
        l1_file: node.l1_file || null,
        last_error: node.last_error || null,
        deliverables: normalizeDeliverables(node.deliverables),
        dod: normalizeDod(node.dod),
        goal: normalizeGoal(node.goal, maxIterations),
        workflow: normalizeWorkflowSelection(node.workflow),
        history: Array.isArray(node.history) ? node.history.map(normalizeHistoryEntry) : []
    };
}

export function normalizeNodeId(id) {
    const text = String(id).trim();
    const match = text.match(/(?:УЗЕЛ|Узел)-?\s*(\d+)/i);
    if (!match) return text.toUpperCase();
    return `УЗЕЛ-${match[1].padStart(2, '0')}`;
}

export function getCurrentNode(roadmap) {
    return roadmap.nodes.find(n => n.id === roadmap.current_node_id)
        || roadmap.nodes.find(n => n.status === 'IN_PROGRESS')
        || roadmap.nodes.find(n => n.status === 'PENDING')
        || null;
}

export function getNode(roadmap, nodeId) {
    const normalizedId = normalizeNodeId(nodeId);
    return roadmap.nodes.find(n => n.id === normalizedId) || null;
}

export function getNextPendingNode(roadmap, currentNodeId) {
    const currentIndex = roadmap.nodes.findIndex(n => n.id === normalizeNodeId(currentNodeId));
    return roadmap.nodes.find((n, i) => i > currentIndex && n.status === 'PENDING') || null;
}

export function getRoadmapProgress(roadmap) {
    const total = roadmap.nodes.length;
    const done = roadmap.nodes.filter(n => n.status === 'DONE').length;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const totalIterations = roadmap.nodes.reduce((sum, n) => sum + n.iteration, 0);
    const criticalFails = roadmap.nodes.filter(n => n.status === 'CRITICAL_FAIL').length;
    const blockers = roadmap.nodes
        .filter(n => n.status === 'BLOCKED' || n.status === 'CRITICAL_FAIL')
        .map(n => `${n.id}: ${n.last_error || n.status}`);

    return { total, done, percent, totalIterations, criticalFails, blockers };
}

export async function migrateRoadmapFromMarkdown(taskDir) {
    const master = await readMasterInfo(taskDir);
    const loopPath = path.resolve(taskDir, 'forks', 'tactical_ralph_loop.md');
    let content = '';
    try {
        content = await readClean(loopPath);
    } catch {
        return createInitialRoadmap(master.id, master.title);
    }

    const nodes = parseLegacyNodes(content);
    const roadmap = normalizeRoadmap({
        schema_version: 1,
        task_id: master.id,
        title: master.title,
        status: master.status,
        current_node_id: nodes.find(n => n.status === 'IN_PROGRESS')?.id
            || nodes.find(n => n.status === 'PENDING')?.id
            || null,
        last_completed_node_id: [...nodes].reverse().find(n => n.status === 'DONE')?.id || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        nodes
    });

    return roadmap;
}

export async function readMasterInfo(taskDir) {
    const folderName = path.basename(path.resolve(taskDir));
    const masterPath = path.resolve(taskDir, 'tactical_master.md');
    try {
        const content = await readClean(masterPath);
        const fm = parseFrontmatter(content);
        
        let title = fm.title || 'Без названия';
        if (title === 'Без названия') {
            const titleMatch = content.match(/#\s+📋\s+1\.\s+ГЛОБАЛЬНЫЙ\s+ПЛАН И ТРЕБОВАНИЯ\r?\n\*\s+\*\*Глобальная цель:\*\*\s*(.+)/i)
                || content.match(/##?\s+Цель\r?\n\s*(.+)/i);
            if (titleMatch) title = titleMatch[1].trim();
        }

        return {
            id: fm.tactical_task_id || folderName,
            title: title,
            status: normalizeTaskStatus(fm.global_status || 'PENDING'),
            humanNotes: extractHumanNotes(content)
        };
    } catch {
        return {
            id: folderName,
            title: 'Без названия',
            status: 'PENDING',
            humanNotes: null
        };
    }
}

export async function parseConstraints(taskDir) {
    const filePath = path.resolve(taskDir, 'forks', 'tactical_constraints.md');
    try {
        const content = await readClean(filePath);
        const items = [];
        for (const line of content.split(/\r?\n/)) {
            const match = line.match(/^\s*\*\s*\*\*(.+?)\*\*\s*(.+)\s*$/);
            if (match) {
                items.push(`${match[1].replace(/[:\s]+$/, '')}: ${match[2].replace(/\.$/, '').trim()}`);
            }
        }

        let digest = items.join('; ');
        if (digest.length > 200) digest = `${digest.slice(0, 197)}...`;
        return { digest, mtime: await getMtime(filePath) };
    } catch {
        return { digest: '', mtime: null };
    }
}

export async function parseTools(taskDir) {
    const filePath = path.resolve(taskDir, 'forks', 'tactical_tools_registry.md');
    try {
        const content = await readClean(filePath);
        const tools = [];
        const toolRegex = /`([a-zA-Z0-9_.:-]+)`/g;
        for (const line of content.split(/\r?\n/)) {
            if (!/\[SKILL\]|\[TOOL\]|скрипт|утилит|Script|Tool/i.test(line)) continue;
            let match;
            while ((match = toolRegex.exec(line)) !== null) {
                if (!tools.includes(match[1])) tools.push(match[1]);
            }
        }
        return tools;
    } catch {
        return [];
    }
}

export async function parseLastInsight(taskDir) {
    const filePath = path.resolve(taskDir, 'forks', 'tactical_work_log.md');
    try {
        const content = await readClean(filePath);
        const insightRegex = /(?:инсайт|insight)[:\s]*(.+)/gi;
        let result = null;
        let match;
        while ((match = insightRegex.exec(content)) !== null) {
            result = match[1].trim().replace(/^\*+|\*+$/g, '').trim();
        }
        return result;
    } catch {
        return null;
    }
}

export async function appendLoopEntry(taskDir, nodeId, status, iteration, detail) {
    const filePath = path.resolve(taskDir, 'forks', 'tactical_ralph_loop.md');
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const normalizedStatus = status === 'SUCCESS' ? 'SUCCESS' : 'FAIL';
    const detailLabel = normalizedStatus === 'SUCCESS' ? 'Инсайт' : 'Ошибка';
    const detailText = detail ? `*   **${detailLabel}:** ${detail}\n` : '';

    const entry = `\n### Виток #${iteration} | ${normalizeNodeId(nodeId)} | ${dateStr}\n*   **Результат:** \`${normalizedStatus}\`\n${detailText}`;
    await fs.appendFile(filePath, entry, 'utf-8');
}

export async function appendWorkLog(taskDir, nodeId, status, insight, iteration = 0, strategy = 'None', maxLen = 200) {
    if (!insight) return;

    const filePath = path.resolve(taskDir, 'forks', 'tactical_work_log.md');
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const trimmed = insight.length > maxLen ? `${insight.slice(0, maxLen - 3)}...` : insight;
    const entry = `\n### [${dateStr}] | Узел: ${normalizeNodeId(nodeId)} | (Виток #${iteration}) | Стратегия: ${strategy}\n*   **Итог:** ${status} | **Инсайт:** ${trimmed}\n`;
    await fs.appendFile(filePath, entry, 'utf-8');
}

export async function collectDeliverables(taskDir, node) {
    const deliverables = [];
    const seen = new Set();

    for (const item of node.deliverables || []) {
        const itemPath = typeof item === 'string' ? item : item.path;
        if (!itemPath) continue;

        let resolved = path.isAbsolute(itemPath)
            ? itemPath
            : path.resolve(taskDir, itemPath);

        let mtime = await getMtime(resolved);
        if (!mtime && !path.isAbsolute(itemPath)) {
            const fallbackPath = path.resolve(taskDir, '../../..', itemPath);
            const fallbackMtime = await getMtime(fallbackPath);
            if (fallbackMtime) {
                resolved = fallbackPath;
                mtime = fallbackMtime;
            }
        }

        if (mtime && !seen.has(resolved)) {
            seen.add(resolved);
            deliverables.push({ path: resolved, mtime });
        }
    }

    return deliverables;
}

export function buildRoadmapMarkdown(roadmap) {
    const current = getCurrentNode(roadmap);
    const lines = [
        '<!-- HARNESS_ROADMAP:START -->',
        '## Машинный roadmap',
        '',
        '> Источник правды: `.harness_roadmap.json`. Этот блок синхронизируется скриптами Harness.',
        '',
        `*   **Текущий узел:** \`${current ? `${current.id}: ${current.title}` : 'None'}\``,
        `*   **Глобальный статус задачи:** \`${roadmap.status}\``,
        '',
        '### Узлы'
    ];

    for (const node of roadmap.nodes) {
        lines.push('');
        lines.push(`#### ${node.id}: ${node.title}`);
        lines.push(`*   **Статус:** \`${node.status}\``);
        lines.push(`*   **Виток:** \`#${node.iteration}/${node.max_iterations}\``);
        lines.push(`*   **Стратегия:** \`${node.strategy || 'None'}\``);
        lines.push(`*   **validation_type:** \`${node.validation_type}\``);
        lines.push(`*   **artifact_kind:** \`${node.artifact_kind}\``);
        if (node.goal) {
            lines.push(`*   **Цель:** ${node.goal.outcome}`);
            lines.push(`*   **Доказательство:** \`${node.goal.proof}\``);
            lines.push(`*   **Остановка без прогресса:** \`${node.goal.max_no_progress}\``);
        }
        if (node.workflow) {
            lines.push(`*   **Режим масштаба:** \`${node.workflow.mode}\`${node.workflow.profile ? ` (${node.workflow.profile})` : ''}`);
        }
        if (node.last_error) lines.push(`*   **Последний блокер:** ${node.last_error}`);
        if (node.deliverables.length > 0) {
            lines.push(`*   **Артефакты:** ${node.deliverables.map(d => `\`${typeof d === 'string' ? d : d.path}\``).join(', ')}`);
        }
        lines.push('*   **DoD:**');
        for (const item of node.dod) {
            lines.push(`    - [${item.done ? 'x' : ' '}] ${item.criterion}`);
        }
    }

    lines.push('<!-- HARNESS_ROADMAP:END -->');
    return lines.join('\n');
}

export async function syncRoadmapMarkdown(taskDir, roadmap) {
    const filePath = path.resolve(taskDir, 'forks', 'tactical_ralph_loop.md');
    if (!(await fileExists(filePath))) return;

    let content = await readClean(filePath);
    content = updateGlobalLoopHeader(content, roadmap);

    const block = buildRoadmapMarkdown(roadmap);
    const blockRegex = /<!-- HARNESS_ROADMAP:START -->[\s\S]*?<!-- HARNESS_ROADMAP:END -->/;
    if (blockRegex.test(content)) {
        content = content.replace(blockRegex, block);
    } else if (/<!--\s*ANCHOR:\s*DEFINITION_OF_DONE\s*-->/i.test(content)) {
        content = content.replace(/(<!--\s*ANCHOR:\s*DEFINITION_OF_DONE\s*-->)/i, `${block}\n\n$1`);
    } else {
        content = `${content.trimEnd()}\n\n${block}\n`;
    }

    await fs.writeFile(filePath, UTF8_BOM + content, 'utf-8');
}

function parseLegacyNodes(content) {
    const lines = content.split(/\r?\n/);
    const nodes = [];
    let current = null;
    let currentLines = [];

    const flush = () => {
        if (!current) return;
        current.dod = extractDod(currentLines);
        current.deliverables = extractDeliverablesFromLines(currentLines);
        current.history = extractHistoryForNode(lines, current.id);
        nodes.push(current);
    };

    for (const line of lines) {
        const header = line.match(/^###\s+(?:#+\s*)?(?!.*Виток).*?(УЗЕЛ-\d+|Узел\s+\d+)[:\s|]*(.*?)\s*$/i);
        if (header) {
            flush();
            current = normalizeNode({
                id: header[1],
                title: header[2] || header[1],
                status: 'PENDING',
                iteration: 0,
                max_iterations: DEFAULT_MAX_ITERATIONS,
                validation_type: 'ai',
                strategy: 'None',
                dod: []
            });
            currentLines = [];
            continue;
        }

        if (!current) continue;
        currentLines.push(line);

        const status = line.match(/(?:Глобальный\s+)?[Сс]татус(?:\s+узла)?\s*\*{0,2}\s*:\s*`?([A-Z_]+)`?/i);
        if (status) current.status = normalizeNodeStatus(status[1]);

        const iteration = line.match(/Виток\s*#?(\d+)/i);
        if (iteration) current.iteration = toInt(iteration[1], 0);

        const maxIteration = line.match(/(?:макс|max|лимит)[^:]*:\s*`?(\d+)`?/i);
        if (maxIteration) current.max_iterations = toInt(maxIteration[1], DEFAULT_MAX_ITERATIONS);

        const strategy = line.match(/(?:Стратегия|Выбранная стратегия)\s*\*{0,2}\s*:\s*`?([^`\n]+)`?/i);
        if (strategy) current.strategy = strategy[1].trim();

        const validation = line.match(/(?:validation_type|Валидация)\s*\*{0,2}\s*:\s*`?(\w+)`?/i);
        if (validation) current.validation_type = normalizeValidationType(validation[1]);

        const error = line.match(/(?:блокер|ошибка|error)\s*\*{0,2}\s*:\s*`?([^`\n]+)`?/i);
        if (error) current.last_error = error[1].trim();
    }

    flush();

    if (nodes.length > 0) return nodes;

    return [
        normalizeNode({
            id: 'УЗЕЛ-01',
            title: 'Инициализация и декомпозиция',
            status: 'PENDING',
            dod: extractDod(lines)
        })
    ];
}

function extractDod(lines) {
    const dod = [];
    for (const line of lines) {
        const match = line.match(DOD_REGEX);
        if (match) {
            dod.push({
                criterion: match[2].trim(),
                done: match[1].trim().toLowerCase() === 'x'
            });
        }
    }

    return dod.length > 0
        ? dod
        : [{ criterion: 'Критерий качества не задан в roadmap.', done: false }];
}

function extractDeliverablesFromLines(lines) {
    const result = [];
    const seen = new Set();
    const codeRefRegex = /`([^`]+\.[A-Za-z0-9]{1,8})`/g;
    const mdRefRegex = /\[[^\]]+\]\((?:file:\/\/\/)?([^)]+)\)/g;

    for (const line of lines) {
        let match;
        while ((match = codeRefRegex.exec(line)) !== null) {
            if (!seen.has(match[1])) {
                seen.add(match[1]);
                result.push({ path: match[1] });
            }
        }
        while ((match = mdRefRegex.exec(line)) !== null) {
            if (!seen.has(match[1])) {
                seen.add(match[1]);
                result.push({ path: match[1] });
            }
        }
    }

    return result;
}

function extractHistoryForNode(lines, nodeId) {
    const history = [];
    let inEntry = false;
    let entry = null;

    for (const line of lines) {
        const header = line.match(/^###\s+.*Виток\s*#?(\d+).*?(УЗЕЛ-\d+)/i);
        if (header) {
            if (entry) history.push(normalizeHistoryEntry(entry));
            inEntry = normalizeNodeId(header[2]) === nodeId;
            entry = inEntry
                ? { iteration: toInt(header[1], 0), result: 'PENDING', detail: null, at: null }
                : null;
            continue;
        }

        if (!inEntry || !entry) continue;

        const result = line.match(/Результат\s*\*{0,2}\s*:\s*`?(\w+)`?/i);
        if (result) entry.result = result[1].toUpperCase();

        const detail = line.match(/(?:Инсайт|Ошибка|Причина)\s*\*{0,2}\s*:\s*(.+)$/i);
        if (detail) entry.detail = detail[1].trim();
    }

    if (entry) history.push(normalizeHistoryEntry(entry));
    return history;
}

function updateGlobalLoopHeader(content, roadmap) {
    const current = getCurrentNode(roadmap);
    const currentText = current ? `${current.id}: ${current.title}` : 'None';
    const statusText = current ? current.status : roadmap.status;
    const strategyText = current ? current.strategy || 'None' : 'None';
    const iterationText = current ? `Виток #${current.iteration}` : 'Виток #0';

    return content
        .replace(/(\*\s+\*\*Текущий шаг роадмапа:\*\*\s*)`?[^`\n]+`?/i, `$1\`${currentText}\``)
        .replace(/(\*\s+\*\*Глобальный статус узла:\*\*\s*)`?[^`\n]+`?/i, `$1\`${statusText}\``)
        .replace(/(\*\s+\*\*Выбранная стратегия:\*\*\s*)`?[^`\n]+`?/i, `$1\`${strategyText}\``)
        .replace(/(\*\s+\*\*Номер текущего витка цикла:\*\*\s*)`?[^`\n]+`?/i, `$1\`${iterationText}\``);
}

function extractHumanNotes(content) {
    const match = content.match(/# .*ЖУРНАЛ ВМЕШАТЕЛЬСТВА.*\r?\n([\s\S]*?)(?=\r?\n---|\r?\n#\s|$)/i);
    if (!match) return null;
    const lines = match[1].trim().split(/\r?\n/).filter(line => line.trim());
    return lines.slice(-3).map(line => line.replace(/^\*\s*/, '').trim()).join(' | ') || null;
}

function normalizeTaskStatus(status) {
    const value = String(status || '').toUpperCase();
    if (value === 'DONE' || value === 'TASK_COMPLETE') return 'DONE';
    if (value === 'CRITICAL_FAIL') return 'CRITICAL_FAIL';
    if (value === 'IN_PROGRESS') return 'IN_PROGRESS';
    return 'PENDING';
}

function normalizeNodeStatus(status) {
    const value = String(status || '').toUpperCase().replace(/`/g, '');
    if (VALID_NODE_STATUSES.has(value)) return value;
    if (value === 'SUCCESS') return 'DONE';
    if (value === 'FAIL') return 'BLOCKED';
    return 'PENDING';
}

function normalizeValidationType(type) {
    const value = String(type || '').toLowerCase();
    return ['auto', 'ai', 'human'].includes(value) ? value : 'ai';
}

// Тип артефакта узла (WS-5, гибрид «двух мозгов»):
//   code — код пишет IDE-агент в рабочее дерево, судья смотрит git diff;
//   text — сценарий/ГДД/текст, автономные стратегии допустимы, судья смотрит артефакты.
function normalizeArtifactKind(kind) {
    const value = String(kind || '').toLowerCase();
    return value === 'text' ? 'text' : 'code';
}

// Criticality level (L0..L3) for judge routing. Explicit value wins; otherwise
// derive from validation_type — auto/deterministic → L0 (oracle only, no LLM),
// everything else → L1 (standard). Deep-tier or explicit harness mode is
// escalated at the caller (see deriveCriticality in validator.js).
export function normalizeCriticalityLevel(value, validationType = 'ai') {
    if (value === null || value === undefined || value === '') {
        return validationType === 'auto' ? 'L0' : 'L1';
    }
    const s = String(value).toUpperCase();
    if (['L0', 'L1', 'L2', 'L3'].includes(s)) return s;
    const n = Number.parseInt(s.replace(/[^0-9]/g, ''), 10);
    if (n >= 0 && n <= 3) return `L${n}`;
    return 'L1';
}

// Порог drift-guard: допустимый диапазон 3-5, дефолт 4.
function clampSyncInterval(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return 4;
    return Math.min(5, Math.max(3, n));
}

function normalizeDod(dod) {
    if (!Array.isArray(dod) || dod.length === 0) {
        return [{ criterion: 'Критерий качества не задан в roadmap.', done: false }];
    }

    return dod.map(item => ({
        criterion: String(item.criterion || item.text || '').trim() || 'Без описания',
        done: Boolean(item.done)
    }));
}

function normalizeGoal(goal, maxIterations) {
    if (!goal || typeof goal !== 'object') return null;
    const outcome = String(goal.outcome || '').trim();
    const proof = String(goal.proof || '').trim();
    if (!outcome || !proof) return null;

    const maxNoProgress = toInt(goal.max_no_progress, Math.min(2, maxIterations));
    return {
        outcome,
        proof,
        constraints: Array.isArray(goal.constraints)
            ? goal.constraints.map(item => String(item).trim()).filter(Boolean)
            : [],
        max_no_progress: Math.max(1, Math.min(maxIterations, maxNoProgress)),
        on_limit: 'CRITICAL_FAIL'
    };
}

function normalizeWorkflowSelection(workflow) {
    if (!workflow || typeof workflow !== 'object') return null;
    const mode = String(workflow.mode || '').toLowerCase();
    if (!['classic', 'goal_loop', 'workflow'].includes(mode)) return null;
    const profile = workflow.profile ? String(workflow.profile).trim() : null;
    if (mode === 'workflow' && (!profile || !isKnownWorkflowProfile(profile))) return null;
    return {
        mode,
        profile: mode === 'workflow' ? profile : null,
        reason: workflow.reason ? String(workflow.reason).trim() : null,
        limits: getWorkflowLimits(mode === 'workflow' ? profile : null),
        refused: Boolean(workflow.refused)
    };
}

function normalizeDeliverables(deliverables) {
    if (!Array.isArray(deliverables)) return [];
    return deliverables
        .map(item => {
            if (typeof item === 'string') return { path: item };
            if (item && item.path) return { path: String(item.path), kind: item.kind || undefined };
            return null;
        })
        .filter(Boolean);
}

function normalizeHistoryEntry(entry) {
    return {
        iteration: toInt(entry.iteration, 0),
        result: String(entry.result || entry.status || 'PENDING').toUpperCase(),
        detail: entry.detail || entry.reason || null,
        at: entry.at || null
    };
}

function toInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export async function buildPreamble(taskDir, node) {
    const isCode = (node?.artifact_kind || 'code') === 'code';
    const constraints = await parseConstraints(taskDir);
    const constraintsText = constraints.digest 
        ? constraints.digest.split('; ').map(c => `• ${c}`).join('\n') 
        : 'Ограничений не задано.';

    let preamble = `### ОГРАНИЧЕНИЯ ЗАДАЧИ:\n${constraintsText}\n\n`;

    if (isCode) {
        preamble += `### СТАНДАРТЫ КОДА (UNITY & C#):\n` +
            `• Использовать только TextMeshPro для текстовых элементов (TextMeshProUGUI/TMP_Text).\n` +
            `• Кэшировать ссылки в Awake; использовать TryGetComponent для безопасного доступа.\n` +
            `• Категорически запрещено использовать GameObject.Find, Transform.Find, FindObjectOfType.\n` +
            `• Ссылка на полный код-стайл: [code_style.md](file:///Assets/KBPro/kbpro-ai-docs/kbpro-wiki/raw/code_style.md)\n\n`;
    }

    return preamble.trim();
}

/**
 * Парсит git diff и сжимает его до указания файла, номеров строк и самого изменения,
 * удаляя весь неизмененный контекст.
 * @param {string} diffText
 * @returns {string}
 */
export function parseCompactDiff(diffText) {
    if (!diffText) return '(нет изменений)';
    const lines = diffText.split(/\r?\n/);
    let compact = [];
    let currentFile = null;
    let currentLineNum = 0;

    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            const match = line.match(/b\/(.+)$/);
            currentFile = match ? match[1] : 'unknown';
            compact.push(`\nФайл: ${currentFile}`);
            currentLineNum = 0;
            continue;
        }
        if (line.startsWith('@@ ')) {
            const match = line.match(/\+(\d+)/);
            if (match) {
                currentLineNum = parseInt(match[1], 10);
            }
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            compact.push(`Строка ${currentLineNum}: [ДОБАВЛЕНО] ${line.slice(1)}`);
            currentLineNum++;
            continue;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            compact.push(`Строка ${currentLineNum}: [УДАЛЕНО] ${line.slice(1)}`);
            continue;
        }
        if (!line.startsWith('\\') && currentFile) {
            currentLineNum++;
        }
    }
    return compact.join('\n');
}
