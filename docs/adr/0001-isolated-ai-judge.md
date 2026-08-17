# Isolated Context for AI Judge Evaluation

---
status: accepted
---

## Context
When an executor agent evaluates its own output or shares its conversational history with an evaluator, it is prone to confirmation bias, conversational momentum, and hallucinated satisfaction of criteria. 

## Decision
All AI evaluations of Tactical Nodes are delegated to an independent, isolated AI Judge session that receives only the Task Master contract and the raw Evidence (git diff or deliverable payload), with zero shared conversation history.

## Consequences
- Eliminates evaluation bias and prevents the model from assuming work is done when evidence is absent.
- Requires explicit preparation and serialization of Evidence before triggering validation.
