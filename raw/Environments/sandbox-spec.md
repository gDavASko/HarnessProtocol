# Isolated Environment Specification (Sandbox Spec)

This document regulates the structure, safety, and working rules of the isolated environment (sandbox) in which AI agents run in our project.

> 🔄 **Implementation (v2):** interaction with external CLI AIs (the external judge, autonomous
> strategies) goes through `cliTransport.js` under three safety rules: content only
> via file/stdin (not argv), no PowerShell as a launcher, completion by process exit
> + a non-empty OUT file. See [current-implementation.md](../current-implementation.md).

---

## 1. Isolated environment concept

To prevent accidental host-system damage, unauthorized network access, or unintended code deletion, all agent commands must run in a controlled environment.

### File-system access levels
* **Workspace:** the agent has full read/write access within the project directory and its submodules (e.g. `Assets/KBPro/`). The workspace root is resolved by the repo marker (`ProjectSettings/ProjectVersion.txt`), not hardcoded paths.
* **System folders:** access is forbidden (reads/writes outside the workspace are blocked by the harness).
* **Temporary files:** intermediate data goes into the agent session's artifact folder: `.harness/<session-or-task-id>/` at the project root (git-ignored; cleaned up on completion).

---

## 2. Registry of allowed tools and commands

All tools are grouped into categories by risk level. High-risk categories require mandatory user confirmation via the `ask_permission` protocol.

| Category | Tools | Risk level | Confirmation required |
| :--- | :--- | :--- | :--- |
| **Read** | `view_file`, `list_dir`, `grep_search` | Low | No |
| **Write** | `write_to_file`, `replace_file_content` | Medium | No (within the Workspace) |
| **Network** | `search_web`, `read_url_content` | Medium | Yes (for external domains) |
| **Execution** | `run_command` (compilation, tests) | High | Yes (for any console commands) |
| **Git** | any `git` command | Read: Low / Write: High | Read-only by default. Any write (commit, push, branch/history changes) — only with explicit user permission (Human Gate). |

---

## 3. Model Context Protocol (MCP) integration

To unify access to external databases and development tools, the harness uses **MCP**.

* **MCP server registry:**
  * A code-analysis server (fast symbol search without full indexing).
  * A Unity Editor interaction server (REST API/WebSocket for running tests).
  * A task-tracker integration server (Bitrix24).

---

## 4. Safety measures and Guardrails

1. **System-prompt leak protection (Prompt Injection Guardrails):**
   * The dispatcher checks the model output before showing it to the user or writing it to logs for keywords that reveal system instructions.
2. **Command Loop Prevention:**
   * A limit on the maximum number of consecutive automatic steps (no more than 15 steps without explicit user confirmation).
3. **Infinite-wait protection:**
   * All console commands run with a mandatory timeout (30,000 ms by default).
