// harnessConfig.js — loader for the shared harness.config.json (+ optional local override).
//
// Phase-2 wiring: the config is the ONE source of truth for role→tier→model mapping,
// the judge pool, criticality→judge tier policy, and per-role limits (timeouts,
// retries, token budgets). Consumers must call getters here instead of hard-coding
// values. If the config is missing or broken, we WARN and fall back to hard-coded
// defaults so the harness keeps working (never crash on a bad config).
//
// API (all sync — the config is a tiny JSON):
//   loadConfig()                    → returns the merged config object (cached).
//   getModelForRole(role, opts?)   → { bin, tier, model, family } or null.
//   getJudgePool()                  → [{ id, family }, ...]
//   getLimits(role)                 → { timeout_ms, retries, budget_tokens }
//   getCriticalityJudgeTier(level) → { judge, tier, note }
//   resolveModelForBin(bin, tier)  → concrete model string (first variant) or null
//   familyOfBin(bin)                → 'anthropic'|'google'|'openai'|null
//
// The loader is intentionally sync (readFileSync) so it can be used from any code
// path without infecting call sites with async plumbing. It is only read once per
// process (unless HARNESS_CONFIG_RELOAD=1). File I/O touches two small JSONs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'harness.config.json');
const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'harness.config.local.json');

// Fallback config used if harness.config.json is missing/broken. Mirrors the values
// hard-coded in the pre-phase-2 harness so nothing changes when the file is absent.
const FALLBACK_CONFIG = {
    version: 1,
    tiers: ['cheap', 'medium', 'high', 'max', 'top'],
    available_models: {
        claude:            { family: 'anthropic', access: 'cli', cost: 'paid', latency_hint_ms: 9000,
            variants: { cheap: ['sonnet'], medium: ['opus'], high: ['opus'], max: ['opus'], top: ['opus'] } },
        'claude-subagent': { family: 'anthropic', access: 'ide_subagent', cost: 'included', latency_hint_ms: 12000,
            variants: { cheap: ['sonnet'], medium: ['opus'], high: ['opus'], max: ['opus'], top: ['opus'] } },
        agy:               { family: 'google', access: 'cli', cost: 'free_tier', latency_hint_ms: 30000,
            variants: { cheap: [], medium: [], high: [], max: [], top: [] } },
        codex:             { family: 'openai', access: 'cli', cost: 'paid', latency_hint_ms: 15000,
            variants: { cheap: [], medium: [], high: [], max: [], top: [] } }
    },
    agent_roles: {
        worker:     { default_tier: 'cheap', allowed_tiers: ['cheap', 'medium'], families: ['claude', 'agy', 'codex', 'claude-subagent'] },
        judge:      { default_tier: 'medium', allowed_tiers: ['medium', 'high', 'max'], families: ['agy', 'codex', 'claude-subagent'], cross_family_preferred: true, read_only: true },
        evaluator:  { default_tier: 'high', allowed_tiers: ['medium', 'high', 'max'], families: ['agy', 'codex', 'claude-subagent'], cross_family_preferred: true, read_only: true },
        reasoner:   { default_tier: 'max', allowed_tiers: ['max'], families: ['claude', 'agy', 'codex'] },
        researcher: { default_tier: 'max', allowed_tiers: ['high', 'max'], families: ['claude', 'agy', 'codex'] },
        manager:    { default_tier: 'top', allowed_tiers: ['top', 'max'], families: ['claude', 'agy', 'codex'] }
    },
    judge_pool: [
        { id: 'agy', family: 'google' },
        { id: 'codex', family: 'openai' },
        { id: 'claude-subagent', family: 'anthropic' }
    ],
    criticality_judge_tier: {
        L0: { judge: 'none',   tier: null,     note: 'deterministic oracle only' },
        L1: { judge: 'single', tier: 'medium', note: 'standard' },
        L2: { judge: 'single', tier: 'high',   note: 'important' },
        L3: { judge: 'quorum', tier: 'max',    note: 'critical' }
    },
    per_role_limits: {
        worker:     { timeout_ms: 120000, retries: 1, budget_tokens: 60000 },
        judge:      { timeout_ms: 45000,  retries: 1, budget_tokens: 20000 },
        evaluator:  { timeout_ms: 60000,  retries: 1, budget_tokens: 30000 },
        reasoner:   { timeout_ms: 180000, retries: 0, budget_tokens: 120000 },
        researcher: { timeout_ms: 180000, retries: 0, budget_tokens: 120000 },
        manager:    { timeout_ms: 0,      retries: 0, budget_tokens: 0 }
    }
};

let CACHED = null;
let LOAD_WARNED = false;

function stripBom(s) { return String(s).replace(/^﻿/, ''); }

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = stripBom(fs.readFileSync(filePath, 'utf-8'));
        return JSON.parse(raw);
    } catch (err) {
        if (!LOAD_WARNED) {
            console.warn(`[harnessConfig] WARN: не удалось прочитать ${filePath}: ${err.message} — используем fallback.`);
            LOAD_WARNED = true;
        }
        return null;
    }
}

// Recursive deep-merge: objects merge key-by-key, arrays and scalars in `override`
// wholly replace those in `base`. Matches the "local wins" precedence documented
// in config/README.md.
function deepMerge(base, override) {
    if (override === undefined) return base;
    if (base === null || base === undefined) return override;
    if (Array.isArray(base) || Array.isArray(override)) return override;
    if (typeof base !== 'object' || typeof override !== 'object') return override;
    const out = { ...base };
    for (const k of Object.keys(override)) {
        out[k] = deepMerge(base[k], override[k]);
    }
    return out;
}

function validateConfig(cfg) {
    // Minimal validation: refuse silently-broken configs (missing tables). The
    // caller falls back to defaults when this returns false.
    if (!cfg || typeof cfg !== 'object') return false;
    if (!cfg.available_models || typeof cfg.available_models !== 'object') return false;
    if (!cfg.agent_roles || typeof cfg.agent_roles !== 'object') return false;
    if (!Array.isArray(cfg.judge_pool)) return false;
    if (!cfg.criticality_judge_tier || typeof cfg.criticality_judge_tier !== 'object') return false;
    if (!cfg.per_role_limits || typeof cfg.per_role_limits !== 'object') return false;
    return true;
}

export function loadConfig({ force = false } = {}) {
    if (CACHED && !force && process.env.HARNESS_CONFIG_RELOAD !== '1') return CACHED;
    const base = readJsonSafe(CONFIG_PATH);
    const local = readJsonSafe(LOCAL_CONFIG_PATH);
    let merged = base ? (local ? deepMerge(base, local) : base) : null;
    if (!validateConfig(merged)) {
        if (!LOAD_WARNED) {
            console.warn('[harnessConfig] WARN: harness.config.json отсутствует или невалиден — используем встроенный fallback.');
            LOAD_WARNED = true;
        }
        merged = FALLBACK_CONFIG;
    }
    CACHED = merged;
    return CACHED;
}

/**
 * Pick a preferred (bin, tier) pair for a role. If `bin` is given, we only check
 * that this role allows that binary. If `tier` is given, we override the default.
 * Returns null when the role/bin is unknown.
 */
export function getModelForRole(role, { bin = null, tier = null } = {}) {
    const cfg = loadConfig();
    const roleDef = cfg.agent_roles?.[role];
    if (!roleDef) return null;

    const chosenTier = tier || roleDef.default_tier || 'medium';
    const families = roleDef.families || Object.keys(cfg.available_models);
    const chosenBin = bin || families[0];
    const modelEntry = cfg.available_models?.[chosenBin];
    if (!modelEntry) return null;
    const model = resolveModelForBin(chosenBin, chosenTier);
    return {
        bin: chosenBin,
        tier: chosenTier,
        family: modelEntry.family || null,
        model
    };
}

export function resolveModelForBin(bin, tier) {
    const cfg = loadConfig();
    const entry = cfg.available_models?.[bin];
    if (!entry || !entry.variants) return null;
    const variants = entry.variants[tier] || entry.variants[cfg.agent_roles?.worker?.default_tier || 'cheap'];
    if (!Array.isArray(variants) || variants.length === 0) return null;
    return variants[0];
}

export function familyOfBin(bin) {
    const cfg = loadConfig();
    return cfg.available_models?.[bin]?.family || null;
}

export function getJudgePool() {
    const cfg = loadConfig();
    return Array.isArray(cfg.judge_pool) ? cfg.judge_pool.slice() : [];
}

export function getLimits(role) {
    const cfg = loadConfig();
    const l = cfg.per_role_limits?.[role];
    if (!l) return { timeout_ms: null, retries: null, budget_tokens: null };
    return {
        timeout_ms: Number.isFinite(l.timeout_ms) ? l.timeout_ms : null,
        retries: Number.isFinite(l.retries) ? l.retries : null,
        budget_tokens: Number.isFinite(l.budget_tokens) ? l.budget_tokens : null
    };
}

export function getCriticalityJudgeTier(level) {
    const cfg = loadConfig();
    const key = String(level || '').toUpperCase();
    return cfg.criticality_judge_tier?.[key] || null;
}

// Combine policy for L3 quorum/dual_order. 'all' = every quorum member must
// PASS (fail-closed, default). 'majority' = strictly more than half must PASS.
// Missing/invalid config values fall back to 'all' — L3 must never silently
// weaken.
export function getQuorumPolicy() {
    const cfg = loadConfig();
    const p = String(cfg?.quorum_policy || '').toLowerCase();
    return (p === 'majority') ? 'majority' : 'all';
}

export default {
    loadConfig,
    getModelForRole,
    getJudgePool,
    getLimits,
    getCriticalityJudgeTier,
    getQuorumPolicy,
    resolveModelForBin,
    familyOfBin
};
