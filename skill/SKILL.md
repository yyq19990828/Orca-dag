---
name: orca-dag
description: "Plan software work through a structured 5-phase SOP into an Orca orchestration task DAG and hand it off to Orchestration Panel (or coordinate it directly in Orca when requested), with first-run user preference onboarding in USER_PREFERENCES.md."
---

# orca-dag — Structured Orchestration Handbook

Turn software requirements into a verified **Orca orchestration task DAG** executed in parallel waves. Every planning output **must be written into Orca orchestration state** (never left as chat prose alone), because Orchestration Panel polls Orca live and renders whatever exists in the Run.

**Authority rule:** This handbook owns the **project workflow** (preferences, PRD, technical design, DAG shape, Stage-Git integration, handover). All orchestration command flags, JSON schemas, worker lifecycle, and gate rules belong to the **runtime-matched `orchestration` guide** loaded in Phase 0. If the runtime guide and this handbook ever disagree, **the runtime guide wins**.

```text
[Phase 0: Preflight & Preferences]
  Resolve 1 CLI -> Check runtime (>=1.4.205) -> Load `skills get orchestration`
  -> Load or initialize `<skill-dir>/USER_PREFERENCES.md` -> Verify `.gitignore`
        │
        ▼
[Phase 1: Scope & PRD]
  Classify size (S/M/L) -> Clarify 1 question at a time -> Name external resources
  -> Write `.orca-dag/<timestamp>/PRD.md`
        │
        ▼
[Phase 2: Tech Spec & Topology]
  Interfaces & data -> Workspace placement & lanes -> Approval / Integration gates
  -> Write `.orca-dag/<timestamp>/TECH_SPEC.md`
        │
        ▼
[Phase 3: Author & Verify DAG]
  Open Run (`run-create`) -> Batch `task-create` (`--spec-file`) -> Gates
  -> Verify `task-list --run <id>` -> Record Run ID in PRD & TECH_SPEC
        │
        ▼
[Phase 4: Handover or Coordinate]
  Route A: Orchestration Panel (Default) | Route B: Viewer API | Route C: Agent Coordinator
```

## Quick routing tables

### Task sizing rubric

| Size | Scope & shape | Planning docs (`.orca-dag/<timestamp>/`) | Workspace placement default |
| :--- | :--- | :--- | :--- |
| **S** (1–2 tasks, serial) | Focused fix or small module change | Concise `PRD.md` + compact `TECH_SPEC.md` | Coordinator `current` workspace |
| **M** (3–6 tasks, mixed) | Multi-module feature, partial parallelism | Standard `PRD.md` + `TECH_SPEC.md` (templates) | `current` if disjoint files; isolated worktrees if overlapping |
| **L** (multi-branch parallel / join) | Cross-feature parallel dev + integration | Full `PRD.md` + `TECH_SPEC.md` + Stage-Git split | Separate worktrees / Serial Lanes + `[orca-dag:merge-prep]` or `integrated` gate |

### Coordination modes

| Route | When to use | Panel observability state | Reference |
| :--- | :--- | :--- | :--- |
| **Route A — Human-driven Orchestration Panel (Default)** | User picks per-node harness/model/placement, runs parallel waves, handles gates/Q&A/permissions | `human_panel` (or `panel_mismatch` if terminal target differs) | This file (Phase 4) |
| **Route B — Viewer API Launch (When requested)** | User explicitly asks you to launch execution via the running viewer's HTTP API | `human_panel` | `references/execution-and-harnesses.md` |
| **Route C — Agent-as-Coordinator (When explicitly asked)** | User asks *you* (Orca chat or PTY agent session) to drive workers via Orca wake loop | `agent_native_chat` or `agent_terminal` (read-only Panel view) | Runtime guide `references/coordinator-loop.md` |

## Allowed tools & workspace boundaries
- **Bash**: Run only the resolved Orca CLI (`ORCA`), check runtime readiness, inspect Git status/branches, or call the verified loopback viewer API when executing Route B. Never run destructive unrelated commands (`rm`, `git push`, wiping user files).
- **Read / Write / Edit**: Write planning docs under `.orca-dag/<timestamp>/` and user preferences in `<skill-dir>/USER_PREFERENCES.md`. Keep `.gitignore` protection verified before creating planning files.

---

## Phase 0 — Preflight, Runtime Guide & User Preferences

### 0.1 Resolve ONE literal Orca CLI
On Linux outside a managed Orca terminal, bare `orca` is usually GNOME's **screen reader** (`/usr/bin/orca`, `--version` prints a small number like `42.0`). Resolve **one** binary in this exact order and keep using it verbatim for the entire session:

| Priority | Condition | Resolved `<cli>` |
| :--- | :--- | :--- |
| 1 | `ORCA_CLI_COMMAND` env var is set | Exact quoted argv (parsed with no shell) |
| 2 | `ORCA_DEV_REPO_ROOT` env var is set | `orca-dev` |
| 3 | Linux **outside** a managed Orca terminal | `orca-ide` |
| 4 | Otherwise (inside Orca terminal / macOS / Windows) | `orca` |

### 0.2 Check runtime readiness & version tier
```bash
<cli> status --json
```
- `result.runtime.state` must be `"ready"` (otherwise ask the user to run `orca open` first).
- **Version tiers** (`result.runtime.appVersion`):
  - `< 1.4.160`: unsupported.
  - `1.4.160 – 1.4.204`: viewer stays read-only (no execution).
  - `>= 1.4.205` (**execution baseline**): full DAG authoring & viewer execution.
  - `>= 1.4.263`: unlocks native `orchestration-panel` plugin, verified OMP `--effort`, cascading helper stops, paired peer mail, and single-use worker permission prompts.

### 0.3 Load the runtime-matched orchestration guide (Required)
Before asking planning questions or touching orchestration state, load the guide from the resolved CLI:
```bash
<cli> skills get orchestration
```
- If the CLI rejects `skills get`, stop and report the installed runtime version (execution requires `>= 1.4.205`).
- Load bundled runtime references on demand (`<cli> skills get orchestration --references`):
  - `references/coordinator-loop.md` (multi-Run handling, wake-driven coordination)
  - `references/messaging-and-gates.md` (group mail, approval/integration gates)
  - `references/placement-and-remote.md` (worktrees, SSH/WSL, paired servers)
  - `references/recovery-and-cleanup.md` (failed/unknown workers, stop/abandon, circuit breaker, reopen)

### 0.4 Load or initialize `<skill-dir>/USER_PREFERENCES.md`
Let `<skill-dir>` denote the directory containing this loaded `SKILL.md` file:
- **If `<skill-dir>/USER_PREFERENCES.md` exists**: Read it, adopt its saved defaults (coordination mode, preferred harness/model/effort, OpenCode UI, planning doc depth, language, workspace strategy, approval cadence), and echo a concise **1-line summary** of active defaults. Explicit instructions in the current chat always override saved defaults.
- **If `<skill-dir>/USER_PREFERENCES.md` is missing (first run)**: Read `<skill-dir>/references/preferences.md`, then offer a quick **1-turn setup** asking the user's preferences on:
  1. Default coordination mode (`human_panel` via Orchestration Panel vs `agent_coordinator` vs `ask_each_time`),
  2. Preferred verified harness (`claude` / `codex` / `opencode` / `omp` / `antigravity` / `ask`) + optional default model/effort,
  3. Default planning doc verbosity & language (`adaptive` / `full` / `spec_only`; `match_conversation` / `zh` / `en`),
  4. Default workspace isolation (`current` / `isolated_worktrees` / `stage_git`) & approval gate style.
  Accept `"defaults"` or `"skip"` to save recommended defaults immediately and continue without slowing the user down. Never store tokens/secrets; never write through symlinks. If `<skill-dir>` is read-only (e.g. inside a locked checkout), proceed cleanly with session defaults and inform the user once.

### 0.5 Verify `.gitignore` protection
- Standalone launcher (`npx orca-orchestration-launcher`) automatically appends a marked `.orca-dag/` rule in `.gitignore` on startup (unless `--no-workspace-init`).
- Native plugin (`orchestration-panel`) or skill-only installs **do not edit `.gitignore`**: verify `.orca-dag/` is ignored before creating planning directories; if missing, add `.orca-dag/` (never write through a symlinked `.gitignore` or `.orca-dag` dir) or warn explicitly.
- Note that `npx orca-orchestration-launcher uninstall` removes managed ignore blocks and skill files while keeping planning docs (and keeping `USER_PREFERENCES.md` unless `--purge` is passed). See `references/artifacts-and-troubleshooting.md` for full details.

**Phase 0 Exit Checklist:**
- [ ] One literal `<cli>` resolved and `status --json` verified (`ready`, `>= 1.4.205` for execution).
- [ ] Runtime `skills get orchestration` guide loaded.
- [ ] `USER_PREFERENCES.md` loaded (or initialized on first run) and active defaults noted.
- [ ] `.gitignore` ignores `.orca-dag/` (or warning/fix surfaced before creating files).

---

## Phase 1 — Requirement Clarification & `PRD.md`

1. **Create an exclusive planning directory** for this Run under `.orca-dag/<timestamp>/` using filesystem-safe UTC timestamp with milliseconds (`YYYYMMDD-HHmmss-SSS`, e.g., `.orca-dag/20261120-164000-123/`). Never reuse another Run's directory or overwrite existing plans. Keep all intermediate notes inside this same directory — never in `docs/` or repo root.
2. **Clarify requirements iteratively**: Apply user preferences for depth/language, ask **one key question at a time** to lock: Goal, MVP/P0 Scope, Explicit Non-Goals, and Acceptance Criteria. Avoid over-engineering when P0 MVP suffices.
3. **Audit external prerequisites explicitly**:
   - Separate **worker placement** (where code edits run) from **external test resources** (dedicated test runtime, fixture DB/workspace, account credentials, local dev server). Viewer placement controls never provision arbitrary external runtimes.
   - If a task needs external resources, either provision them beforehand or insert an explicit preparation dependency naming: resource owner, exact path/selector, runtime identity, access method, allowed mutations, and cleanup owner.
4. **Write `.orca-dag/<timestamp>/PRD.md`** in the user's conversation language (unless `USER_PREFERENCES.md` fixes a language) using the template in `references/templates.md`.

**Phase 1 Exit Checklist:**
- [ ] Exclusive `.orca-dag/<timestamp>/` directory created.
- [ ] Goal, P0 scope, non-goals, and acceptance criteria agreed.
- [ ] All external test/runtime prerequisites assigned clear ownership (nothing hidden in vague prose).
- [ ] `.orca-dag/<timestamp>/PRD.md` written.

---

## Phase 2 — Technical Design & DAG Topology (`TECH_SPEC.md`)

1. **Author technical architecture**: Concrete stack, data model down to field types, module/API interfaces (pseudocode), error handling, and verification plan.
2. **Decompose into parallel & serial Stages**: Maximize safe parallelism across disjoint files/modules; keep conflicting edits serialized or isolated.
3. **Plan workspace placement & integration**:
   - By default, tasks run in coordinator `current` workspace.
   - Tasks modifying overlapping files in parallel **must** use isolated worktrees (`existing`, `new-child`, `new-top-level`) or share an ordered Serial Lane.
   - If downstream work integrates committed results from multiple isolated worktrees on local Git, **load `references/workspace-and-stage-git.md`** to design the two-step `[orca-dag:merge-prep]` + `[orca-dag:merge-inputs-v3]` split (or ordinary human `integrated` checkpoint). Remember: uncommitted source changes (including a newly added `.gitignore` rule) must be committed cleanly **before** starting a Stage-Git Run.
4. **Plan decision gates & harnesses**:
   - Place approval gates at irreversible milestones or human checkpoints.
   - Account for verified worker harnesses (`claude`, `codex`, `opencode`, `omp`, `antigravity`; `gemini`/`grok`/`cursor`/`droid`/`kimi` are refused). See `references/execution-and-harnesses.md` when choosing model/effort/OpenCode UI.
   - Remember **launch locks**: preferences freeze when execution starts and lock per-task upon first Dispatch.
5. **Write `.orca-dag/<timestamp>/TECH_SPEC.md`** in the **same** `.orca-dag/<timestamp>/` directory using `references/templates.md`.

**Phase 2 Exit Checklist:**
- [ ] Task decomposition covers every P0 requirement with acyclic dependencies (`deps`).
- [ ] Every parallel write conflict resolved via dependencies, Serial Lanes, or isolated worktrees.
- [ ] Stage-Git `[orca-dag:merge-prep]` / `[orca-dag:merge-inputs-v3]` splits (if used) and approval gates designed.
- [ ] `.orca-dag/<timestamp>/TECH_SPEC.md` written alongside `PRD.md`.

---

## Phase 3 — Author & Verify the DAG in Orca

1. **Match the user's conversation language** for Run objective, Task `--task-title`, `--display-name`, `--spec-file`, and Gate `--question`. Keep technical identifiers, file paths, symbol names, CLI flags, code snippets, and `[orca-dag:merge-prep]` / `[orca-dag:merge-inputs-v3]` verbatim.
2. **Optimize text for UI readability**:
   - **Task cards (`296×136` canvas + sidebar)**: keep `--task-title` / `--display-name` concise enough to fit cleanly on 1 line; keep long detail inside `--spec-file`.
   - **Gate nodes (`244×100` hexagonal/octagonal checkpoints)**: keep `--question` crisp (≤ 2 lines) and action option labels concise.
3. **Create a fresh Run** using the runtime guide's `run-create` operation and record the returned `run_*` id.
   - On Orca `>= 1.4.263`, later `run-create` calls keep older Runs active while commands omitting `--run` target the newest Run — **always pass `--run <run_id>` explicitly**.
   - To replan, always open a **new** Run — **never** `reset`.
4. **Create Tasks in topological order** using the runtime guide's `task-create` operation:
   - Pass dependencies as a JSON array of earlier `task_*` IDs within the **same** Run.
   - On Orca `>= 1.4.263`, prefer `--spec-file` (or stdin) for multi-line Markdown specs so shell quoting never corrupts code fences or backticks.
   - Write **self-contained specs** using the 6-part template in `references/templates.md` (`Target`, `Change`, `Ownership`, `Constraints & Prerequisites`, `Acceptance Evidence`, `Exit-Code Semantics`). Remember `.orca-dag/` docs are gitignored and absent in isolated worktrees: embed all required context inline (cite `.orca-dag/<timestamp>/...` only as provenance, never as required worker input), instruct workers to work in their assigned Dispatch worktree (never manually create branches/worktrees when placement already creates one), and remind them to commit cleanly before `worker_done` in Stage-Git runs.
5. **Add Decision Gates** via `gate-create` (or `POST /api/gates` pre-dispatch) where human approval is needed.
6. **Verify every batch live** with a Run-scoped `task-list --run <run_id> --json` (and `gate-list --run <run_id> --json`): check all IDs and dependency edges immediately, because existing Tasks/deps **cannot be edited or deleted after creation**.
7. **Finalize documentation**: Write the created `run_id` into both `.orca-dag/<timestamp>/PRD.md` and `.orca-dag/<timestamp>/TECH_SPEC.md`, and summarize the DAG's parallel vs serial waves in one sentence for the user.

**Phase 3 Exit Checklist:**
- [ ] Fresh `run_<id>` created and passed explicitly via `--run` on every operation.
- [ ] All Tasks and Gates created with self-contained specs and verified via `task-list --run <run_id> --json`.
- [ ] Zero broken edges, missing specs, or ambiguous external resources.
- [ ] `run_id` recorded in both `PRD.md` and `TECH_SPEC.md`.

---

## Phase 4 — Handover or Coordinate Execution

Follow the user's selected route (from chat instruction or `USER_PREFERENCES.md`):

### Route A — Handover to Orchestration Panel (Default)
1. Deliver the structured **Handover Report** (`references/templates.md`): Run ID, `.orca-dag/<timestamp>/` path, parallel/serial wave summary, recommended Harness/Model/Placement suggestions, and any pre-run notes (e.g., clean Git commit required for Stage-Git).
2. Point the user to Orchestration Panel:
   - **Native Orca Plugin (`orchestration-panel`, Orca `>= 1.4.263`)**: Already embedded in Orca right sidebar (**Tasks** / **Pending** / **Live**) and workbench tab — no manual terminal needed.
   - **Standalone Launcher** (if plugin not active):
     ```bash
     npx orca-orchestration-launcher
     ```
3. In Orchestration Panel, inspect **Launch Preview** & account quotas if needed, configure harnesses/models/worktree placements, and click **Run** (or **Run with Orca**).

### Route B — Launch Viewer Execution via API (When explicitly asked)
Read `references/execution-and-harnesses.md`, verify the trusted local port (`POST /api/launch-preview`, `GET /api/accounts`), and trigger `POST /api/run` using the verified script. Wait cleanly for user checks or monitor read-only without interfering with the viewer's bound terminal.

### Route C — Agent-as-Coordinator (When explicitly asked)
Load `<cli> skills get orchestration --reference references/coordinator-loop.md` and `references/recovery-and-cleanup.md`: start independent ready workers, **end your turn** so Orca wakes you on replies/completions (never run polling/watch scripts), steer via `send`, and let Orchestration Panel observe live in read-only mode.

**⚠️ Coordinator Fencing Rule:** Clicking **Run** in Orchestration Panel binds its own coordinator terminal to the Run, causing subsequent terminal mutations from your agent to fail with `consumer_fenced` (reads stay open). See `references/artifacts-and-troubleshooting.md` for `run-use` handback and explicit `coordinatorControl` confirmation rules.

**Phase 4 Exit Checklist:**
- [ ] Handover report sent with exact Run ID + `.orca-dag/<timestamp>/` path (or coordinator loop / API run initiated as explicitly requested).
- [ ] Active preferences match expectations (offer `"update my orca-dag preferences"` anytime if user adjusts defaults).

---

## On-Demand Reference Routing

### Skill Handbooks (`<skill-dir>/references/*.md`)
| Scenario | Reference to read |
| :--- | :--- |
| First-run setup or updating saved defaults (`USER_PREFERENCES.md`) | `references/preferences.md` |
| Writing `PRD.md`, `TECH_SPEC.md`, Task Spec (6-part), Gate, or Handover | `references/templates.md` |
| Isolated worktrees, Serial Lanes, remote placement, or Stage-Git merge protocol | `references/workspace-and-stage-git.md` |
| Verified harnesses, OMP/OpenCode routing, L1 resume, `/api/run` execution | `references/execution-and-harnesses.md` |
| `.orca-dag/` stores, `.gitignore`/`uninstall`, fencing, circuit breaker, runtime quirks | `references/artifacts-and-troubleshooting.md` |

### Runtime Orca CLI References (`<cli> skills get orchestration --reference ...`)
- `references/coordinator-loop.md` — Wake-driven coordination loop & multiple Runs
- `references/messaging-and-gates.md` — Group mail & gate CLI mechanics
- `references/placement-and-remote.md` — Worktrees, SSH/WSL, paired execution servers
- `references/recovery-and-cleanup.md` — Worker failure, stop/abandon, reopen after circuit breaker

---

## Non-Negotiable Guardrails
- **Immutability after creation**: Created Tasks cannot change title/spec/deps and cannot be deleted; new Tasks/Gates may still be added before completion, otherwise **replan in a fresh Run**.
- **Never `reset` during planning**: `orchestration reset --tasks`/`--all` wipes **all** Runs across the workspace DB with no `--run` filter.
- **No self-healing past circuit breakers**: 3 consecutive failed start attempts in one `--retry-of` chain trip `circuit_broken`. Never invent replacement Tasks/Runs around it; surface for user-directed inspection/release/reopen (`references/artifacts-and-troubleshooting.md`).
- **No retired scheduler commands**: Do not invoke `orchestration run` / `run-stop` / `coordinator-start` / `coordinator-stop`.
- **No copy-pasted orchestration mutation flags**: Command syntax lives strictly in `<cli> skills get orchestration`.
- **No secrets in preferences**: `USER_PREFERENCES.md` holds workflow/tool preferences only, never tokens, API keys, or credentials.

## Communication Style
- Match the user's language across conversation, `PRD.md`, `TECH_SPEC.md`, Run objectives, Task titles/display names/specs, and Gate questions.
- After every batch of created Tasks, summarize the current DAG shape in **one sentence** (what runs in parallel, what serializes).
