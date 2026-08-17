# Marker-Based Repository Anchor

---
status: accepted
---

## Context
Relying on `.git` discovery to resolve the repository root breaks when working within git submodules, nested repositories, or detached worktrees where subdirectories contain their own `.git` files or pointers.

## Decision
All path resolution in `harnessPaths.js` is anchored to deterministic project marker files (e.g. `ProjectSettings/ProjectVersion.txt` for Unity or designated project manifests) rather than searching for `.git`.

## Consequences
- Guarantees deterministic absolute path resolution regardless of current working directory or submodule nesting.
- Requires project marker files to be present in target repositories.
