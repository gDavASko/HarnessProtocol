import fs from 'fs/promises';
import path from 'path';
import { findRepoRoot } from '../harnessPaths.js';

/**
 * Skill & Pattern Distillation (Hermes & Ratchet inspired)
 * Synthesizes reusable skill procedures from successfully resolved complex / L3 tasks.
 */
export async function distillSkillIfEligible(taskDir, node, solutionSummary) {
    const isL3 = node.criticality === 'L3';
    const isMultiIter = (node.iteration || 1) >= 2;

    if (!isL3 && !isMultiIter) {
        return { distilled: false, reason: 'Node criticality < L3 and iterations < 2' };
    }

    // Дистиллируем навык ТОЛЬКО из верифицированного успеха. Если сводка решения —
    // это ошибка/фолбэк модели (например, провал live-вызова CLI/API), запись в
    // трекаемый .agents/skills/ засоряет дерево «навыком» из мусора. Пропускаем.
    const summaryStr = String(solutionSummary || '');
    if (/\[Model Fallback Error\]|no stdin data received|NOT_FOUND|"error"\s*:|Ошибка \w+ API|ENOENT|ECONNREFUSED|timed out/i.test(summaryStr)) {
        return { distilled: false, reason: 'Solution summary is an error/fallback — refusing to distill a skill from a non-verified result.' };
    }

    try {
        const repoRoot = findRepoRoot(taskDir);
        const skillSlug = `distilled-${node.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
        const skillDir = path.resolve(repoRoot, '.agents/skills', skillSlug);
        
        await fs.mkdir(skillDir, { recursive: true });

        const skillContent = `---
name: ${skillSlug}
description: Automatically distilled recipe from successfully closed node ${node.id} (${node.title}).
---

# ${node.title} (${node.id})

## Strategy
- **Applied Strategy**: ${node.strategy || 'adaptive'}
- **Resolved at Iteration**: #${node.iteration || 1}
- **Artifact Kind**: ${node.artifact_kind || 'text'}

## Verified Solution Summary
${solutionSummary || 'Solution verified and passed State Gates.'}

## Key Rules & Fences Learned
${(node.dod || []).map((d, i) => `- Criterion ${i + 1}: ${typeof d === 'string' ? d : d.criterion}`).join('\n')}
`;

        const skillFile = path.join(skillDir, 'SKILL.md');
        await fs.writeFile(skillFile, skillContent, 'utf-8');

        return {
            distilled: true,
            skillName: skillSlug,
            skillPath: skillFile
        };
    } catch (err) {
        return { distilled: false, error: err.message };
    }
}
