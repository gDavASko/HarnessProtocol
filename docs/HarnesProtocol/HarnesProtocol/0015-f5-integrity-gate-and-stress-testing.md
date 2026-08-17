# F5 Integrity Gate and Automated Stress Testing

---
status: accepted
---

## Context
Relying solely on unit tests fails to detect systemic regressions where state gates are bypassed, unauthenticated judges return false passes, or agents skip required error resolution nodes.

## Decision
The F5 Integrity Gate executes an automated end-to-end stress testing suite (`stress_test.js`) across real subprocesses, verifying both positive progression and negative gate blocks (e.g. verifying that unvalidated evidence blocks advance and that anti-sabotage guardrails trigger).

## Consequences
- Guarantees the uncompromised integrity of the cybernetic state machine under real adversarial and error conditions.
- Generates transparent, verifiable audit reports (`STRESS_TEST_REPORT.md`).
