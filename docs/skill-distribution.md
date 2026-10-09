# Skill distribution

Use `Scripts/skillDistribution.mjs` when comparing or distributing the canonical
dispatcher tree to explicitly authorized replicas. It runs locally with Node's
standard library; it performs no provider calls, package installation or git writes.

The canonical source for this repository is
`E:/Projects/HarnessProtocol/.agents/skills/davasko-harness-dispatcher`. The repository
replica is `E:/Projects/HarnessProtocol/skill/davasko-harness-dispatcher`; the current
machine's installed replica is
`C:/Users/DavASko/.agents/skills/davasko-harness-dispatcher`. These are inputs, never
implicitly selected destinations. A successful comparison proves file equality,
not client loading, runtime activation, or Harness task certification.

## Review and apply

1. Run `node Scripts/skillDistribution.mjs --help` for the CLI contract. Run `check`
   with an absolute `--source` and repeat `--destination` for every authorized
   replica. Exit 0 means all regular-file paths and contents match. Exit 1 means
   divergence. Exit 2 means an invalid or unsafe input; it is not a clean result.
2. Finish canonical edits and stop writers to all selected trees. Run `plan` with
   the same roots, `--task-dir` under this repository's `.harness/<task-id>/`, and
   an absolute `--out` inside that task directory. The output file must be new.
   Plans include every regular file's path, byte count and SHA-256, required-reading
   targets, and each destination's added, changed, extra and conflicting paths.
3. Review the complete plan and the contents of changed/new files. Hashes identify
   bytes; they do not establish that the contents are safe or approved. Include
   hidden files in review: there are no extension, ignore-file or secret-file
   exclusions. The tool does not print file contents, but apply backups contain
   the original bytes and require the same protection as the copied trees.
4. Run `apply --plan <absolute-plan-path> --plan-sha256 <reviewed-digest>`. Apply
   verifies the plan digest, recomputes every source/destination manifest, checks
   the derived changes, and refuses source or destination drift. It backs up all
   files it will overwrite before the first destination mutation, then copies only
   the planned added/changed paths. A final full-tree check must pass for exit 0.
5. Retain the returned recovery journal and backups until the replicas have been
   checked and recovery is no longer needed. Preserve required evidence outside
   scratch storage before the owning task cleans its temporary directory.

Example for an approved task (run from this repository; each command is one line):

```powershell
node Scripts/skillDistribution.mjs check --source 'E:/Projects/HarnessProtocol/.agents/skills/davasko-harness-dispatcher' --destination 'E:/Projects/HarnessProtocol/skill/davasko-harness-dispatcher' --destination 'C:/Users/DavASko/.agents/skills/davasko-harness-dispatcher'
node Scripts/skillDistribution.mjs plan --source 'E:/Projects/HarnessProtocol/.agents/skills/davasko-harness-dispatcher' --destination 'E:/Projects/HarnessProtocol/skill/davasko-harness-dispatcher' --destination 'C:/Users/DavASko/.agents/skills/davasko-harness-dispatcher' --task-dir 'E:/Projects/HarnessProtocol/.harness/studio-hardening-20260831' --out 'E:/Projects/HarnessProtocol/.harness/studio-hardening-20260831/skill-distribution-plan.json'
node Scripts/skillDistribution.mjs apply --plan 'E:/Projects/HarnessProtocol/.harness/studio-hardening-20260831/skill-distribution-plan.json' --plan-sha256 '<digest returned by plan, after review>'
```

## Refusals and boundaries

- Extra destination files and file/directory conflicts block apply. The tool never
  deletes destination files. Review any cleanup separately, naming each exact path
  and the authorization to remove it; then create and review a new plan. An extra
  file cannot be ignored to certify an exact copy.
- Every `required_reading` entry in each canonical `SKILL.md` frontmatter must name
  an existing regular file inside that skill's tree. Use an indented YAML block
  list of plain or simply quoted relative paths; use `[]` for an intentionally
  empty list. Unsupported YAML forms fail closed. `SKILL.md` must exist at the
  canonical root. Ordinary Markdown links are not part of this reference check.
- Relative roots, overlapping roots, linked files/directories, hardlinks and
  filesystem entries other than files/directories are rejected. Every existing
  ancestor is checked for symlinks/junctions and paths whose real resolution differs
  from the declared location, including reparse escapes. Artifacts must remain
  separate from source and destination trees.
- Equality covers regular-file names and bytes. Empty directories, timestamps,
  permissions/ACLs, extended attributes and Windows alternate data streams are not
  replicated or certified. Empty directories are recorded to detect plan drift.
- The digest is an integrity pin, not a signature or authorization mechanism.
  Exclusive ownership is required during apply. Repeated path/hash checks detect
  ordinary concurrent edits; they do not make a portable filesystem transaction
  or defend against a hostile process racing path replacement. A failure midway
  can leave some files copied. Keep the returned recovery artifacts and follow
  the recovery procedure; do not claim success or blindly retry the stale plan.

## Recovery after failure or an unwanted apply

`skill-distribution-<run-id>/recovery.json` records the original plan digest, each
exact destination/path, before/after hashes, backup locations, completed operation
indices, and any pending operation. `reviewed-plan.json` preserves the original
reviewed bytes. Backups live under that same run directory. The journal is written
before copying begins and after each copied file; an abrupt process or machine
failure may leave a pending operation or an incomplete journal write.

1. Stop all writers. Preserve the run directory and compare the copied plan's
   SHA-256 with the reviewed digest. Read the journal if intact; reconstruct its
   operation list from the preserved plan if necessary. Do not rerun apply with
   the original plan: partial destination drift will correctly block it.
2. For each completed or pending operation, inspect the destination. If its hash
   equals `beforeSha256`, leave it unchanged. If it equals `afterSha256`, it is a
   candidate for restoration. A different hash, a link, or an unexpected type
   needs explicit investigation so recovery does not overwrite another writer.
   Pending operations can contain partial bytes after a failed write.
3. For every original file selected for restoration, verify the backup SHA-256
   equals `beforeSha256`, recheck that the exact target path stays in the approved
   destination, and copy that backup to that one path. Keep the backup intact.
4. Added files have a null before hash and no backup. Removing them requires a
   separate approved exact-file deletion list. Remove only those files, after
   confirming their current hashes. Leave empty directories alone. If deletion
   is not authorized, report incomplete rollback with those paths.
5. Compare restored regular-file manifests with the original destination snapshots
   in the plan. Recovery is complete only when those paths and hashes match.
   Record any unresolved discrepancy and retain the backups.

Run `node Scripts/test_skill_distribution.mjs` for local temporary-tree tests,
including drift rejection, junction escapes, nonzero divergence status and
restoration using exact verified backup paths. The test removes only its own
resolved fixture directory under `.harness/studio-hardening-20260831/`.
