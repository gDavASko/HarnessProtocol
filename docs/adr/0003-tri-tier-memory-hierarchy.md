# Tri-Tier Memory Architecture

---
status: accepted
---

## Context
Injecting entire repository documentation or raw chat logs into every turn overwhelms the model's context window, introduces noisy distractions, and leads to cognitive degradation in long-running sessions.

## Decision
Memory is explicitly structured into three distinct tiers:
1. **L1 (Transient Context)**: Freshly compiled per-turn working context assembled just-in-time.
2. **L2 (Ephemeral History)**: Structured execution logs and intermediate task state persisted across nodes in an active session.
3. **L3 (Vector Wiki)**: Long-term, semantically indexed persistent knowledge base reflecting invariant repository architecture and rules.

## Consequences
- Keeps per-turn context sizes compact and highly relevant.
- Requires dedicated assembler tooling (`contextAssembler.js`) to curate L1 context for each execution step.
