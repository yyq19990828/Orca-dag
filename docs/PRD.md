# PRD: Orca-Native Worktree Orchestration Expansion

## Status

- Approved for DAG construction.
- Source of detail: this PRD, `docs/TECH_SPEC.md`, and the retained acceptance record at `docs/plans/1790067675_phase-6-acceptance-evidence.md`. The completed implementation plans are intentionally not shipped.
- Runtime baseline: Orca 1.4.206 while preserving the documented 1.4.205 execution floor.

## Problem

Orca-dag can schedule workers, but local tasks are effectively fixed to the coordinator workspace. The product does not expose Orca's complete local placement contract, cannot safely reuse a non-current workspace across a serial task lane, and cannot represent the human integration checkpoint required when branches from different workspaces converge.

The operator surface also lacks targeted stop/abandon controls, safe navigation to a worker waiting for human input, complete Run history, and Orca-native post-run review and cleanup.

## Goal

Make Orca-dag a complete, observable coordinator for local isolated work without bypassing Orca ownership. Every worktree creation and removal must remain visible in Orca IDE and must be performed through the resolved Orca CLI.

## Required capabilities

### Complete local placement

Every local task can select one of:

- `current`: the coordinator workspace;
- `existing`: an exact Orca-discovered Git worktree or folder workspace;
- `new-child`: a stacked worktree created by Orca;
- `new-top-level`: an independent worktree created by Orca from an exact repository selector.

New-worktree placement supports bounded name, setup policy, base branch, display name, and comment fields. Current and existing placement reject all creation-only fields and never rerun setup.

Remote placement remains limited to exact existing or `new-top-level`. Remote `current` and `new-child` remain invalid.

### Durable workspace lanes

A dependency-ordered task chain may share one local non-current workspace. The lane begins from exact existing, `new-child`, or `new-top-level` placement. After positive creation or discovery evidence, later tasks use the exact Orca selector and never reconstruct it from a name, branch, or path.

Tasks in different lanes may run concurrently. Tasks in one lane never run concurrently. Unordered tasks cannot be assigned to one lane.

### Honest cross-lane integration

A downstream task whose dependencies cross workspace lanes stays blocked by an Orca decision gate until a human resolves `integrated`. Dependency completion alone is not evidence of a merge. Orca-dag performs no automatic merge, rebase, cherry-pick, commit, push, or branch deletion.

### Per-Dispatch intervention

The operator can:

- stop one positively identified active Dispatch;
- abandon one positively exited or Orca-prescribed outcome-unknown Dispatch;
- focus one local exact worker terminal with positive `agentWait` evidence.

Missing, stale, remote, or unverifiable evidence authorizes no action.

### History, review, and cleanup

- Run discovery supports cursor pagination and exact Run ID lookup while preserving workspace ownership.
- Local changed files and diffs open through Orca in the proven workspace.
- Worktree removal is explicit, token-protected, ownership-checked, and performed only through `orca worktree rm`.
- Capability display recognizes the `orchestration.contract.v1` and `orchestration.federation.v1` umbrella rows without using them to enable narrower controls.

## User experience

1. The user selects a task node.
2. Local placement offers all four choices; remote placement offers the two valid remote choices.
3. The viewer validates the whole DAG and placement plan before mutation.
4. The coordinator starts workers through Orca and displays requested versus effective placement.
5. Workspace lanes and integration gates explain why a task is running or blocked.
6. The operator can intervene in one worker without disturbing other lanes.
7. After completion, the user can review changes and explicitly retain or remove Orca worktrees.

## Non-goals

- Native `git worktree` creation, removal, pruning, or direct directory deletion.
- Automatic source integration or pull-request creation.
- Remote `current` or `new-child` placement.
- New-worktree creation from a folder workspace; folders remain valid exact-existing targets.
- Automatic lifecycle actions based on timeout, silence, or missing evidence.
- Supporting non-current placement through the OpenCode/custom legacy execution path until it can preserve Orca ownership atomically.
- Graph editing, task deletion, or orchestration database reset.
- Model fallback configuration for this implementation Run.

## Success criteria

- All four local placement modes pass adapter, validation, coordinator, UI, and live Orca IDE checks.
- New worktrees are created only by `orca orchestration worker-start` and removed only by `orca worktree rm`.
- Existing, child, and top-level lanes reuse exact Orca selectors across tasks, retries, and viewer restart.
- Cross-lane joins cannot execute before the visible Orca integration gate is resolved.
- Stop, abandon, focus, pagination, review, cleanup, and umbrella capability acceptance scenarios pass.
- `npm run check` and `git diff --check` pass.
- `README.md` and `README_zh.md` remain synchronized.

## Implementation Run profile

- Harness: `opencode` for every task.
- Model: `zai-coding-plan/glm-5.3-flash#max` for every task.
- Automatic model fallback: disabled by explicit user decision.
- Maximum parallelism: three, limited further by DAG dependencies and file ownership.
- Execution starts only from the Orca-dag viewer after the user selects the new Run.
