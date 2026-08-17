# Testing and Evaluation Specification (Evaluations Spec)

This document describes the methodology for automatic testing (Evaluations / Evals) and quality assessment of AI-agent task execution in our project.

> 🔄 **Implementation (v2):** qualitative assessment (type `ai`) is performed by an EXTERNAL
> independent judge — `validator.js --type ai` itself calls another CLI AI via
> `cliTransport` (the agent does not assess itself). Deterministic assessment — type
> `auto` (commands/tests/linter). See [current-implementation.md](../current-implementation.md).

---

## 1. Why Evals?

Unlike standard software, AI-agent behavior is non-deterministic. Even if the code compiles, the agent could have violated architectural principles, forgotten to clean up resources (causing a memory leak), or broken adjacent systems.

Evals allow verification tests to run automatically at every stage of the agent's work, minimizing the developer's manual code-review time.

---

## 2. Agent testing levels

We split result verification into 4 levels:

### Level 1: Syntax validation and compilation (Compile Check)
* **Goal:** make sure the code contains no syntax errors.
* **How it is checked:** running the project compilation from the console (e.g. `dotnet build` or a Unity assembly build).

### Level 2: Static analysis (Lint & Architecture Check)
* **Goal:** code-quality control and adherence to architecture conventions.
* **How it is checked:**
  * Running C# linters.
  * Checking for forbidden methods (e.g. `GameObject.Find` or `UnityEngine.UI.Text` instead of TMPro, as stated in `AGENTS.md`).

### Level 2.5: Qualitative review (AI Judge / Review Council)
* **Goal:** assessing semantic and qualitative code characteristics (style, architectural cleanliness, DI contract compliance, absence of redundant commented-out code).
* **CROSS-VALIDATION RULE:** the executor agent NEVER issues the final verdict on its own work. The verdict comes from an **EXTERNAL independent evaluator** — a DIFFERENT subagent, LLM, or CLI model — invoked with the mandatory prompt: *"give an objective, honest, strict assessment"*. The executor may pre-review its own work, but the task is marked done only by the external verdict (plus deterministic checks). An external LLM judge is allowed at any level and for any artifact; only self-validation is forbidden.
* **How it is checked:**
  * Launching an independent evaluator subagent (AI Judge) in an isolated session with the code and the evaluation rubric.
  * Comparing the implementation against the Wiki L3 requirements and project standards.
  * Producing a detailed JSON report with the verdict (PASS/FAIL) and the remark list.

### Level 3: Functional testing (Play Mode / Edit Mode Tests)
* **Goal:** verifying the working logic of systems and components.
* **How it is checked:**
  * Running Unity tests (Edit Mode / Play Mode) from the command line.
  * Checking the module init/deinit contract (no memory leaks on Dispose).

### Level 4: Scenario output validation (Behavioral & Output Validation)
* **Goal:** verifying that the agent generated the right artifacts (e.g. task-import JSON files match the schema).
* **How it is checked:** automatic parsing of the generated JSON files for schema validity.

---

## 3. Automatic evaluation process

```
[The agent finished the task]
       |
       v
[Step 1: Code build] --------- (Error) -------> [Return the error log to the Agent]
       | (Success)
       v
[Step 2: Architecture linter] - (Error) ------> [Return the remarks to the Agent]
       | (Success)
       v
[Step 3: Unity unit tests] ---- (Error) ------> [Return the failed tests to the Agent]
       | (Success)
       v
[Task verified] -> [Create Walkthrough.md; any git commit/PR — only with explicit user permission (git is read-only by default)]
```

---

## 4. Agent quality metrics

To measure the effectiveness of the agent (or a new version of prompts/harness), statistics are collected:
1. **Success Rate:** the percentage of tasks completed with full successful verification without human involvement.
2. **Steps to Success:** how many tool-call iterations the agent needed to finish the task (fewer is better).
3. **Token Cost:** the total resource spend per task.
4. **Self-Correction Rate:** how often the agent successfully fixed its own errors after evaluator feedback without involving the user.
