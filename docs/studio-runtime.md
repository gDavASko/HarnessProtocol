# Studio runtime hardening

The execution implementation belongs to HarnessProtocol. DavASkoMetaGames holds
studio policy, not a second executor. Implemented controls do not activate all
clients, authorize model accounts, or certify autonomous production of arbitrary games.

## Bounded model dispatch

`Scripts/modelPolicy.js` enforces an explicitly selected policy across llmClient,
probes and CLI transport. Set `HARNESS_STUDIO_PROFILE` (absolute JSON path),
`HARNESS_RUN_ID` and `HARNESS_RUN_DIR` (absolute task-owned directory) before
model-bearing initialization. `config/studio-model-policy.example.json` is inert:
its empty pool permits no calls. This runtime schema differs from the studio's
desired-state template.

Policies contain an authorization reference, exact provider/model/role/effort
tuples and positive limits for calls, reserved output tokens, elapsed run time,
per-call timeout and output. Probes require a separate allowed `probe` tuple.
Invalid, expired or changed policies, exhausted budgets and malformed ledgers deny
calls. Atomic cross-process reservations count failed calls too. Probe caches must
match current policy/model/effort and have a valid fresh timestamp. An unapproved
fallback is forbidden.

`HARNESS_OFFLINE=1` denies live HTTP/CLI/probe dispatch; `HARNESS_PROBE_SKIP=1`
skips discovery for deterministic work. Without a selected policy, legacy behavior
remains: placing studio JSON on disk does not enable enforcement. Host-native
tools/subagents are outside this child-process policy and retain host authorization.
Reserved output and watchdogs are not provider billing limits or proof of internal
CLI token/turn usage. Local ledgers are cooperative controls, not a defense against
processes able to change them, choose new run IDs or bypass Harness. No OS isolation
or zero-cost claim is made.

## Current-source evidence

`sourceEvidence.js` fingerprints source bytes and file/directory identity and
timestamps. Evidence Ladder binds each rung and final integration to that snapshot.
Validator compares snapshots before and after execution. Rewriting/restoring source
or creating/deleting a temporary dependency during a check prevents that check from
passing. Old receipts cannot certify new source. Loop advancement rechecks the floor.

Default scope: task repository, workspace and declared deliverables. An optional
task `evidence-scope.json` selects absolute source roots:

```json
{"schema_version":1,"source_roots":["E:/Projects/Example/Scripts","E:/Projects/Example/package-lock.json"]}
```

Include all relevant dependencies. Generated caches and Harness runtime directories
are excluded; explicitly declare excluded deliverables when their bytes matter.
Tracked/untracked source, gitlink contents and explicitly declared ignored artifacts
are covered. Missing/empty deliverables cannot complete integration. Keep check
output under an existing `.harness/`; changing source-directory metadata may
invalidate otherwise identical bytes. Snapshots are not an immutable sandbox or
protection against privileged timestamp/receipt tampering.

Security checks scan actual declared bytes without presentation truncation, including
ignored files. Missing evidence and Git errors do not become a clean diff. The
heuristic scan is not security certification. Failed oracles exit nonzero; command
lists stop at the first failure.

UTF-8 and BOM-marked UTF-16LE/BE source are decoded strictly. Unsupported encodings
and binary artifacts fail the textual security scan; fingerprints are not security
coverage for them. Use a separately scoped suitable review for binary deliverables.

`parseUnityTestResults.mjs` uses strict XML parsing. Counts must agree with actual
passing leaf cases. Malformed XML, DTDs, nested cases, zero tests, skipped or
inconclusive cases and failing suites fail. Unity runner also requires an explicit
expected test count.

## Unity and actual WebGL behavior

Follow the [Unity runtime contract](unity-runtime.md) for explicit Editor/project
identity, the cooperative writer lock, source/readback/process receipts and recovery.
This direct Editor batch adapter is separate from Unity CLI/Pipeline MCP. A passing
preflight is not execution. Uncertain timeouts retain ownership and never replay jobs.

`Scripts/createUnityReference.mjs` scaffolds only a new absolute directory from
`Tests/UnityReference`, refusing existing destinations. This fixture is system test
data, not a portfolio game. First import may generate source files: inspect changes,
establish a baseline and invoke a new run. Never convert that first run into PASS.
The fixture pins Unity Test Framework 1.7.0 (observed builtin in Editor 6000.5.10f1)
and includes one real EditMode test
checking the saved scene's behaviour and missing-script references. Request the
exact expected test count; package import is not itself a passing test run.

`Scripts/webglSmoke.mjs <absolute-request.json>` validates build artifacts and serves
only their hash-matching files on loopback. It uses a fresh browser with an explicit
executable/SHA-256 pin, observes real WebAssembly and Unity data loading, performs
click/key input, asserts Unity-to-JavaScript state and optionally checks persistence
after reload. It records errors, assertions, screenshot and Playwright trace beside
the build receipt. It does not use personal cookies. Request routing is not OS
network isolation.

Request fields: `buildReceiptPath`, `browserExecutable`, `browserSha256`, `timeoutMs`,
`stateGlobal`, `initial`, `steps` (input `type` and `expected` state), optional
`reloadExpected`. The reference reports `__harnessUnityState` (`ready`, `count`).
A DOM/canvas stub is not a replacement player. Load time, build size and JavaScript
heap observations are not FPS, total memory or device acceptance. Results keep
`platformAcceptance: unverified` pending separately scoped performance/target checks.

## Distribution and approval

Technical completion follows verified node/integration gates, without requesting
the same user approval again. An optional terminal confirmation requires explicit
`HARNESS_CONFIRM_COMPLETION=1`; it does not grant reserved permissions. Post-task
model learning is off by default and always skipped offline. Explicit
`HARNESS_CONTINUOUS_LEARNING=1` enables that optional path only within separately
authorized model limits; it is not required to complete a technical task.

Follow [full-tree skill distribution](skill-distribution.md), not entrypoint-only
copying. Review the plan hash and apply with backups and drift checks. Unknown
destination extras block application. Matching directories prove installation,
not discovery by every client. Reuse explicit task approval; ask only for missing
decisions and separately reserved spending/account/publication/destructive actions.

## Checks

`Scripts/graph/skillDistiller.js` writes generated procedures only under the
task's `.harness/skill-candidates/<slug>/<uuid>/`. It never installs them into
active skill discovery directories. Candidates explicitly report
`activation: not_installed` and `promotion_requires_review: true`; they are not
trusted instructions until a separately reviewed deployment.

`npm run test:studio` runs deterministic positive and failure controls. The broader
suite is `HARNESS_OFFLINE=1 HARNESS_PROBE_SKIP=1 npm test` (set environment variables
using host-shell syntax). These fixtures do not prove actual Unity/browser behavior.
Keep separate real execution receipts and source identities. Pin changes invalidate
affected evidence and require re-verification.
