# Standard Artifact & Spec Templates

Write planning files in `.orca-dag/<timestamp>/` (`YYYYMMDD-HHmmss-SSS`) and Task/Gate text in the **user's conversation language** (preserving technical identifiers, paths, symbol names, and local markers verbatim).

---

## 1. `.orca-dag/<timestamp>/PRD.md` Template

For **S-size** tasks, keep Non-Goals and External Prerequisites brief; for **M/L-size** tasks, complete every section thoroughly.

```markdown
# PRD — <Project / Feature Title>

- **Planning Dir**: `.orca-dag/<timestamp>/`
- **Orca Run ID**: `<pending — recorded after Phase 3 run-create>`
- **Sizing**: `S` | `M` | `L`
- **Preferred Coordination**: `human_panel` | `agent_coordinator`

## 1. Goal & Problem Statement
- **Goal**: <What outcome proves this effort succeeded?>
- **Background**: <Concise problem context and constraints.>

## 2. MVP / P0 Scope
- [ ] <Requirement 1 — observable user/system behavior>
- [ ] <Requirement 2 — observable user/system behavior>

## 3. Explicit Non-Goals (Out of Scope)
- <Excluded feature, refactor, or deferred P1 item>

## 4. External Prerequisites & Test Resources
| Resource / Service | Owner | Exact Path / Selector / Access | Allowed Changes | Cleanup Owner |
| :--- | :--- | :--- | :--- | :--- |
| <e.g., local test DB / fixture workspace> | <Task ID or User> | <path, URL, or selector> | <read-only / seed / migrate> | <who resets/removes it> |

*(If no external runtimes/accounts/fixtures are needed, state "None — self-contained inside repository worktree.")*

## 5. Acceptance Criteria
- <Concrete checks, test commands, or UI/API behavior required before completion>
```

---

## 2. `.orca-dag/<timestamp>/TECH_SPEC.md` Template

```markdown
# Technical Spec — <Project / Feature Title>

- **Planning Dir**: `.orca-dag/<timestamp>/`
- **Orca Run ID**: `<pending — recorded after Phase 3 run-create>`

## 1. Architecture & Technology Stack
- **Key modules / files impacted**: <List exact paths>
- **Architectural approach**: <Key design choices and trade-offs>

## 2. Data Model & Contracts
- <Schema, types, fields, invariants, migration or backward-compatibility notes>

## 3. Module Interfaces (Pseudocode)
```ts
// Concrete signatures and boundaries between parallel Stages
```

## 4. DAG Topology & Workspace Placement Plan
| Order / Wave | Stage ID (after creation) | Short Title (≤1 line for card) | Dependencies | Placement / Lane | Harness / Model Suggestion |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Wave 1 | `<pending>` | `<concise title>` | `[]` | `current` or `<lane/worktree>` | `<e.g. codex · medium>` |
| Gate 1 | `<pending>` | `<approval question?>` | `Wave 1` | — | Human gate (`approve / reject`) |
| Wave 2 | `<pending>` | `<concise title>` | `["<task_1>"]` | `<same lane / isolated>` | `<e.g. claude>` |

## 5. Gate & Integration Plan
- **Approval gates**: <Why each gate exists and what the human verifies>
- **Cross-worktree integration** (if isolated worktrees are used): `Stage-Git ([orca-dag:merge-prep] + [orca-dag:merge-inputs-v3])` or `Ordinary lane integrated checkpoint`

## 6. End-to-End Verification Plan
- <Exact commands or checks to run once leaf Stages settle>
```

---

## 3. Self-Contained Task Spec Template (6-Part Floor Contract)

Remember: `.orca-dag/` docs are **gitignored** and **do not exist in newly created isolated worktrees**. Every Task spec passed via `--spec-file` must stand completely alone:

```markdown
> Provenance: `.orca-dag/<timestamp>/TECH_SPEC.md` (reference only — all required inputs are embedded below)

## Target
- Goal: <Single-sentence objective for this Stage>
- Context: <Relevant architecture contracts, field definitions, and upstream interfaces needed right now>

## Required Change
1. <Imperative step 1 with exact module/symbol names>
2. <Imperative step 2>
3. <No vague phrasing like "investigate" or "handle as appropriate">

## Ownership (Editable Scope)
- **Allowed to modify/create**: `<exact file paths or directories>`
- **Do NOT modify**: `<files owned by sibling parallel tasks>`
- **Workspace rule**: Work and commit only inside the Dispatch-assigned worktree. Do NOT create additional git worktrees or switch branches manually.

## Constraints & Prerequisites
- <Language/framework constraints, invariants, external resource details (owner/path/cleanup), or interface contracts>
- Unexpected blockers: if blocked on an unresolvable ambiguity or missing dependency, use the runtime preamble's `ask` flow and **end your turn** so Orca wakes you with the reply — never guess silently.

## Observable Acceptance Evidence
Run and report verbatim results of:
- `<exact typecheck command>`
- `<exact test command>`
(Also for Stage-Git worktrees: confirm `git status --short` is clean and changes are committed on the assigned worktree before `worker_done`.)

## Exit-Code Semantics
- A non-zero exit code from verification checks means the **Task failed** (unless explicitly marked as an expected-failure reproduction deliverable).
```

---

## 4. Approval & Integration Gate Templates

Keep `--question` crisp (1–2 lines) and option strings short so hexagonal/octagonal `244×100` gate nodes stay legible:

- **Approval Gate**:
  - Question (EN): `"Approve API contract & migration plan before backend implementation?"`
  - Question (ZH): `"确认 API 契约与迁移方案后继续下游实现？"`
  - Options: `approve`, `reject`
- **Integration Gate** (ordinary multi-lane fallback):
  - Created automatically/manually only when non-Stage-Git parallel worktree lanes join downstream; resolution string is `integrated` (human assertion only — does not prove Git ancestry).

---

## 5. Handover Report Template (Phase 4 Route A Default)

```markdown
### Orchestration DAG Ready

- **Run ID**: `<run_id>`
- **Planning Directory**: `.orca-dag/<timestamp>/` (`PRD.md`, `TECH_SPEC.md`)
- **Topology Summary**: <1 sentence describing parallel roots, serial chains, and gates>

#### Recommended Launch Settings (Review in Orchestration Panel)
- **Coordination Mode**: `Orchestration Panel (Human-driven)` *(or note if user wants Agent-as-Coordinator)*
- **Suggested Max Concurrency**: `<N>`
- **Node Suggestions**:
  - `<task_title>` (`<task_id>`): Harness `<harness>`, Model `<optional>`, Placement `<current / lane / worktree>`
- **Pre-Launch Reminders**: <e.g., "Commit local changes before running Stage-Git" or "No external setup needed">

#### Next Steps
1. Open **Orchestration Panel** inside Orca (native sidebar/tab on Orca `>= 1.4.263`), or launch `npx orca-orchestration-launcher` in the project root.
2. Select Run **`<run_id>`**, review harnesses/placements, and click **Run** (or **▶ Run with Orca**).
```
