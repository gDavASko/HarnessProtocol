# Preflight Judge Quarantining and Cross-Family Evaluation

---
status: accepted
---

## Context
Probing external CLI judges during live validation causes multi-minute execution timeouts when binaries are unauthenticated, misconfigured, or dead. Furthermore, evaluating an executor with a model from the same provider family risks cognitive self-favoring.

## Decision
1. **Preflight Probing (`aiProbe.js`)**: All CLI judges are probed in parallel at cycle initialization using single-use cryptographic nonces (`HNONCE-XXXX`). Binaries exhibiting permanent errors are quarantined for 24 hours.
2. **Cross-Family Evaluation**: Judges are prioritized from different provider families (`google`, `anthropic`, `openai`) than the executor to ensure multi-perspective and objective evaluation.

## Consequences
- Eliminates mid-cycle timeout freezes by filtering the active judge chain beforehand.
- Maximizes evaluation objectivity and diagnostic rigor across independent model families.
