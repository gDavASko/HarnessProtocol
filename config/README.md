# Harness Config (`harness.config.json`)

The single, user-tunable source of truth for **which model family and tier each agent
role uses**, the **judge pool**, and **per-role limits**. Concrete model ids live here
(and in the legacy `Scripts/llm-config.json` for the hot judge/probe path) — never in
protocol prose or role docs. This file is engine-agnostic; per-IDE agent files are
generated from `../agents/roles/*.md` + this config (see `../agents/AGENT-DEFINITION-SPEC.md`).

Locally-available families only: `agy` (google), `codex` (openai), `claude`
(anthropic), and `claude-subagent` (a fresh-context Claude Code subagent, family
anthropic). Hosted external-API vendors are a reserved future slot
(`external_api_slot`, disabled by default).

---

## Schema

| Key | Type | Meaning |
|:----|:-----|:--------|
| `version` | int | Config schema version. |
| `tiers` | string[] | Ordered capability ladder: `cheap < medium < high < max < top`. |
| `available_models` | map | `<id> → { family, access, cost, latency_hint_ms, variants }`. `id` is the CLI/probe binary (`claude`,`agy`,`codex`) or `claude-subagent`. |
| `available_models.*.family` | string | `anthropic` \| `google` \| `openai`. Used for cross-family judge exclusion. |
| `available_models.*.access` | string | `cli` \| `ide_subagent` \| (future) `http`. |
| `available_models.*.cost` | string | Coarse hint: `free_tier` \| `included` \| `paid`. |
| `available_models.*.latency_hint_ms` | int | Rough cold-start/turn latency for selection tie-breaks. |
| `available_models.*.variants` | map | `tier → [model id, …]`. First entry is the preferred model for that tier. |
| `external_api_slot` | object | Reserved. `enabled:false` + empty `providers` until hosted APIs are wired. |
| `agent_roles` | map | `role → { default_tier, allowed_tiers, families, cross_family_required?, read_only? }`. |
| `judge_pool` | array | Ordered `{ id, family }` of judges that may grade work (`agy`, `codex`, `claude-subagent`). |
| `criticality_judge_tier` | map | `L0..L3 → { judge, tier, note }`. Drives `judgeSelector.js`. |
| `per_role_limits` | map | `role → { timeout_ms, retries, budget_tokens }`. `0` = unbounded/interactive. |
| `env_overrides` | map | Names of env vars the running harness already honours. |

### Role → tier (defaults)
| Role | default_tier | Rationale (Model-Tier Doctrine) |
|:-----|:-------------|:--------------------------------|
| worker | cheap | mechanical execution |
| judge | medium | escalated by criticality |
| evaluator | high | steers downstream expensive work |
| reasoner | max | hardest reasoning |
| researcher | max | shallow research corrupts decisions |
| manager | top | orchestration / control |

### Criticality → judge
| Level | Meaning | Judge |
|:------|:--------|:------|
| L0 | trivial / predefined code | deterministic oracle only, **no LLM judge** |
| L1 | standard | one **medium** cross-family judge |
| L2 | important | one **strong** cross-family judge |
| L3 | critical / high cost of error | **strong judge + quorum** (or dual-order) |

---

## How to override per machine

Do **not** edit `harness.config.json` for machine-local tweaks (it is the shared
default and is version-controlled). Instead create a sibling **`harness.config.local.json`**
containing only the keys you want to change; consumers **deep-merge** it over the
default (local wins). Example — this machine has no working `codex`, prefers Gemini
Flash for cheap work, and shortens the judge timeout:

```json
{
  "judge_pool": [
    { "id": "agy", "family": "google" },
    { "id": "claude-subagent", "family": "anthropic" }
  ],
  "available_models": {
    "agy": { "variants": { "cheap": ["Gemini 2.0 Flash"] } }
  },
  "per_role_limits": {
    "judge": { "timeout_ms": 30000 }
  }
}
```

Precedence (lowest → highest): `harness.config.json` → `harness.config.local.json` →
environment variables listed in `env_overrides` (e.g. `HARNESS_JUDGE_TIMEOUT_MS`).
`harness.config.local.json` should be git-ignored per machine.

**Adding a future hosted-API judge:** set `external_api_slot.enabled = true` and add a
provider mirroring an `available_models` entry with `access:"http"` and an `env_var`
naming the API key; then add it to `judge_pool` with its `family`. The cross-family
rules in `judge-selection.md` apply unchanged.
