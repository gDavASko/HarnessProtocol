import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';

const INACTIVE = { activation: 'not_installed', promotion_requires_review: true };
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;

async function candidateDirectory(taskDir, slug) {
    if (typeof taskDir !== 'string' || !path.isAbsolute(taskDir)) throw new Error('An explicit absolute task directory is required');
    const root = await fs.realpath(taskDir);
    const segments = root.toLowerCase().split(/[\\/]+/);
    if (segments.some((segment, index) => ['.agents', '.codex', '.claude', '.gemini'].includes(segment) && segments[index + 1] === 'skills')) {
        throw new Error('Skill candidates cannot be written under an active skill discovery directory');
    }
    let directory = root;
    // Inspect each ancestor before creating the next. A junction must never
    // redirect task-local output into an installed skill directory.
    for (const segment of ['.harness', 'skill-candidates', slug, randomUUID()]) {
        directory = path.join(directory, segment);
        try { await fs.mkdir(directory); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(await fs.realpath(directory)) !== normalized(directory)) {
            throw new Error('Skill candidate directory redirects outside its task-local location');
        }
    }
    return directory;
}

/**
 * Skill & Pattern Distillation (Hermes & Ratchet inspired)
 * Synthesizes INACTIVE candidates from resolved complex / L3 tasks. Review and
 * installation are separate explicit operations; this function never promotes
 * instructions into any active skill discovery directory.
 */
export async function distillSkillIfEligible(taskDir, node, solutionSummary) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) return { distilled: false, ...INACTIVE, reason: 'An explicit node identity is required' };
    const isL3 = node.criticality === 'L3';
    const isMultiIter = (node.iteration || 1) >= 2;

    if (!isL3 && !isMultiIter) {
        return { distilled: false, ...INACTIVE, reason: 'Node criticality < L3 and iterations < 2' };
    }

    // Skip explicit failed outputs. Eligibility is only a candidate-generation
    // heuristic; it is not independent evidence or permission to install skills.
    const summaryStr = String(solutionSummary || '');
    if (/\[Model Fallback Error\]|no stdin data received|NOT_FOUND|"error"\s*:|Ошибка \w+ API|ENOENT|ECONNREFUSED|timed out/i.test(summaryStr)) {
        return { distilled: false, ...INACTIVE, reason: 'Solution summary is an error/fallback — refusing to distill a skill from a non-verified result.' };
    }

    try {
        const skillSlug = `distilled-${node.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
        const skillDir = await candidateDirectory(taskDir, skillSlug);

        const skillContent = `---
name: ${skillSlug}
description: Automatically distilled, unreviewed candidate from node ${node.id} (${node.title}).
activation: not_installed
promotion_requires_review: true
---

# ${node.title} (${node.id})

This is an inactive, automatically generated candidate. Its instructions require review before any explicit installation or reuse.

## Strategy
- **Applied Strategy**: ${node.strategy || 'adaptive'}
- **Resolved at Iteration**: #${node.iteration || 1}
- **Artifact Kind**: ${node.artifact_kind || 'text'}

## Candidate Solution Summary
${solutionSummary || 'No solution summary supplied; review is required.'}

## Key Rules & Fences Learned
${(node.dod || []).map((d, i) => `- Criterion ${i + 1}: ${typeof d === 'string' ? d : d.criterion}`).join('\n')}
`;

        const skillFile = path.join(skillDir, 'SKILL.md');
        await fs.writeFile(skillFile, skillContent, { encoding: 'utf-8', flag: 'wx' });

        return {
            distilled: true,
            ...INACTIVE,
            skillName: skillSlug,
            skillPath: skillFile
        };
    } catch (err) {
        return { distilled: false, ...INACTIVE, error: err.message };
    }
}
