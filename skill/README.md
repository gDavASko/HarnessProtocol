# Harness Protocol Skill Distribution Copy

This folder holds the **working copy** of the `davasko-harness-dispatcher` dispatcher skill, which drives task execution under the Harness Protocol (the Ralph Loop, L1/L2/L3 memory, strategy selection, auto/ai/human validation, drift-guard).

> ⚠️ This folder (`HarnessProtocol/skill/`) is deliberately placed **outside `raw/`**, so it is NOT indexed into the vector wiki. The skill description for the wiki is in [../raw/skill-guide.md](../raw/skill-guide.md).

## How to deploy the skill (for a new environment)

Copy the skill folder into your agent's skills directory:

```bash
# For the agent format (.agents/skills):
cp -r davasko-harness-dispatcher <repo>/.agents/skills/

# For Claude Code (.claude/skills):
cp -r davasko-harness-dispatcher <repo>/.claude/skills/
```

After copying, the skill triggers on requests for complex/multi-step work
(development, refactoring, migrations, writing GDDs/scenarios/specs, decomposition) —
see `davasko-harness-dispatcher/SKILL.md` (the `description` field).

## Dependencies

The skill calls Node.js scripts from `HarnessProtocol/Scripts/` (context assembler,
validator, loop advancement, drift-guard, etc.). Make sure the `HarnessProtocol/`
folder is present in the project and Node.js (ESM) is available.

## Synchronization

The canonical source of the skill is `.agents/skills/davasko-harness-dispatcher/`.
This copy must be kept up to date whenever the skill changes
(re-copy it). Both versions must match.
