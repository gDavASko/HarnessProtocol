# Harness System Memory Architecture Specification (Memory Protocol)

This document describes the structure, lifecycle, and rules of AI-agent interaction with external memory during development.

> 🔄 **Implementation update (v2):** see [current-implementation.md](current-implementation.md).
> The L2 roadmap lives in `.harness_roadmap.json` (**JSON = source of truth**; Markdown
> is generated one-way). Result validation — via an external independent
> AI judge (type `ai`, the agent never validates itself) on top of `cliTransport`.

---

## 1. Access Transparency Principle

The main rule of the memory architecture:
> **At any moment any subject (human developer, AI agent, background process, or specialized subagent) has full READ access to any memory level (L1, L2, L3).**

The absence of silos guarantees that at any stage of work any worker can request the context of a tactical task or read the operational memory of a neighboring process for coordination and synchronization.

---

## 2. Operational Memory (L1)

Operational memory tracks the progress of a local task by a specific AI process (a chat session or an autonomous step).

* **Creation:** at the start of any chat or subagent a separate temporary operational-memory file is created for it in **JSON** format.
* **Specification and guide:** the full rules, cleanliness laws, JSON block structure, and the reference generation example live in a dedicated document: **[L1 Operational Memory Spec](operational-memory-spec.md)**.
* **Deletion:** as soon as the L1 operational data has been processed and transferred into tactical memory L2, the session's operational JSON file is deleted to avoid clutter.

---

## 3. Tactical Memory (L2)

Tactical memory is the **control document (logbook)** for developing a specific large task or feature. It contains the stage plan with the applied strategies, detailed tasks, and the progress report.

* **Scale:** each global task corresponds to exactly one tactical record.
* **Content rules and structure (no garbage, no clutter!):**
  * Excessive logs, code dumps, or giant error reports are not allowed in the tactical document. Everything must be reduced to structured dry facts.
  * **Work plan:** original requirements, decomposition steps, and acceptance criteria.
  * **Development chronicle:** sequential addition of short intermediate summaries based on operational data (which steps were taken, key conclusions, final test/validation status).
  * **Outcome:** the final decision and links to the generated documentation files.
* **Process State Loop:**
  * The current process state marker is recorded at the tactical level.
  * If the process (the current step of the tactical document) is not in the `EndOfDecision` state, the AI agent must descend one level down (L1 — operational memory) and check whether all session operational files have been processed.
  * If unprocessed operational files are found, the agent continues processing them according to the strategy of the current step recorded in the tactical document.
* **Hierarchical structure (master document and forks):**
  * To prevent overload and clutter, a main tactical Master document and its branches (Fork documents) may be created.
  * If individual stages or steps of the work turn out to be too large, complex, or require detailed decision branching, a separate child Fork document is created for them. A link to it must be left in the Master document.
* **L2 specification and automation:** detailed rules for tactical logs, the L1 → L2 import pipeline, and the automation script guide are provided in: **[L2 Tactical Memory Spec](tactical-memory-spec.md)**.
* **Deletion rules:**
  * **Agents are strictly forbidden to delete tactical files.**
  * Only a **human** may delete or clear a tactical document.
* **Closing condition:** the document is considered complete only when the task is fully done, all automatic checks have passed, and the human developer has confirmed successful completion.

---

## 4. Strategic Memory (L3 - Wiki)

Strategic memory is the official, verified technical documentation of the product (the project Wiki).

* **Content:** architecture maps, API specifications, environment setup and deployment instructions, module descriptions. This is "clean" reference knowledge.
* **Content rules:**
  * Information reaches the strategic level **exclusively by a direct command of the human developer** after their verification, or by their instruction at the end of a task. This is a mandatory **Human Gate**: a final document produced from L2 processing enters the wiki only after user approval.
  * A strategic document is not a development process log (not a tactical log) but a structured distillation (schemas, contracts, usage rules).
  * Data at this level is stored forever.
