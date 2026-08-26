# Evidence Ladder — the certification contract (Levers 1′–4)

Quality does not come from more gates that *read a diff*. It comes from **executable
truth** plus **adversarial verification against the real request**, not a frozen
checklist. The cheapest verifier (compiler/tests) is also the most reliable for
"does it actually work"; the most expensive (LLM judge reading a diff) is the least
reliable for that. So quality-first and token-first point the same way: push
verification DOWN to deterministic oracles; reserve LLM judgment for what only
judgment can assess (intent match, design soundness).

## The core rule (Lever 1′)

> Every node is verified by the STRONGEST oracle its artifact admits. The
> deterministic **floor is mandatory and cannot be lowered** — a human or the model
> may only ADD rigor. The LLM judge covers ONLY the layer no deterministic oracle
> reaches, and NEVER substitutes for an oracle that existed.

This closes the old hole: a `code` node could be certified via a lone LLM judge
reading a diff (or `--type ai` with no command), so buggy code that was never run
still passed. Now the floor gate (`oracle_floor`) blocks certification of any
`code.*` node until its mandatory rungs ran green on the CURRENT iteration.

## Artifact classes and their mandatory floor

Set the class on the node: `roadmapEdit.js <dir> add-node ... --class <class>`
(or `set-field --class <class>`). If omitted, it is derived from `--kind`
(`code → code.testable`, `text → text`). `code.behavioral` MUST be declared
explicitly.

| Class | Mandatory floor (deterministic rungs) | LLM judge role |
|:------|:--------------------------------------|:---------------|
| `code.testable` — backend, libs, CLI, pure logic (incl. Unity C# logic) | `compile` + `tests` + `security` | intent/design only |
| `code.behavioral` — Unity gameplay, GUI, render (acceptance = behaviour) | `compile` + `console_clean` + `tests` + `security` | behavioural + subjective layer |
| `text` — GDD, spec, scenario, docs | none deterministic | **legitimately primary**, adversarial |

**Unity note.** "Running shows nothing, at most console errors" is exactly why the
floor exists:
1. `compile` — C# compiles clean.
2. `console_clean` — batchmode boot / scripted play, capture `Editor.log`/`Player.log`,
   assert zero `Error`/`Exception`. The captured log is a required deliverable.
3. `tests` — PlayMode/EditMode (Unity Test Framework, `-runTests`) for every piece
   of logic testable headlessly. You may NOT claim "untestable" for testable logic.
4. The purely visual remainder → a behavioural evidence artifact (scripted-session
   log / screenshot / GIF / scene-state dump) for judge or human. This is where a
   Human Gate legitimately lives — on the remainder, not the whole node.

## Recording rungs

Run each rung during work (does NOT certify the node — it records a receipt keyed
to the node and its current iteration):

```bash
node HarnessProtocol/Scripts/validator.js <dir> --node <ID> --type oracle --rung compile        --cmd "<build/typecheck>"
node HarnessProtocol/Scripts/validator.js <dir> --node <ID> --type oracle --rung tests          --cmd "<test runner>"
node HarnessProtocol/Scripts/validator.js <dir> --node <ID> --type oracle --rung console_clean   --cmd "<scripted boot; asserts clean log>"
```

Waiver (pressure valve for a physically un-headless-testable rung ONLY) — explicit
and audited, never silent:

```bash
node HarnessProtocol/Scripts/validator.js <dir> --node <ID> --type oracle --rung console_clean --waive "<why it cannot be checked headlessly>"
```

Receipts live in `<dir>/evidence_receipts.json`. A retry that bumps the node
iteration invalidates old receipts — re-run the oracle after any change.

**No fake oracles.** A rung command that verifies nothing (`node -e 0`, `echo ok`,
`true`, `exit 0`) is rejected (`TRIVIAL_ORACLE`, non-zero exit) and recorded as
`TRIVIAL`, which does NOT satisfy the floor. The oracle MUST actually exercise the
node's deliverables — otherwise it is a green checkmark on unverified code, i.e. the
original disease. For Unity `tests`, pipe the run through the real NUnit parser:
`... && node HarnessProtocol/Scripts/parseUnityTestResults.mjs results.xml` (exits
non-zero if any test failed).

Then certify as usual (`--type ai` / `--type human`). At the PASS moment the floor
gate checks receipts; if a mandatory rung is missing/not-green it returns
`GATE_FAILED gate=oracle_floor` (non-zero exit) listing the missing rungs.
Disable only for debugging with `HARNESS_ENFORCE_FLOOR=0`.

## The judge is adversarial (Lever 2)

The `ai` judge is a red-team validator with a presumption of suspicion, held to a
"what a picky senior would reject before merge" bar. It does NOT confirm the diff
matches the DoD; it hunts for how the work FAILS the real request — unhandled edge
cases, broken wiring (code written but not called), silent failures, drift from the
task goal, regressions. For each defect it must give a concrete reproducible
failure scenario (`input/state → wrong result`). A bare pass without cited evidence
is rejected. **Do not** tell the judge to "only check the DoD" or "not be picky" —
that instruction is what let omissions through.

## Living DoD & the Ratchet (Lever 3)

DoD is not frozen at interview time. When a gap or bug is found, it becomes a NEW
criterion plus a guarding test — it is NOT suppressed as "unsolicited":

```bash
node HarnessProtocol/Scripts/roadmapEdit.js <dir> add-dod --node <ID> --dod "<the gap, now a criterion>"
```

The "minimal intervention" doctrine still protects OTHER people's working code from
gratuitous refactors — but it never justifies shipping your own node with known
omissions.

## Self-review before the judge (Lever 4)

Before spending an external judge on a `code.*` node, the executor fills a
`## SELF-REVIEW` section in `validation_report.md`: each DoD item → the exact line
that satisfies it; ≥3 ways it could break; the oracle result. Enforced by default
(disable with `HARNESS_REQUIRE_SELFREVIEW=0`; gate `self_review_required`). The gate
checks it is SUBSTANTIVE — a filler like "SELF-REVIEW: ok" is rejected (needs real
length, ≥3 bullet items, and a mention of the oracle result). This is where "the AI
never checked its own work" is fixed.

## Security rung (auto-run, turnkey)

`security` is a mandatory floor rung for `code.*` — a built-in deterministic scan of
the node's evidence (git diff / artifacts) for leaked secrets (private keys, AWS/GitHub/
OpenAI/Slack/Google tokens, hardcoded passwords, JWTs) and dangerous patterns (untrusted
`eval`/`exec`, `isAdmin=true` auth-bypass, TLS verification disabled). The floor gate
auto-runs it — clean code passes with no action; a leak fails the floor with the
redacted finding. Run it manually with `--type oracle --rung security` (no `--cmd`).
Disable enforcement with `HARNESS_ENFORCE_FLOOR=0`.

## Weighted judge rubric (intent layer)

On top of binary DoD pass/fail, the `ai` judge scores four dimensions 0–10 —
`functionality` (0.30), `quality` (0.25), `security` (0.25), `edge_cases` (0.20). The
weighted score must clear a threshold (default 7.0, `HARNESS_RUBRIC_THRESHOLD`) and the
`security` dimension must clear a hard floor (5.0), or a formal `pass:true` is downgraded
to FAIL — "closed the DoD on paper but shallow / insecure" does not ship. The rubric is
additive: a judge that returns no rubric is not penalised (the oracle floor still applies).
This complements — never replaces — the deterministic oracle floor: rubric for the intent
layer, oracle for "does it actually run".

## Declared deliverables must exist

If a `code.*` node declares `deliverables`, the floor requires each to exist and be
non-empty on disk (resolved against the task dir, `workspace/`, or repo root). A node
that claims file X but never created it does NOT pass — the floor reports
`missing_deliverables`.

## Turnkey oracle commands

Don't invent rung commands (and never fake them with `echo ok`). Ask the harness
for the right commands for this project type and artifact class:

```bash
node HarnessProtocol/Scripts/oracleSuggest.js <dir> --class code.behavioral --node <ID>
```

It auto-detects the stack (node/node-ts/dotnet/unity/python/go/rust) and returns the
mandatory rungs for the class with concrete `--type oracle` invocations. For Unity it
returns the batchmode compile / `-runTests` PlayMode / boot-and-grep-log commands.

## The judge: subagent is first-class, not just a fallback

External CLI judges (agy/codex/claude) flap and used to crash the whole run when they
died mid-write (fixed in cliTransport). Do NOT stall the loop waiting on them: the
fresh-context Claude subagent judge is a legitimate first-class verifier of the
intent layer — it reads `ai_judge_task.md` with the SAME adversarial prompt and writes
a strict verdict. Cross-family CLI judges are an enhancement for objectivity, not a
precondition. The oracle floor (deterministic) is what actually certifies that code
runs; the judge — CLI or subagent — only covers intent/design on top.

## Final integration gate (whole-system truth)

The floor certifies each node in isolation. But a set of individually-green nodes can
still fail to build or pass tests TOGETHER. Before `TASK_COMPLETE`, `loopAdvancer`
requires a fresh green integration run of the whole codebase; without it, it returns
`action: NEEDS_FINAL_INTEGRATION`. Provide it:

```bash
node HarnessProtocol/Scripts/validator.js <dir> --node __TASK__ --type oracle --rung integration --cmd "<full build + full test suite>"
```

Freshness is tracked by a signature over every node's `id#iteration` — reopening/redoing
any node invalidates a prior integration run, so you re-run it after late changes.
No-op integration commands are rejected. Disable only for pure-text tasks with
`HARNESS_REQUIRE_FINAL_INTEGRATION=0`.

## Thin vertical slices (Lever 6)

A judge can verify a small runnable slice; it cannot verify a giant diff. Prefer
thin end-to-end slices — each independently compilable, runnable and testable — over
big horizontal nodes. Decompose proactively, not only reactively (ADR 0021).
