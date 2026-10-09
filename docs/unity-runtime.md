# Bounded Unity CLI runner

`Scripts/unityRunner.mjs` is an opt-in local execution adapter. It does not activate
Harness, install an Editor/package, change a game, or contact an AI provider. It
accepts one absolute JSON request-file path, never a shell command or extra flags:

```powershell
node E:/Projects/HarnessProtocol/Scripts/unityRunner.mjs E:/Projects/TechnicalFixture/compile-request.json
```

The public module API is `unityRunner(request)`, with individual exports
`preflightUnity`, `runUnity`, `unityJobStatus`, and `recoverUnity`. Results are JSON;
CLI exit codes are 0 for an accepted result, 1 for a failed/blocked operation, and 2
for an invalid request or preflight exception. Always inspect `ok`, `status`, and
the operation: a passing preflight/status query is not compile/build success.

## Read-only connection preflight

Start with `action: "preflight"`. This reads/hashes the project version, package
manifest, Editor executable, selected method/scene files and all source files,
and checks writer
locks. It does not start Unity, create project files, activate licenses, or attach
to a running Editor. The response deliberately says `connection: "not_attempted"`
and `editorLaunched: false`. It proves local prerequisites, not a live MCP/REST
connection, compilation, or platform support.

Example compile request (replace the exact version, paths and source digest with
the approved local identities before use):

```json
{
  "action": "preflight",
  "operation": "compile",
  "projectPath": "E:/Projects/TechnicalFixture/Project",
  "editorPath": "C:/Program Files/Unity/Hub/Editor/6000.0.1f1/Editor/Unity.exe",
  "editorVersion": "6000.0.1f1",
  "executeMethod": "HarnessUnityAdapter.Execute",
  "methodSourcePath": "E:/Projects/TechnicalFixture/Project/Assets/Editor/HarnessUnityAdapter.cs",
  "methodSourceSha256": "REPLACE_WITH_64_HEX_DIGEST",
  "timeoutMs": 180000
}
```

`projectPath` and `editorPath` must exist and be absolute; project aliases and
Windows case variations resolve to one canonical path. `ProjectVersion.txt` must
match the exact `editorVersion`. On Windows, executable `ProductVersion` supplies
installed-version proof without launching the executable. Alternatively, supply
`editorSha256`: this pins the exact executable and explicitly attests its mapping
to `editorVersion`. It is not independently discovered version metadata. A version
directory name alone never passes. Other OSes currently require this explicit pin.
Only an executable named `Unity`/`Unity.exe` is accepted, never Hub or a shell.

The package manifest is hashed, not resolved or installed. A test run also requires
an explicit Unity Test Framework dependency. A build requires the local Editor
`Data/PlaybackEngines/WebGLSupport` module directory. This module layout targets
Windows/Linux Editor installations; macOS build-module discovery is not supported.

Obtain a source digest with `Get-FileHash -LiteralPath <source> -Algorithm SHA256`.
Review and opt in to `Scripts/unityHarnessAdapter.cs` by copying it into the
approved project's `Assets/Editor/HarnessUnityAdapter.cs`. The runner never copies
it automatically. Custom methods may implement the same documented contract;
their exact source file and digest must be supplied. There is no implicit
`Pipeline.*` schema, method discovery, or fallback execution.

## Explicit execution

Set `action` to `run` only for an approved project operation. An explicit
`timeoutMs` between 1,000 and 86,400,000 is required. `noGraphics: true` optionally
adds `-nographics`; it is not forced for tests or builds.

| Operation | Additional fields | Acceptance evidence |
|---|---|---|
| `compile` | `executeMethod`, `methodSourcePath`, `methodSourceSha256` | Normal zero exit, nonempty parsed Editor log, matching readback and per-job completion marker |
| `test` | `testPlatform`: `EditMode` or `PlayMode`; positive exact `expectedTestCount` | Normal zero exit, clean nonempty log, complete passing NUnit XML with matching actual leaf test count |
| `build` | Method fields, `buildTarget: "WebGL"`, nonempty `scenes` array | Compile-style evidence, successful BuildReport fields and nonempty actual WebGL output files |

For a WebGL technical fixture add:

```json
{
  "buildTarget": "WebGL",
  "scenes": ["Assets/Fixture.unity"],
  "compressionFormat": "Disabled",
  "developmentBuild": true
}
```

The optional compression values are `Disabled`, `Gzip`, and `Brotli`; omission
preserves the project's setting. The supplied adapter temporarily applies an
explicit compression setting and restores the old value in `finally`. A forced
process termination can prevent `finally`; inspect project settings after timeout.
`developmentBuild` defaults to false. Scene files must already exist; the adapter
does not generate content, alter scene lists, or change package dependencies.

Arguments use Node `spawn` with `shell: false`, hidden Windows startup, and file
descriptors for output. Compile/build use `-executeMethod`; tests use native
`-runTests -testPlatform ... -testResults ...`. Tests intentionally omit `-quit`
because Unity documents that it can exit before tests finish. No request field
permits arbitrary Editor flags, executable wrappers, or shell text. Editor
methods/project scripts still execute trusted project code; this is not an OS
sandbox or a license/network isolation mechanism.

## Evidence and method contract

Every run gets a new UUID and fresh paths beneath the canonical project's
`.harness/unity-runtime/jobs/<jobId>/`. Retained files include the submitted
`request.json`, `preflight.json`, generated `editor-request.json`, `process.json`,
`stdout.log`, `stderr.log`, Unity `Editor.log`, and final `result.json`. Tests add
`results.xml`; compile/build add `readback.json`; build output is `build/`.
Logs are local and can include project/provider output: review/redact before sharing.

`-harnessRequest <absolute-json-file>` passes this adapter-owned input:

```json
{
  "schemaVersion": 1,
  "jobId": "generated-uuid",
  "operation": "compile",
  "projectPath": "canonical-absolute-project",
  "editorVersion": "exact-editor-version",
  "readbackPath": "fresh-job-directory/readback.json",
  "outputPath": "fresh-job-directory/build",
  "buildTarget": "",
  "scenes": [],
  "compressionFormat": "",
  "developmentBuild": false
}
```

The method must write a fresh JSON readback with exact `jobId`, `operation`,
`projectPath`, `editorVersion`, and `success: true`, then log
`HARNESS_UNITY_COMPLETED:<jobId>:<operation>`. The supplied compile implementation
checks `EditorApplication.isCompiling` and `EditorUtility.scriptCompilationFailed`.
Build calls `BuildPipeline.BuildPlayer` and records `buildResult: "Succeeded"`,
`buildTarget: "WebGL"`, `totalErrors: 0`, and the exact `outputPath` from its report.

The evaluator rejects log compiler/build/license failure patterns, absent output,
wrong readback identities, and stale test summaries. Tests delegate to
`parseUnityTestResults.mjs`; zero discovered tests, skipped tests, malformed XML,
failed suites/cases, and count mismatches cannot pass. WebGL requires nonempty
`index.html`, loader JS, framework JS, WASM, and data files (supported compression
suffixes included). Each accepted artifact has its absolute path, bytes and SHA-256
in `artifacts[]`. All files under `Assets`, `Packages`, and `ProjectSettings`
(including `.meta`) are fingerprinted before and after execution, with detailed
`source-before.json` and `source-after.json` manifests retained. A change returns
`source_changed` and prevents acceptance, even after a successful Editor exit.
The first import of a new fixture can generate `.meta`/settings: inspect those
changes, establish the new baseline, and invoke a new run explicitly. Nothing is
silently ignored. Source symlinks/junctions are rejected rather than hashing files
outside the project. Root-level tooling and externally referenced package contents
are outside this fingerprint; retain separate source-control/dependency evidence.

Known licensing startup recovery is classified narrowly: an unsupported-protocol
505 handshake followed by replacement-client connection, successful license update,
then both resolved entitlements and completed licensing initialization (either async
order, before engine initialization) can resolve that exact
handshake failure. The exact access-token-unavailable startup error can resolve
only between that connection and successful update. `recoveredDiagnostics` and
`licensingRecoveryProof` retain diagnostic codes and proof line numbers without
copying license identifiers. Missing/out-of-order proof, later licensing errors,
unknown diagnostics and generic runtime exceptions remain failures. This does not
certify LicensingClient signature validation or account state beyond the log's
reported initialization. `failures[]` accumulates process, log, operation-evidence
and source failures; a changed source fingerprint never replaces earlier causes.

`browserVerification: "not_run"` and `platformVerification: "unverified"` remain
true even for an accepted build. File existence does not prove valid WASM, loading,
input, frame rate, memory, or browser compatibility. Execute the separate browser
smoke against the exact build artifacts and retain its evidence before claiming
WebGL platform verification. Test doubles cannot supply that proof.

## Writer ownership and recovery

An atomic directory lock at `<canonical-project>/.harness/unity-runtime/writer.lock`
allows one cooperating writer across runner processes and Harness checkouts. It
contains the generated job ID and an ownership token. Existing locks, including
unreadable/partial owner records, are never stolen based on age or an absent PID.
Project/runtime junction escapes are refused. A pre-existing Unity
`Temp/UnityLockfile` is never removed by the runner. On Windows, a read-only
`FileMode.Open`/`FileShare.None` probe distinguishes an unheld leftover file from
an active or uncertain lock. Only absent or exclusively readable unheld files may
proceed; sharing violations, other errors and redirected paths block. On other
OSes an existing file remains a conservative blocker. `unityLockEvidence` records
the observation, and `unityLockBeforeLaunch` repeats it after writer acquisition.
The probe closes its handle before launch; Unity's native locking remains necessary
to protect the race with another Editor starting in between.
Unity's own lock remains the protection against a manually launched external Editor;
this cooperative lock cannot prevent unrelated tools from editing project files.

`process.json` records executable, argument array, PID, runner PID, timestamps,
timeout, and Windows/Linux process birth identity when obtainable. Run completion
records whether the owned child actually closed. Normal completion, including a
compiler failure/nonzero exit, writes its result before releasing ownership.

Timeout requests termination only through the currently owned child handle (POSIX
also targets its dedicated process group), waits at most a further 3 seconds, and
returns `recovery_required`. The timeout bounds this execution wait; file hashing
and the separate bounded OS identity probe are outside that wait. Windows kills
the owned Editor process but does not certify descendant compiler shutdown. The
lock stays held even if the root exits, and output from a timed-out job cannot pass.
An OS failure to terminate is reported without waiting indefinitely. No automatic
retry, detached replay, or kill of a PID taken from an old state file occurs.

Read-only status request:

```json
{"action":"status","projectPath":"E:/Projects/TechnicalFixture/Project"}
```

Safe cleanup request after an interrupted runner:

```json
{"action":"recover","projectPath":"E:/Projects/TechnicalFixture/Project","jobId":"exact-lock-job-id"}
```

`recover` only releases a lock when a matching durable result and clean closed
process receipt prove that completion happened before cleanup was interrupted.
It never reruns the operation. It refuses timed-out jobs, missing receipts, partial
startup identities and ambiguous active jobs. An absent Editor PID alone does not
prove that its child processes stopped. Those cases need manual process-tree and
project-lock investigation, with retained evidence and explicit human resolution;
the tool has no force-unlock switch. Do not delete/rewrite receipts to bypass this
boundary. A runner crash before child PID persistence remains intentionally blocked.

## Local regression checks and source references

```powershell
node --test E:/Projects/HarnessProtocol/Scripts/test_unity_runtime.mjs
```

The suite uses local Node child processes and inert file fixtures for lifecycle,
competing writers, timeouts, literal arguments, evidence rejection and recovery.
It creates a unique verified directory under Harness `.harness/`, cleans only that
directory, and never launches Unity. These tests establish tooling behavior only.
The C# adapter and real Unity behavior require a separate approved technical fixture.

Primary API contracts checked 2026-08-31:

- [Unity Editor command-line arguments](https://docs.unity3d.com/6000.0/Documentation/Manual/EditorCommandLineArguments.html)
- [Unity Test Framework command-line execution](https://docs.unity3d.com/Packages/com.unity.test-framework@1.4/manual/reference-command-line.html)
- [BuildReport](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Build.Reporting.BuildReport.html)
- [BuildSummary](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Build.Reporting.BuildSummary.html)
- [EditorUtility.scriptCompilationFailed](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/EditorUtility-scriptCompilationFailed.html)
