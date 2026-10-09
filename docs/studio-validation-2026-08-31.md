# Development-system verification — 2026-08-31

Scope: HarnessProtocol execution tools and the sibling DavASkoMetaGames studio
policy. No portfolio game was evaluated or modified. Existing user changes were
preserved; no commits, pushes, account changes or external Harness model calls
were made. Native assistant collaboration was used for independent defect review.

## Implemented and checked

- Strict NUnit XML/actual test-count checking and nonzero failed-oracle exits.
- Source/dependency/artifact-bound receipts, mutation rejection and final integration.
- Actual text-byte security scanning, including BOM-marked UTF-16, with unsupported
  binary/encoding refusal. This remains a heuristic scan, not a security audit.
- Exact model/role/effort allowlists, cross-process call/output reservations,
  deadlines, cache validation, offline denial and no unauthorized judge replacement.
- Explicit Editor/project identity, single cooperating Unity writer, owned process
  receipts, failure preservation and Windows held/unheld lock discrimination.
- Hash-bound real WebGL loading, observable input/state/persistence, browser error
  capture, trace and bounded cleanup with confirmed process exit.
- Complete reviewed dispatcher distribution: 13 files identical in canonical,
  distribution and installed trees. Existing Unity metadata GUIDs were preserved.
- Reuse of scoped user approval; generated skills remain inactive task-local
  candidates and cannot install themselves into active instruction directories.

Local regression entrypoints are `npm run test:studio` and `npm test`. The former
reported 97 passing Node test cases (including the wrapper for 18 passing distribution
checks), zero failures; the full master runner also covers legacy algorithms/state
gates. Its two absent optional application suites are explicitly skipped, not PASS.
Final current-source oracle/integration receipts live with
[the protocol task](../memory/tactical/TACT-STUDIO-HARDENING-20260831/validation_report.md).
These local fixtures make no live provider calls and are not real-engine proof.

## Real-engine and browser evidence

The isolated technical reference uses Editor **6000.5.10f1**, executable SHA-256
`1766dfb9e4c7ae7c62f0cd155530a6f7efcb6ce820b648758d744a9f93558f4f`.
Unity Test Framework resolves as builtin **1.7.0**, matching its final manifest.
The final 43-file source fingerprint is
`4d3a56236ce8e245ed35aa9a0ce4bff0467a7513ce406a7b2f0750185dd7c553`.

| Operation | Observed result and receipt |
|---|---|
| Compilation | PASS, unchanged source, [receipt](../.harness/studio-hardening-20260831/unity-final-compile.json), job `8dc0bcee-a44f-4c3a-beb0-f23cbc1d2301` |
| Actual EditMode test | PASS, exactly 1 discovered/passing case, [receipt](../.harness/studio-hardening-20260831/unity-final-test.json), job `fb63053c-2b14-49a8-820e-a96028439a97` |
| WebGL build | PASS, real BuildReport and hashed artifacts, [receipt](../.harness/studio-hardening-20260831/unity-final-build.json), job `9e09a86c-db5f-4416-9179-395bfc2d66dd` |
| Browser behavior | PASS, real WASM/data, state 0 → click → 1 → reload → 1, zero console/network errors, confirmed owned-browser exit; [receipt](../.harness/studio-hardening-20260831/webgl-verified-result.json), browser job `05caa2f2-8366-4ded-b963-ce970eca15c1` |
| Deliberately broken C# | Correctly FAIL, nonzero process and compiler errors retained; [receipt](../.harness/studio-hardening-20260831/unity-negative-compile.json), job `dbc39088-aecb-41e7-9668-8588b0d1abce`; source restored before successful subsequent execution |
| Full-tree deployment | PASS, 18 reviewed copy operations, backups retained; [apply receipt](../.harness/studio-hardening-20260831/skill-distribution-apply.json) and [comparison](../.harness/studio-hardening-20260831/skill-distribution-check.json) |

Browser version **151.0.7922.10**, pinned executable in the request/receipt, fresh
profile without personal cookies. The last run observed 2,738 ms initial readiness
and 30,217,350 build bytes; these are observations on this machine, not budgets or
target-device acceptance. Screenshots, trace and raw logs remain in the job directory.

Initial import/source-change runs, the first failed licensing classification and
a browser cleanup timeout were preserved as failures. Fixes were followed by new
runs; no old failure receipt was rewritten as PASS. Licensing classification accepts
only the documented exact startup recovery sequence and retains unknown/later errors.
It does not certify the LicensingClient signature warning or change licensing state.

## Limits and reproduction

Follow [runtime](studio-runtime.md), [Unity requests](unity-runtime.md), and
[distribution](skill-distribution.md). Detailed local evidence remains under
`.harness/studio-hardening-20260831/`; retain it for audit and re-run after cleanup
or changes. It is not published or uploaded. The source fixture is reproducible
from `Tests/UnityReference` with `Scripts/createUnityReference.mjs` into a new path.

These results verify the selected local Editor batch backend and a technical
reference. They do not verify Unity CLI/Pipeline MCP, every client's isolation,
other platforms/devices, frame-rate/total-memory budgets, game content quality,
store submission or autonomous production of a complete arbitrary game. Model
limits are cooperative dispatch limits, not provider billing caps. The studio
template remains inactive with an empty model pool; no paid fallback was enabled.
