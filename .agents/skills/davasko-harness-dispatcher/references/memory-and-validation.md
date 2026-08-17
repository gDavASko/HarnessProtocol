# Memory (L1/L2/L3) and Validation

## Three memory levels

**Transparency principle:** at any moment any subject (a human, an AI agent,
a subagent, a background process) has full **read** access to any memory level.
There are no silos.

### L1 — Operational memory
- Temporary `op_*.json` files tracking a local task of a specific session/subagent.
- Created at work start, **deleted after the data is transferred into L2** (to avoid
  clutter).
- Minimal L1: not created for typical nodes (see
  [token-economy.md](token-economy.md), Rule 3).

### L2 — Tactical memory (the logbook)
- `tactical_master.md` + `forks/` (ralph_loop, work_log, constraints,
  tools_registry, archive_dump) + the machine `.harness_roadmap.json`.
- Exactly **one record per global task**.
- The roadmap's source of truth is `.harness_roadmap.json`. The Markdown is only
  generated (one-way). Edits — only via `roadmapEdit.js` / `loopAdvancer.js`.
- **The agent is strictly forbidden to delete tactical files.** Only a **human**
  may delete or clear L2.
- Closing condition: the task is done, all checks passed, the human confirmed.

### L3 — Strategic memory (Wiki)
- Verified reference documentation of the product.
- Information reaches it **only by direct human command/moderation** (Human Gate:
  a final document produced from L2 processing enters the wiki only after user approval).
- Stored forever. It is not a process log but a distillation (schemas, contracts, rules).

---

## Node validation (auto / ai / human)

The validation type is set on the roadmap node (`validation_type`). Before validation
the `validation_report.md` report MUST be generated
(`contextAssembler.js --mode validate --node <ID>`), otherwise the `report_ready`
gate will not let you through.

**Scope of the rules:** an external LLM judge is allowed at ANY stage and for ANY
check. The only prohibitions: (a) the executor judging its own result
(self-validation), (b) substituting an LLM verdict where the node type is `auto`
(deterministic tooling required). Human verdicts are mandatory only for: wiki
publishing after L2, git writes, and escalation.

### Type `auto` — deterministic check
```bash
node HarnessProtocol/Scripts/validator.js <task_dir> --node <ID> --type auto --cmd "npm test"
```
The script runs the commands (compiler/tests/linter) and fills in the verdict.
The `auto` verdict must come from deterministic tooling only; if an LLM opinion
is needed, set the node type to `ai` instead.

### Type `ai` — the EXTERNAL independent judge
```bash
node HarnessProtocol/Scripts/validator.js <task_dir> --node <ID> --type ai
```
- The AI agent **NEVER judges its own result**.
- **Judge Constraint:** Judges MUST evaluate ONLY what was specifically asked. No unsolicited actions, no penalizing for not rewriting working code, and strictly sticking to the point ("только по существу, никаких лишних действий, о чем спрашивают, о том и работаем").
- `validator.js` itself calls the external judge via `cliTransport` (the binary
  chain from `llm-config.json → cli_transport.judge_chain`, by default
  `agy → codex → claude`).
- **Preflight probe (`aiProbe.js`)**: the chain is filtered by the availability
  probe run at cycle start (`contextAssembler --mode init`) and cached in
  `.harness/ai_probe.json` (TTL 10 min, env `HARNESS_PROBE_TTL_MS` /
  `HARNESS_PROBE_TIMEOUT_MS`). Dead binaries are skipped — no blind timeouts.
- Evidence goes to the judge **via file/stdin, not via argv** (otherwise
  `ENAMETOOLONG` on a real diff):
  - `artifact_kind=code` → `git diff HEAD` (repository + submodules);
  - `artifact_kind=text` → the node's deliverables content.
- The judge returns strict JSON (`pass`, `dod_results`, `errors`). The
  `--result` flag is **ignored** for type `ai`.
- **Subagent-fallback**: if NO external CLI judge is alive (per probe, or every
  judge fails at call time), the validator does NOT emit a junk FAIL. It writes
  the judge task to `ai_judge_task.md`, moves the state machine to
  `awaiting_subagent_validation` and returns `action: NEEDS_SUBAGENT_JUDGE`.
  You then spawn an INDEPENDENT subagent with a FRESH context (no access to the
  current conversation); it reads `ai_judge_task.md`, checks the facts and
  writes strict JSON (`pass`, `dod_results`, `errors`) to
  `ai_judge_verdict.json`. Accept the verdict via:
  `node HarnessProtocol/Scripts/validator.js <task_dir> --node <ID> --type ai --judge-file ai_judge_verdict.json`
  The `--judge-file` flag is gated: it only works from the
  `awaiting_subagent_validation` stage declared by the validator itself.
  The verdict is recorded as `validation_mode: subagent_fallback` (auditable).
  Judging inside your own current context remains forbidden.
- Manual judge invocation over any file:
  `node HarnessProtocol/Scripts/cli-judge.js --file <path>`
  (exit code 2 + fallback guidance when no external judge is alive).

### Type `human` — validation by a human
```bash
node HarnessProtocol/Scripts/validator.js <task_dir> --node <ID> --type human
# → stage: awaiting_human_validation. Report the report path, wait.
node HarnessProtocol/Scripts/validator.js <task_dir> --node <ID> --type human --approve|--reject --comment "..."
```

---

## Reliable CLI transport (`cliTransport.js`)

Three rules (why — a history of failures: `ENAMETOOLONG`, unreliable Antigravity
stdin via PowerShell):

1. Content (prompt/diff) is **never in argv** — only a file or stdin.
2. No PowerShell as a launcher; only controlled tokens are quoted
   (paths, model name, a short ASCII instruction).
3. Completion = process exit AND a non-empty OUT file (in instruct mode + the
   `<<<HARNESS_DONE>>>` sentinel).

Modes (per binary capabilities): `codex` = file-out-flag (`-o`);
`agy`/`gemini` = file-out-instruct (answer into a file per instruction);
`claude` = stdout (`-p --output-format text`).
