# CLI Model Configuration (Cross-Validation)

To support cross-validation, AI agents use local CLI clients. The `cli-judge.js` script acts as an intelligent wrapper: it consults `llm-config.json`, determines the required role (`judge`, `collator`, etc.), looks up its tier (`medium`, `advanced`, etc.), and sequentially tries the models of that tier.

## Degradation limit (cascading fallback)

If all models of the current tier are unavailable, the script allows **exactly one** step down a tier (e.g. from `advanced` to `medium`). Further descent is forbidden. If the backup tier is also unavailable, the script reports an error and the validation FAILS (`external_unavailable`) — the node does not count. **Self-validation is never an allowed fallback**; escalate to the human instead (Human Gate: escalation).

## Client installation

### 1. Gemini CLI
The Gemini CLI is used to call Gemini- and Claude-family models.
Global installation via npm:
```bash
npm install -g @google/generative-ai-cli
```
Installation check:
```bash
agy --version
```

### 2. Codex CLI (optional)
Codex is used to reach GPT/O-series models:
```bash
npm install -g codex-cli
```

## How to use the wrapper (cli-judge.js)

Calling the judge to assess a file:
```bash
node Assets/KBPro/kbpro-ai-docs/HarnessProtocol/Scripts/cli-judge.js --file path/to/target.cs
```

The prompt and role can be overridden:
```bash
node Assets/KBPro/kbpro-ai-docs/HarnessProtocol/Scripts/cli-judge.js --file path/to/target.cs --role judge --prompt "give an objective, honest, strict assessment"
```
