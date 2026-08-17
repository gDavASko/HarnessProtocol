# DavASko Harness Dispatcher Token Economy

## Goal

Minimize the IDE agent's token spend when working with L2 tactical memory while keeping the context complete.

---

## Rules

### Rule 1: "One call instead of five files"

The IDE agent **never reads L2 files manually** via `view_file`. Instead:

```bash
node HarnessProtocol/Scripts/contextAssembler.js <task_dir> --mode init|step|status|validate
```

| Mode | What the agent gets | Token budget |
|:-----|:--------------------|:-------------|
| `init` | The full task picture | ~800 |
| `step` | The next node's context | ~500 |
| `status` | The progress dashboard | ~300 |
| `validate` | The Markdown report for assessment | ~file |

**Savings (measured by `measureTokens.js`, not estimated):** `init` ≈ 86-90%,
`step` ≈ 96-99% relative to naively reading all L2 files. All service
payloads are < ~260 tokens per call. Check on your own task:
```bash
node HarnessProtocol/Scripts/measureTokens.js <task_dir>
```

---

### Rule 2: "The agent does no bookkeeping"

The IDE agent **never appends** iterations, statuses, or insights to L2 manually. Instead:

```bash
node HarnessProtocol/Scripts/loopAdvancer.js <task_dir> --node <ID> --status SUCCESS|FAIL --insight "..."
```

The script itself updates 3 files + reindexes the navigation matrix.

**Savings:** ~10 tool calls (view_file + replace_file × 3 files + reindex).

---

### Rule 3: "Minimal L1"

L1 `op_memory.json` **is not created** for typical nodes. It is created only when:

- The node needs >3 iterations (to allow rollback)
- The strategy is Evaluator-Optimizer (a formal feedback log is needed)
- The strategy is LATM / Tool Maker (a registry of the created tool is needed)

For all other nodes the result is recorded only via `loopAdvancer --insight`.

---

### Rule 4: "Trivial tasks = zero overhead"

Tasks with ≤2 nodes (Trivial per the STEP 1 scaling) bypass the L1/L2 system entirely:

- No `task_initializer.js`
- No directory creation in `memory/tactical/`
- No forks, iterations, or DoD
- The agent just does the work and records the result in `walkthrough.md`

---

### Rule 5: "Constraints are read once"

The `forks/tactical_constraints.md` file is read only in `init` mode. On subsequent `step` calls `contextAssembler` checks the file's `mtime` and returns `constraints_changed: true|false`. If `false` — the agent does not re-read the constraints.

---

### Rule 6: "Work Log — insights only, ≤200 characters"

Every entry in `forks/tactical_work_log.md` is strictly ≤200 characters. `loopAdvancer.js` truncates automatically.

Entry format:
```markdown
### ⏱ [2026-06-27 18:30] | Node: NODE-02
*   **Outcome:** SUCCESS | **Insight:** Buffer.alloc is safer than Buffer.allocUnsafe.
```

No code dumps, stack traces, or long musings.

---

### Rule 7: "The navigation matrix is the scripts' internal business"

The IDE agent **does not read or use** the navigation matrix from `tactical_master.md`. It exists for the scripts (`contextAssembler.js`, `loopAdvancer.js`), which parse files by lines. The agent receives prepared JSON or a Markdown report.
