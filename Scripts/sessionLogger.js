import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { readRoadmap, readState, UTF8_BOM } from './harnessState.js';
import { findRepoRoot } from './harnessPaths.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────────────────────────────────────────────────────────────
// CLI argument parsing
// ────────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        taskDir: args[0],
        prompt: null,
        summary: null,
        changedFiles: null,   // optional: comma-separated list of changed files
        // Publish into the kbpro-ai-docs submodule NewData/ ingest buffer only on
        // explicit request; by default log to a local non-submodule dir.
        publish: process.env.HARNESS_PUBLISH_SESSION === '1'
    };

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--prompt' && args[i + 1]) options.prompt = args[++i];
        if (args[i] === '--summary' && args[i + 1]) options.summary = args[++i];
        if (args[i] === '--changed-files' && args[i + 1]) options.changedFiles = args[++i];
        if (args[i] === '--publish') options.publish = true;
    }
    return options;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
async function getGitUser() {
    try {
        const { stdout } = await execAsync('git config user.name');
        return stdout.trim() || 'unknown_developer';
    } catch {
        return 'unknown_developer';
    }
}

async function getGitChangedFiles(taskDir) {
    try {
        const { stdout } = await execAsync('git diff --name-only HEAD~1 HEAD', { cwd: taskDir });
        const files = stdout.trim().split('\n').filter(f => f.length > 0);
        return files.length > 0 ? files : null;
    } catch {
        // Fallback: uncommitted changes
        try {
            const { stdout } = await execAsync('git diff --name-only', { cwd: taskDir });
            const files = stdout.trim().split('\n').filter(f => f.length > 0);
            return files.length > 0 ? files : null;
        } catch {
            return null;
        }
    }
}

function formatDuration(minutes) {
    if (minutes < 60) return `${minutes} мин.`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} ч. ${m} мин.` : `${h} ч.`;
}

function statusEmoji(status) {
    switch (status) {
        case 'DONE': return '✅';
        case 'IN_PROGRESS': return '🔄';
        case 'PENDING': return '⏳';
        case 'BLOCKED': return '🚫';
        case 'CRITICAL_FAIL': return '❌';
        default: return '❓';
    }
}

function severityTag(result) {
    if (!result) return '';
    if (result === 'PASS') return '✅';
    if (result === 'FAIL') return '❌';
    if (result.includes('COMPACTED')) return '📦';
    return '⚠️';
}

// ────────────────────────────────────────────────────────────────
// Report section builders
// ────────────────────────────────────────────────────────────────
function buildHeader(gitUser, cleanGitUser, now, durationMinutes, taskId, taskTitle, roadmap) {
    const statusIcon = statusEmoji(roadmap?.status || 'DONE');
    return `# ${statusIcon} Лог сессии ИИ | ${taskId}

| Параметр | Значение |
|---|---|
| **Задача** | ${taskTitle} |
| **Разработчик** | ${gitUser} (\`${cleanGitUser}\`) |
| **Статус** | ${roadmap?.status || 'DONE'} |
| **Дата начала** | ${roadmap?.created_at ? new Date(roadmap.created_at).toLocaleString('ru-RU') : '—'} |
| **Дата окончания** | ${now.toLocaleString('ru-RU')} |
| **Общий хронометраж** | ${formatDuration(durationMinutes)} |
| **Всего узлов** | ${roadmap?.nodes?.length || 0} |
| **Всего итераций** | ${roadmap?.nodes?.reduce((s, n) => s + (n.iteration || 0), 0) || 0} |
`;
}

function buildPromptSection(promptText) {
    return `## 📥 Исходный запрос пользователя

${promptText}
`;
}

function buildNodeTimeline(nodes) {
    if (!nodes || nodes.length === 0) return '';

    let md = `## 📋 Хронология узлов

| # | Узел | Статус | Итерации | Стратегия |
|---|---|---|---|---|\n`;

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const icon = statusEmoji(n.status);
        const iter = `${n.iteration || 0}/${n.max_iterations || 5}`;
        md += `| ${i + 1} | ${icon} **${n.id}**: ${n.title || '—'} | ${n.status} | ${iter} | ${n.strategy || '—'} |\n`;
    }

    md += '\n';
    return md;
}

function buildNodeDetails(nodes) {
    if (!nodes || nodes.length === 0) return '';

    let md = `## 🔍 Детали по узлам\n\n`;

    for (const n of nodes) {
        md += `### ${statusEmoji(n.status)} ${n.id}: ${n.title || 'Без названия'}\n\n`;

        // DoD checklist
        if (n.dod && n.dod.length > 0) {
            md += `**Definition of Done:**\n`;
            for (const d of n.dod) {
                const check = d.done ? '[x]' : '[ ]';
                md += `- ${check} ${d.criterion}\n`;
            }
            md += '\n';
        }

        // Deliverables
        if (n.deliverables && n.deliverables.length > 0) {
            md += `**Артефакты:**\n`;
            for (const d of n.deliverables) {
                md += `- 📄 \`${d}\`\n`;
            }
            md += '\n';
        }

        // L1 file
        if (n.l1_file) {
            md += `**L1 файл:** \`${n.l1_file}\`\n\n`;
        }

        // Last error
        if (n.last_error) {
            md += `**Последняя ошибка:** ${n.last_error}\n\n`;
        }

        // Iteration history
        if (n.history && n.history.length > 0) {
            md += `**История итераций:**\n\n`;
            md += `| Итерация | Результат | Время | Детали |\n`;
            md += `|---|---|---|---|\n`;
            for (const h of n.history) {
                const time = h.at ? new Date(h.at).toLocaleString('ru-RU') : '—';
                const detail = (h.detail || '—').replace(/\|/g, '\\|').substring(0, 200);
                md += `| #${h.iteration} | ${severityTag(h.result)} ${h.result} | ${time} | ${detail} |\n`;
            }
            md += '\n';
        }

        md += `---\n\n`;
    }

    return md;
}

function buildChangedFiles(files) {
    if (!files || files.length === 0) return '';

    let md = `## 📝 Изменённые файлы (${files.length})\n\n`;

    // Group by directory
    const groups = {};
    for (const f of files) {
        const dir = path.dirname(f) || '.';
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push(path.basename(f));
    }

    const sortedDirs = Object.keys(groups).sort();
    for (const dir of sortedDirs) {
        md += `**\`${dir}/\`**\n`;
        for (const file of groups[dir].sort()) {
            md += `- \`${file}\`\n`;
        }
        md += '\n';
    }

    return md;
}

function buildErrorLog(nodes) {
    const errors = [];
    for (const n of (nodes || [])) {
        for (const h of (n.history || [])) {
            if (h.result === 'FAIL' || h.result === 'CRITICAL_FAIL') {
                errors.push({
                    node: n.id,
                    iteration: h.iteration,
                    detail: h.detail || '—',
                    at: h.at
                });
            }
        }
    }

    if (errors.length === 0) return '';

    let md = `## ⚠️ Журнал ошибок (${errors.length})\n\n`;
    md += `| Узел | Итерация | Время | Описание |\n`;
    md += `|---|---|---|---|\n`;

    for (const e of errors) {
        const time = e.at ? new Date(e.at).toLocaleString('ru-RU') : '—';
        const detail = e.detail.replace(/\|/g, '\\|').substring(0, 150);
        md += `| ${e.node} | #${e.iteration} | ${time} | ${detail} |\n`;
    }

    md += '\n';
    return md;
}

function buildSummary(summaryText) {
    return `## 📤 Итоговое резюме от ИИ

${summaryText}
`;
}

function buildMetrics(roadmap, durationMinutes) {
    if (!roadmap || !roadmap.nodes) return '';

    const nodes = roadmap.nodes;
    const totalNodes = nodes.length;
    const doneNodes = nodes.filter(n => n.status === 'DONE').length;
    const failedNodes = nodes.filter(n => n.status === 'CRITICAL_FAIL').length;
    const totalIterations = nodes.reduce((s, n) => s + (n.iteration || 0), 0);
    const totalErrors = nodes.reduce((s, n) =>
        s + (n.history || []).filter(h => h.result === 'FAIL' || h.result === 'CRITICAL_FAIL').length, 0);
    const avgIterPerNode = totalNodes > 0 ? (totalIterations / totalNodes).toFixed(1) : '0';
    const successRate = totalNodes > 0 ? ((doneNodes / totalNodes) * 100).toFixed(0) : '0';

    return `## 📊 Метрики сессии

| Метрика | Значение |
|---|---|
| Узлов завершено | ${doneNodes}/${totalNodes} (${successRate}%) |
| Узлов провалено | ${failedNodes} |
| Общее число итераций | ${totalIterations} |
| Среднее итераций на узел | ${avgIterPerNode} |
| Общее число ошибок | ${totalErrors} |
| Время работы | ${formatDuration(durationMinutes)} |
`;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
async function main() {
    const options = parseArgs();
    if (!options.taskDir) {
        console.error(JSON.stringify({ error: 'Укажите путь к директории задачи.' }));
        process.exit(1);
    }

    try {
        const gitUser = await getGitUser();
        const cleanGitUser = gitUser.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

        let roadmap = null;
        try {
            roadmap = await readRoadmap(options.taskDir);
        } catch {
            // Если не удалось прочитать роадмап (задача вне Harness)
        }

        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');

        // Расчет хронометража
        let durationMinutes = 0;
        if (roadmap && roadmap.created_at) {
            const start = new Date(roadmap.created_at);
            const diffMs = now - start;
            durationMinutes = Math.max(1, Math.round(diffMs / 1000 / 60));
        }

        const taskId = roadmap ? roadmap.task_id : 'NO_TASK';
        const taskTitle = roadmap ? roadmap.title : 'Внеконтекстная сессия';

        const promptText = options.prompt || 'Выполнение задачи: ' + taskTitle;
        const summaryText = options.summary || 'Задача решена успешно (подробности не предоставлены)';

        // Collect changed files
        let changedFiles = null;
        if (options.changedFiles) {
            changedFiles = options.changedFiles.split(',').map(f => f.trim()).filter(Boolean);
        } else {
            changedFiles = await getGitChangedFiles(options.taskDir);
        }

        // ─── Build full report ───
        const sections = [
            buildHeader(gitUser, cleanGitUser, now, durationMinutes, taskId, taskTitle, roadmap),
            '---\n',
            buildPromptSection(promptText),
            '---\n',
            buildNodeTimeline(roadmap?.nodes),
            buildNodeDetails(roadmap?.nodes),
            buildErrorLog(roadmap?.nodes),
            buildChangedFiles(changedFiles),
            buildMetrics(roadmap, durationMinutes),
            '---\n',
            buildSummary(summaryText),
        ];

        const report = sections.filter(s => s && s.trim()).join('\n');

        // ─── Save location ───
        // Default: local non-submodule dir (no submodule churn). Only with
        // --publish (or HARNESS_PUBLISH_SESSION=1) write into the kbpro-ai-docs
        // NewData/ ingest buffer.
        const sessionsDir = options.publish
            ? path.resolve(__dirname, '../../NewData/sessions-wiki')
            : path.join(findRepoRoot(), '.harness_logs', 'sessions');
        await fs.mkdir(sessionsDir, { recursive: true });

        const filename = `${cleanGitUser}_${dateStr}_${timeStr}_${taskId}.md`;
        const filePath = path.join(sessionsDir, filename);

        await fs.writeFile(filePath, UTF8_BOM + report, 'utf-8');

        console.log(JSON.stringify({
            status: 'SUCCESS',
            saved_to: filePath.replace(/\\/g, '/'),
            user: gitUser,
            duration: durationMinutes,
            nodes_total: roadmap?.nodes?.length || 0,
            nodes_done: roadmap?.nodes?.filter(n => n.status === 'DONE').length || 0,
            changed_files: changedFiles?.length || 0,
            report_lines: report.split('\n').length
        }));

    } catch (err) {
        console.error(JSON.stringify({ error: err.message, stack: err.stack }));
        process.exit(1);
    }
}

main().catch(err => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
});
