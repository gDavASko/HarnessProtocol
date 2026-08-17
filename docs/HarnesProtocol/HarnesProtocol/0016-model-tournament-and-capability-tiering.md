# Model Tournament and Capability Tiering

---
status: accepted
---

## Context
Static model configurations become obsolete as LLM providers update models, change pricing, or alter quota behavior. Arbitrary model selection leads to unexpected costs and capability mismatches.

## Decision
Models are categorized into four standard capability tiers (`frontier`, `advanced`, `medium`, `light`) in `llm-config.json` and cataloged in `llm-models-catalog.json`. Live empirical tournaments (`run_tournament.cjs`) benchmark latency, quota reliability, and reasoning precision, while a deterministic Tier Fallback Cascade handles mid-execution quota failures.

## Consequences
- Enables empirical, data-driven calibration of models across judge roles.
- Prevents pipeline blockage when individual model APIs exhaust rate limits.
