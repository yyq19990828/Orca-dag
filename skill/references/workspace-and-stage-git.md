# Workspace Placement & Committed Stage Integration (Stage-Git)

## 1. Workspace Placement Decision Matrix

Orca executes every worker inside the coordinator's `current` workspace by default. Isolation and worktree placement are **viewer / `worker-start` launch configuration**, never embedded inside Task statuses.

| Parallelism & file overlap pattern | Placement choice | Rules to follow |
| :--- | :--- | :--- |
| Disjoint files, small run, single workspace safe | **`current`** (default) | No extra worktree overhead; warn workers not to touch each other's files |
| Parallel tasks editing overlapping files (local Git) | **Separate worktrees** (`new-child`, `new-top-level`, or distinct `existing` selectors) | Unordered tasks must **never** share one worktree; one worktree per concurrent branch |
| Sequential dependency chain (`A -> B -> C`) | **Serial Lane** (ordered tasks sharing one worktree) | Tasks in a lane must be totally ordered by dependencies (`deps`) |
| Reusing pre-created checkout / branch | **`existing`** (exact worktree selector) | Never rename or ask workers to create sibling worktrees inside it |
| Cross-host / paired Orca servers | **Remote host placement** (`--on <server>`) | Remote Stage-Git is unsupported; ordinary placements follow runtime `references/placement-and-remote.md` |

### Critical worker placement rules
- **Never instruct workers to branch or `git worktree add` themselves** when placement allocates a worktree. A worker creating its own nested worktree can fork a wrong Git base and leave its assigned Dispatch Stage empty.
- Tell every isolated worker: *"Edit, verify, and commit inside the worktree already assigned to your Dispatch."*
- **Launch locks**: Task preferences freeze while a Run's coordinator executes and lock permanently per Task after its first Dispatch. Never ask the user to move a started Task through disabled UI placement controls; if recovery is needed, follow the runtime recovery contract.

---

## 2. Ordinary Lane Join vs Committed Stage Integration (Stage-Git)

When downstream Tasks depend on parallel work across separate local Git worktrees, choose **one** of these two contracts:

| Contract | How downstream integration works | Safety & proof guarantee |
| :--- | :--- | :--- |
| **Ordinary Lane Join (Default without markers)** | Cross-lane dependency inserts/uses a human **`integrated`** checkpoint gate | Human assertion only — does **not** prove Git commit ancestry cleanly |
| **Committed Stage Integration (`Stage-Git`, Local Git only)** | Cross-worktree join splits into **`Merge-Prep Task`** → **`Development Task`** inside target worktree | Viewer coordinator replies with immutable dependency SHAs via `[orca-dag:merge-inputs-v3]` and verifies clean Git ancestry before releasing downstream dev |

---

## 3. Strict Contract for Committed Stage Integration (`Stage-Git`)

> **Terminology note:** Upstream Orca public orchestration contract is `contract 1` (`orchestration.contract.v1`), runtime protocol is `3`, federation lifecycle settlement protocol is `3`, and control mail protocol is `2`. `[orca-dag:merge-prep]` and `[orca-dag:merge-inputs-v3]` are **local viewer contract markers** (not global upstream protocol numbers) and must **never** be renamed.

### Preconditions (before starting execution)
1. **Local Git repository only**: Remote execution hosts and non-Git folder workspaces are unsupported in Stage-Git mode.
2. **Clean base HEAD**: Commit all source modifications in the current worktree — including a newly added `.gitignore` entry for `.orca-dag/` — **before** starting the Run. Keep `.orca-dag/` planning files ignored and **never force-add them**.
3. **Empty `baseBranch` override**: New worktrees in Stage-Git mode start from the Run's captured HEAD, so leave viewer `baseBranch` overrides empty.
4. **Clean Stage commits**: Every upstream source Stage worker **must commit all changes and leave its worktree clean** before reporting `worker_done`.
5. **No shared worktrees for unordered Tasks**: Parallel source Stages must each have their own worktree; unordered Tasks must never share a worktree even if their file sets appear disjoint.

### How to author every cross-worktree join in the DAG

For **every** join point where a downstream development Stage (`D`) depends on outputs from multiple upstream isolated worktrees (`S1`, `S2`, ...):

1. **Split `D` into TWO ordered Tasks** in the **same target worktree** (`target_wt`):
   - **Task `M` (Merge Preparation)**:
     - Depends on all upstream source Stages: `deps = ["S1", "S2", ...]`.
     - Assigned placement/lane: `target_wt`.
     - Spec **must** contain **both** markers:
       - `[orca-dag:merge-prep]`
       - `[orca-dag:merge-inputs-v3]`
     - Spec **must** forbid any Git edit before receiving immutable SHAs, and instruct the worker to ask the bound coordinator using the runtime-matched `ask` flow where:
       - **The ENTIRE question body is EXACTLY `[orca-dag:merge-inputs-v3]`** (no greeting, no surrounding prose, no extra whitespace).
     - After the coordinator replies with immutable commit SHAs, the worker executes history-preserving merges (`git merge --no-ff` or clean fast-forward merge as appropriate, never rewriting upstream commits), resolves conflicts, leaves the target worktree committed & clean, and reports completion (`worker_done`).
   - **Task `D` (Downstream Development)**:
     - Depends on `M` (`deps = ["M"]`).
     - Assigned to the **exact same target worktree** (`target_wt`) as `M` (serial lane).
     - Spec contains **only** the downstream feature/integration development work — Git ancestry of all source SHAs is verified automatically by the viewer coordinator before releasing `D`.

### Exact `[orca-dag:merge-inputs-v3]` Merge-Prep Spec Snippet

Include this block verbatim inside your `M` (`merge-prep`) Task's `--spec-file` (keeping the two markers exact):

```markdown
Markers: [orca-dag:merge-prep] [orca-dag:merge-inputs-v3]

## Merge Protocol (Mandatory Execution Order)
1. **Do NOT inspect source branches manually or perform any Git edit yet.**
2. Use your runtime preamble's `ask` flow to request immutable upstream commits from the coordinator, then **end your turn** and wait for the reply:
   - The ENTIRE `question` text must be **EXACTLY** `[orca-dag:merge-inputs-v3]` with no surrounding prose.
3. Once Orca wakes you with the coordinator's immutable dependency SHA list:
   - Merge each returned commit SHA into this Dispatch's assigned worktree using history-preserving Git merges (`git merge --no-ff <sha>` when non-fast-forward).
   - Resolve any merge conflicts faithfully without dropping upstream changes.
   - Re-run baseline build/sanity checks if specified below, confirm `git status --short` is clean with merge commit(s) landed, then report completion via `worker_done`.
```

### Rejection & Replanning Rules
- **Legacy markerless merge specs are rejected**: Orchestration Panel rejects runnable merge-prep specs lacking `[orca-dag:merge-inputs-v3]` at both launch-preview (`POST /api/launch-preview`) and execution admission. Never work around missing merge handshakes with ad-hoc `send` messages after launch — replan the corrected two-task graph in a **fresh Run**.
- **Ancestry gate failure**: If Git cannot prove that all dependency SHAs are ancestors of the merge worktree's clean HEAD when `M` settles, the viewer parks downstream Task `D` for inspection.
