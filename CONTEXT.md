# Harness Protocol

A cybernetic control framework providing deterministic sandboxing, state gating, and integrity verification for autonomous AI agents.

## Core Concepts

**Harness**:
The deterministic control frame that sandboxes tool execution, manages state transitions, and enforces integrity gates around a probabilistic Model.
_Avoid_: Wrapper, runner, agent framework, scaffold

**Model**:
The probabilistic reasoning and decision-making engine operating within the constraints of the Harness.
_Avoid_: AI, bot, assistant, LLM

**Task**:
A high-level user objective or project goal composed of one or more Tactical Nodes.
_Avoid_: Ticket, prompt, epic

**Tactical Node**:
An atomic, discrete step in the task execution plan carrying a designated Execution Strategy, Artifact Kind, and Criticality Level.
_Avoid_: Subtask, phase, to-do item

**Ralph Loop**:
The iterative cybernetic execution contour advancing a task through discrete state gates until the Definition of Done is fully satisfied.
_Avoid_: Infinite loop, while loop, agent workflow

**Ratchet Principle**:
The invariant rule that every encountered error or regression must be permanently guarded against with a deterministic test, fence, or rule.
_Avoid_: Bug fixing, regression check

## Execution & Gating

**Gated State Machine**:
The deterministic, non-skippable progression of execution states governing task advancement.
_Avoid_: Pipeline, status tracker

**State Gate**:
A mandatory checkpoint between execution phases that requires explicit validation (automated, AI, or human) to pass.
_Avoid_: Step, phase, checkpoint

**Evidence**:
The immutable, observable proof of work (such as a git diff, execution log, or operation payload) submitted to a State Gate for evaluation.
_Avoid_: Artifact, result, output

**Artifact**:
A concrete, persisted file or object created or modified during execution.
_Avoid_: Evidence, result, deliverable

**Result**:
The conceptual outcome, logical answer, or reasoning conclusion resolving a specific Tactical Node.
_Avoid_: Artifact, diff, output

**Artifact Kind**:
The structural categorization of a Tactical Node determining its execution environment (`code` in working tree vs `text` in autonomous engine).
_Avoid_: Task type, mode, file extension

**Task Passport**:
The comprehensive dossier of a task containing its goals, acceptance criteria, associated artifacts, logs, and execution history.
_Avoid_: Prompt, ticket description, task spec

**Harness State**:
The real-time runtime snapshot capturing the current progression and active State Gate of a task.
_Avoid_: Status string, task log, memory

**LangGraph StateGraph Engine**:
The deterministic hierarchical graph execution layer governing Gated State Machine transitions and Ralph Loop advancement.
_Avoid_: Black-box agent, LangChain runner

**Strategy Subgraph Plugin**:
A pluggable, isolated sub-graph component implementing an Execution Strategy with scoped state channels, authorized tools, and deterministic state progression.
_Avoid_: Custom script, hardcoded strategy, agent addon

**Strategy Registry**:
The central static registry mapping canonical and extended Strategy IDs to compiled sub-graph factory functions and authorized toolsets.
_Avoid_: Dynamic plugin loader, script directory scanner

**Plugin Weapon Manifest**:
The strict declaration of authorized tools, binaries, and capabilities permitted for use within a specific Strategy Subgraph.
_Avoid_: Open permissions, tool pool

**Guarded Phase Routing**:
The architectural pattern dividing node execution into four inviolable macro-phases (Context Ingestion -> Adaptive Strategy Subgraph -> Guarded Validation Gate -> Advancement & Ratchet) ensuring deterministic gatekeeping without sacrificing algorithmic flexibility.
_Avoid_: Unchecked dynamic graph, rigid pipeline

**Strategy Escalation**:
The graduated recovery policy transitioning failing nodes across progressively deeper strategies (e.g., Chaining -> Evaluator-Optimizer -> LATM -> Quorum/Human Gate) upon repeated validation rejections.
_Avoid_: Infinite retry, blind retry loop

**Hierarchical Escalation Loop**:
The meta-level cybernetic feedback contour in `TaskOrchestratorGraph` that catches lower-level tactical node failures, evaluates alternative problem formulations, and triggers Decomposition Revision before escalating to a Human Gate.
_Avoid_: Dead-end crash, fatal unhandled error

**Decomposition Revision**:
The dynamic restructuring or splitting of a failing tactical node into alternative or smaller discrete sub-nodes with updated Definition of Done criteria.
_Avoid_: Task mutation, prompt retry

**Time-Travel Rollback**:
The deterministic state restoration procedure loading an immutable historical checkpoint from `HarnessDiskCheckpointer` by ID and synchronizing all L2 Markdown projections.
_Avoid_: Git reset --hard, dirty file revert

**Quorum Subgraph**:
A dedicated verification sub-graph executing multi-judge parallel evaluation and consensus reconciliation for L3 Criticality nodes.
_Avoid_: Voting script, serial judge check

**Task State Annotation**:
The top-level LangGraph channel schema managing roadmap progression, active node cursor, cumulative token budgets, and drift-guard intervals.
_Avoid_: Global variables, process env state

**Node State Annotation**:
The scoped LangGraph channel schema governing tactical node iterations, memory digests, strategy payloads, evidence collection, and state gate verdicts.
_Avoid_: Thread context, temp variables

**Harness Disk Checkpointer**:
The disk-backed persistence adapter serializing LangGraph thread checkpoints into `.harness/checkpoints/` and mirror-updating L2 Markdown forks.
_Avoid_: SQLite database, in-memory cache

**Interrupt Handover**:
The deterministic suspension mechanism using LangGraph `interrupt()` to halt execution and yield control to Human Gates, IDE Agents, or Subagent Judges with explicit resume contracts.
_Avoid_: Process kill, exit code hack, busy wait

## Constraints & Tools

**Matching Triad**:
The tripartite specification (Task Master, Fences, Skills) assembled to constrain and equip a Model for a specific Tactical Node.
_Avoid_: Context bundle, input config

**Task Master**:
The definitive contract defining the objectives, deliverables, and acceptance criteria (Definition of Done) for a task.
_Avoid_: Prompt, ticket description, spec

**Fence**:
A hard, non-negotiable boundary defining what the Model is strictly forbidden to do during execution.
_Avoid_: Rule, guideline, warning, soft constraint

**Skill**:
A modular package of knowledge, procedural instructions, and tools enabling the Model to perform a specific workflow.
_Avoid_: Weapon (use as metaphor only), utility, helper

**Weapon**:
A metaphorical term for the registry (Fork-4) of authorized tools and skills available to the Model.
_Avoid_: (Use Skill as canonical term)

## L2 Fork Memory Taxonomy

**Master Document**:
The central navigational and contractual document (`tactical_master.md`) housing the Task Passport and the End-to-End Navigation Matrix.
_Avoid_: Main file, dashboard, summary

**Roadmap Fork**:
The operational runbook (`tactical_ralph_loop.md`) serving as a one-way generated Markdown projection of `.harness_roadmap.json`.
_Avoid_: Task list, plan file

**Hot Storage**:
The active log section within the work log holding the last 5 raw iterations of the currently executing Tactical Node.
_Avoid_: Buffer, scratchpad, active log

**Warm Storage**:
The compressed chronicle within the work log preserving concise summaries of successfully closed Tactical Nodes.
_Avoid_: History, closed tasks list

**Cold Storage**:
The strictly append-only deep archive (`tactical_archive_dump.md`) storing raw execution dumps of closed nodes without active context loading.
_Avoid_: Backup, trash, history dump

**Data Cooling**:
The systematic lifecycle compaction of tactical data moving progressively from Hot Storage to Warm Storage and into Cold Storage.
_Avoid_: Log rotation, cleanup, truncation

**Navigation Matrix**:
An anchor-stabilized mapping correlating physical line coordinates with logical sections across L2 documents for pointwise token-efficient reads.
_Avoid_: Index table, table of contents

## Token Economy Architecture

**Token Economy Law**:
The governing framework that minimizes agent token spend through automated context compilation, bookkeeping offloading, and insight compression.
_Avoid_: Token budget limit, cost threshold

**Zero-Manual-Read Principle**:
The architectural mandate prohibiting agents from manually reading raw L2 Markdown forks, requiring context ingestion exclusively via compiled JSON snapshots.
_Avoid_: Read-only mode, selective reading

**Zero-Bookkeeping Principle**:
The architectural mandate offloading all state synchronization, fork updates, and navigation reindexing to deterministic backend scripts.
_Avoid_: Manual logging, status editing

**Insight Truncation Rule**:
The strict size constraint capping individual work log insights at $\le 200$ characters to prevent memory pollution.
_Avoid_: Log truncation, message cutoff

**Minimal L1 Policy**:
The operational rule creating `op_memory.json` only when multi-iteration rollbacks (>3 iterations) or specialized feedback loops require formal state tracking.
_Avoid_: Lazy initialization, empty JSON

## CLI Transport & Process Safety

**File/Stdin Invariant**:
The fundamental transport rule prohibiting passing prompts, diffs, or instructions via argv, requiring payload ingestion exclusively through disk files or stdin streams.
_Avoid_: Command line argument, cli flag string

**Process Completion Contract**:
The verification invariant requiring both a clean process exit code ($0$) and a non-empty output artifact to confirm CLI execution success.
_Avoid_: Exit code check, return status

**Sentinel Marker**:
An unambiguous synchronization token (`<<<HARNESS_DONE>>>`) appended to agent responses to delimit complete instruction fulfillment.
_Avoid_: EOF character, stop token

## Security & Sandbox Policy

**Security Policy**:
The deterministic regulatory framework validating allowed Model actions, whitelisted execution binaries, permitted MCP servers, and workspace execution boundaries.
_Avoid_: Permissions, firewall

**Binary Whitelist**:
The strict registry of authorized CLI binaries permitted to be spawned by the Harness transport layer.
_Avoid_: Path search, allowed apps

**Forbidden Command Filter**:
The active guardrail mechanism intercepting and aborting destructive shell invocations before execution.
_Avoid_: Blacklist, linter

## L1 Operational Contracts & AI Strategies

**Disk Contract**:
A strictly validated file boundary (`op_*.json`) through which subagents and strategies exchange typed data, preventing conversational context pollution.
_Avoid_: Temp file, debug dump, JSON response

**Execution Strategy**:
A canonical algorithmic pattern directing how a Tactical Node is orchestrated and executed.
_Avoid_: Workflow, skill, prompt style

**Prompt Chaining**:
A sequential strategy where each step executes upon the verified output of the previous step using `op_memory.json`.
_Avoid_: Linear execution, waterfall

**Routing**:
A strategy that evaluates input and selects a specialized execution branch via `op_route.json`.
_Avoid_: Conditional logic, if-else branch

**Parallelization**:
A strategy partitioning independent work across isolated subagents and recombining their results.
_Avoid_: Multi-threading, concurrent tasks

**Orchestrator-Workers**:
A centralized strategy where an orchestrator dynamically assigns tasks to specialized workers via disk contracts.
_Avoid_: Master-slave, agent pool

**Map-Reduce**:
A strategy splitting large datasets into chunks for parallel processing and aggregating them into a unified deliverable.
_Avoid_: Batch processing, aggregation

**LATM (Tool Maker)**:
A strategy wherein the Model synthesizes, verifies, and executes a dedicated runtime tool to solve a specific subtask.
_Avoid_: Code generation, script runner

**Evaluator-Optimizer**:
An internal refinement loop where a generator and an evaluator iterate through structured feedback in `op_feedback_loop.json`.
_Avoid_: Self-correction, feedback loop

## Scaling & Workflow Profiles

**Scale Gating**:
The deterministic calculus selecting the execution mode (`classic`, `goal_loop`, `workflow`) and imposing strict safety bounds based on task criticality and oracle presence.
_Avoid_: Concurrency pool, task scheduler

**Workflow Profile**:
A preconfigured template defining resource ceilings, token budgets, and code-writing permissions for recurring operational patterns.
_Avoid_: Config preset, environment profile

**Phase Budgeting**:
The explicit allocation of token and iteration limits partitioned per execution phase within a specialized workflow profile.
_Avoid_: Total budget, general allowance

**Criticality Gate**:
The safety invariant that mandates strict single-executor sequential execution for `L3` criticality nodes, refusing parallel fan-out.
_Avoid_: Priority queue, critical lock

## Criticality Policy & Verification Tiers

**Criticality Policy**:
The graduated four-tier rubric (`L0` to `L3`) governing the required verification rigor, judge model capability, and quorum size for each node.
_Avoid_: Priority level, severity tag

**L0 Criticality (Oracle Only)**:
Trivial or deterministic execution validated exclusively by automated compilers or tests without spending LLM judge tokens.
_Avoid_: Unchecked node, skipped test

**L1 Criticality (Standard)**:
Standard operational task validated by a single medium-tier AI Judge.
_Avoid_: Normal priority

**L2 Criticality (High Impact)**:
High-impact deliverable validated by a single high-tier AI Judge.
_Avoid_: High priority

**L3 Criticality (System Invariant)**:
Foundational architectural change requiring a two-judge Quorum of maximum-tier models and sequential execution.
_Avoid_: Blocker, urgent task

**Quorum Verification**:
A multi-judge consensus mechanism requiring independent agreement from multiple distinct AI judges before advancing an L3 node.
_Avoid_: Voting pool, round-robin

## Model Evaluation & Tournament Architecture

**Capability Tier**:
The normalized performance ranking (`frontier`, `advanced`, `medium`, `light`) classifying LLM reasoning strength and operational cost.
_Avoid_: Model size, model family

**Model Tournament**:
An empirical evaluation contest executing standardized tasks across competing models to calibrate judge reliability and latency.
_Avoid_: Benchmark score, leader board

**Tier Fallback Cascade**:
The deterministic fallback mechanism traversing models within a tier before descending exactly one tier upon provider quota or connection exhaustion.
_Avoid_: Failover list, retry loop

## Task Archiving & Lifecycle

**Task Archival**:
The terminal lifecycle migration moving completed or blocked operational dossiers into `memory/archive/` upon reaching an end state.
_Avoid_: Deletion, file purge

**EndOfDecision Marker**:
A strict sentinel field (`"marker": "EndOfDecision"`) in L1 operational files declaring the irrevocable completion of a task.
_Avoid_: Done status, EOF

## Environment & Path Topology

**Project Anchor Marker**:
A deterministic root file identifier (such as `ProjectSettings/ProjectVersion.txt`) used to compute absolute repository paths reliably across submodules and nested worktrees.
_Avoid_: Git root, current working directory, relative path

## Cognitive Protocols & Laws

**Persona Shift**:
The explicit thought-isolation convention (`[SHIFT PERSONA]`) separating the reasoning boundaries of distinct subagent roles.
_Avoid_: Roleplay, system prompt switch

**No-Skip Law**:
The absolute mandate prohibiting skipping a stage or ignoring a failure without inserting an explicit resolution node.
_Avoid_: Error bypass, fail-open

**Anti-Hallucination Law**:
The strict prohibition against simulating or inventing outputs from external agents, judges, or system tools.
_Avoid_: Mocking, dry-run spoofing

**Model Fallback Protocol**:
The required procedure to exhaust all available models within a tier before descending exactly one tier upon API errors.
_Avoid_: Early exit, failover

## Verification & Protection

**Drift-Guard**:
The defensive control subsystem that periodically cross-validates cumulative implementation against the original Task Master.
_Avoid_: Watchdog, linter, timeout

**Sync Interval**:
The designated cadence of closed Tactical Nodes (typically 3–5) triggering a mandatory Drift-Guard synchronization check (`SYNC_DUE`).
_Avoid_: Checkpoint frequency, batch size

**AI Judge**:
An independent, isolated reasoning instance whose sole responsibility is evaluating submitted Evidence against the Task Master without shared conversational state.
_Avoid_: Self-evaluator, reviewer, critic

**Judge Chain**:
The prioritized sequential fallback chain of external CLI AI binaries evaluated first-alive-wins for independent verification.
_Avoid_: Judge pool, round-robin

**Preflight Quarantining**:
The proactive health-probe mechanism verifying CLI judge authentication via single-use nonces and applying a 24-hour quarantine to failing binaries.
_Avoid_: Healthcheck ping, binary watcher

**Cross-Family Evaluation**:
The multi-provider assessment mode ensuring judges belong to different model families than executors to maximize evaluation objectivity.
_Avoid_: Provider redundancy, multi-model vote

**Subagent Judge Fallback**:
An isolated fresh-session subagent invoked to perform validation only when all external CLI judges in the Judge Chain are unavailable.
_Avoid_: Local evaluator, self-test

**Human Gate**:
A mandatory, non-delegable checkpoint requiring explicit human authorization (restricted to L3 Wiki publishing, Git writes, and Critical Fail escalation).
_Avoid_: User prompt, interactive pause

**Integrity Gate (F5)**:
The comprehensive cross-validation barrier and automated stress-testing contour ensuring positive/negative gate enforcement and drift protection.
_Avoid_: Test runner, smoke test, health check
