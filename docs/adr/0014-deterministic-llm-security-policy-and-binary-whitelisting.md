# Deterministic LLM Security Policy and Binary Whitelisting

---
status: accepted
---

## Context
Autonomous agents with shell execution capabilities can inadvertently run dangerous commands, execute unverified external scripts, or access unauthorized MCP tool servers, causing host damage or security leaks.

## Decision
All model execution is mediated by a deterministic security filter (`llm-security-policy.json`):
- **Allowed Binaries**: Only whitelisted CLI binaries (`allowed_binaries`) may be spawned by the transport layer.
- **Forbidden Commands**: An active pattern matcher intercepts and aborts forbidden commands (such as unconstrained destructive operations or secret leakages) before process launch.
- **MCP Whitelisting**: MCP servers must be explicitly declared in `allowed_mcp_servers`.

## Consequences
- Creates a hard, deterministic security contour that prevents prompt-injected or hallucinated command abuse.
- Requires explicit configuration updates in `llm-security-policy.json` whenever new CLI tools or MCP servers are added.
