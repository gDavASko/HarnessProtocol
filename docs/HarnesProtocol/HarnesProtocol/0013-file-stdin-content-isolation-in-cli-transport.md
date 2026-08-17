# File/Stdin Content Isolation in CLI Transport

---
status: accepted
---

## Context
Passing system prompts, user queries, and massive git diffs via command-line arguments (`argv`) frequently causes `ENAMETOOLONG` errors on Windows, breaks shell escaping on complex code snippets, and introduces shell injection vulnerabilities.

## Decision
All payload data in `cliTransport.js` is serialized exclusively to temporary disk files or piped through `stdin`. Process invocation arguments are strictly limited to fixed CLI flags, binary paths, and model identifiers. Execution completion requires both `process exit code === 0` and a non-empty verified output file/stream.

## Consequences
- Guarantees 100% immunity to command-line length limits (`ENAMETOOLONG`) and complex character mangling.
- Requires filesystem-level cleanup of temporary payload files after process termination.
