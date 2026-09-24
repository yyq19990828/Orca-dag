# Tutorial: Stage behavior in isolated worktrees

English | [简体中文](worktree-isolation_zh.md)

In the viewer, a **Stage** is an Orca Task, not Git's staging area. Each Git worktree has its own working files and index. `git add` in a worker worktree does not stage files in the coordinator worktree; a commit on one branch does not appear in another branch without integration. Worktrees share repository history and refs, so choose a base and target branch deliberately.

## Pick placement for the work, not for the worker terminal

A fresh agent terminal does not imply a fresh worktree. Pick the Stage's placement before its first Dispatch:

| Placement | Use and effect | Parameters |
| --- | --- | --- |
| `current` | Use the coordinator's workspace; the default when no placement is set. | No creation fields; setup is not rerun. |
| `existing` | Use an Orca-discovered Git worktree or registered folder workspace. | Select its **full, exact** `selector`; do not invent one from a path or branch name. |
| `new-child` | Create a stacked child of the current workspace's repository during worker start. | Creation fields below; no repository override. |
| `new-top-level` | Create an independent worktree from a selected repository during worker start. | Exact discovered `repo` selector plus creation fields. |

The viewer maps these choices to Orca's supervised `worker-start`. Orca's receipt reports requested and effective placement and owns the created worktree, setup, Dispatch, and terminal effects. A failed creation never falls back to `current`. Terminal creation or reuse is a separate decision from workspace placement.

For CLI operators, the current `worker-start` contract has these relevant parameters; the viewer supplies them from its Stage settings:

| Parameter | Meaning |
| --- | --- |
| `--task` / `--agent` | Existing Task ID and chosen agent. `--spec` would create a new Task instead. |
| `--worktree` | `current`, `new-child`, `new-top-level`, or an exact existing selector returned by Orca. |
| `--on` / `--repo` | `--on` selects a saved execution server; `--repo` is required for a new top-level worktree on that server. The Run stays on the coordinator server. |
| `--model` / `--effort` | Launch preferences for supported agents; effort requires a model. Neither can combine with a reused `--terminal`. |
| `--retry-of` | Exact, positively failed or stopped Dispatch being retried. It requires `--task` and does **not** inherit placement; repeat the intended workspace and agent. |

Read `orca skills get orchestration` and `worker-start --help` on the selected CLI before driving a worker directly. The viewer handles authority, placement, and recovery receipts during normal DAG execution.

### Creation fields and limits

Only `new-child` and `new-top-level` accept these fields. The viewer checks them at the HTTP boundary and the Orca adapter checks again before launch.

| Field | Meaning and rule |
| --- | --- |
| `name` | One token, 1–64 characters: ASCII letter/digit first, then letters/digits/`.`/`_`/`-`. Locally optional; the viewer derives a bounded name from Run and Task or lane IDs. Remote `new-top-level` requires an explicit name. |
| `setup` | `run` (default), `skip`, or `inherit` for repository setup hooks on a **new** worktree. Current and Existing never rerun setup. Orca's repository startup policy determines whether a `run` hook runs beside the agent or gates prompt delivery. |
| `baseBranch` | Optional base ref, up to 128 characters. Letters, digits, `.`, `_`, `/`, `-` are accepted; `..`, trailing `/` or `.`, leading `-`, and whitespace are refused. |
| `displayName` / `comment` | Optional Orca metadata; at most 120 / 500 characters. They do not choose the Git branch or the workspace identity. |
| `repo` | Required for `new-top-level`; select the exact repository Orca discovered on the execution server. Invalid for `new-child`. |

For a **saved remote environment**, the Run remains on the viewer's Orca server while only the worker starts remotely. Remote placement allows an exact existing workspace or a `new-top-level` worktree with exact `repo` and explicit `name`; remote `current` and `new-child` are refused as ambiguous. Subsequent messages, reads, stop, and cleanup address the **Dispatch ID**, not a guessed remote terminal. A disconnected host is `unverifiable`, not exited.

OpenCode and custom commands use the viewer's legacy local launch path. That path cannot own a non-Current placement or a lane, so the viewer rejects the combination before creating a Dispatch.

## Specify what an isolated Stage may do

An isolated worker needs a self-contained spec that names its assigned workspace boundary. A useful brief is:

> **Target:** API export files. **Change:** implement the CSV endpoint. **Constraints:** preserve authorization and the agreed CSV contract. **Ownership:** work only in the workspace Orca assigned to this Dispatch; do not edit another Stage's worktree or integrate branches. **Acceptance:** report branch and HEAD, changed files, staged and unstaged changes, verification, and any blocker. Commit only if this Task explicitly requests it.

Dependencies order work but do not transfer code. Before a downstream Stage relies on another worktree, account for all three kinds of state:

| State in source worktree | What a different worktree receives |
| --- | --- |
| Unstaged or untracked files | Nothing automatically; preserve or transfer them deliberately. |
| `git add` staged files | Still nothing; the index belongs to the source worktree. |
| A commit on the source branch | The commit exists in the shared repository, but the target branch/worktree does not acquire it automatically. |

Use the project's normal Git workflow to integrate only the intended changes. Review `git status --short`, staged and unstaged diffs, branch, and HEAD **inside the source and target worktrees** before declaring the target ready. The viewer itself does not merge, rebase, cherry-pick, commit, push, or delete branches.

## Reuse one workspace through a lane

A **workspace lane** is one non-Current local workspace shared by a dependency-ordered Task chain. For example:

```text
Lane api:  API implementation → API review
Lane ui:   UI implementation
Current:   Integration and verification ← API review + UI implementation
```

The first member opens or creates the lane's workspace. Later members, retries, and a viewer restart reuse the **exact selector Orca returned**. The lane's stored seed is launch intent; live worktree ID, path, branch, HEAD, and Dispatch come from Orca evidence. A lane cannot be seeded by `current`, and a member cannot also have direct placement or a saved remote environment.

In the viewer's saved configuration, the relationship is a lane ID mapped to one seed plus Task IDs mapped to that lane. For example:

```json
{
  "worktreeLanes": { "api": { "placement": { "kind": "new-child", "setup": "run" } } },
  "laneByTask": { "task_api": "api", "task_api_review": "api" }
}
```

The two Tasks still need a dependency path between them; assigning both to `api` does not create a dependency.

Every pair of Tasks in one lane must be ordered by a dependency path. This is checked before a coordinator terminal binds to the Run: an unordered pair is refused rather than silently serialized. One unsettled Dispatch occupies a lane at a time; different lanes can run together within Max parallel. If exact lane identity cannot be recovered, its state becomes `unverifiable` and no worker is recreated or moved to Current.

The Workspace lanes panel can show `planned`, `creating`, `active`, `integration_required`, `settled`, `unverifiable`, `removal_blocked`, or `removed`. Treat a warning or `unverifiable` as a request to inspect Orca's worktree and worker evidence, not as permission to guess a path.

## Understand and resolve the integration gate

### Committed Stage handoff

For a join that must be merged **before development**, create two dependency-ordered Tasks. The first is a merge-preparation Task with `[orca-dag:merge-prep]` in its spec and all source Stages as direct dependencies. Its only job is to merge the source commits into the target worktree, resolve conflicts, commit, and leave the worktree clean. The second is the development Task; make it depend on the merge-preparation Task and place it in the same worktree. The merge-preparation Task and its development Task may use the same harness, although Orca does not guarantee the same agent session.

If a Run contains a merge-preparation Task, the viewer captures its starting Git HEAD as an immutable base. New Stage worktrees are created from that commit; remove per-placement base-branch overrides. Every successful Stage must end with a clean committed worktree. The viewer records the actual worktree path, branch, Dispatch, and HEAD SHA under the repository's Git metadata in `orca-dag/stage-git/`, then sends the merge worker its dependencies' paths and SHAs. The agent chooses how to resolve conflicts and makes history-preserving merges. The viewer verifies that every dependency SHA is an ancestor of the clean target HEAD before it records merge preparation as complete. It then checks that the development Task starts in that verified worktree. Missing evidence parks downstream work and appears in Run status.

All worktrees in this mode must be local Git worktrees of the same repository. Parallel Tasks cannot share one worktree because they also share one Git index and HEAD; assign them separate worktrees or order them by dependencies. A serial single-worktree chain works. Existing worktrees used for root Stages must be at the captured base commit. If an old Run lacks its Stage evidence file, the viewer refuses to infer past commit tips from branches that may have moved.

### Human integration gate for other Runs

A **cross-lane join** occurs when a Task's own lane differs from a direct dependency's lane. Current counts as its own workspace in this check: a Current integration Task depending on an API lane also joins across workspaces. The coordinator creates one Orca gate for that Task and parks it until the human chooses `integrated`.

This automatic check uses **lane membership**, not the effective path of every per-Stage placement. Two independent Stages placed in separate worktrees without lanes can converge without an automatic integration gate. Put the branches in lanes or add an explicit decision gate to the planned DAG before execution.

To resolve it, first inspect each source lane's changed files and diff in Orca. Choose the target workspace, integrate the needed source changes using the project's Git process, and verify that the target contains them. Then resolve the gate as `integrated` in Operational details. That value records a **human assertion**; Orca-dag does not validate a merge. A normal approval gate and this automatic integration gate have different meanings.

## Review and remove worktrees

Use **Workspace lanes → Changed files / Diff** to open the exact proven workspace. Do not discard a source worktree while it holds unaccounted files or commits. For a removable Git worktree, the viewer requires settled lane ownership and explicit typed confirmation before calling `orca worktree rm`. Live, retained, release-pending, or unverifiable workers block removal. An archive-hook failure remains a refusal; the viewer never automatically waives it or force-removes the directory. Releasing a settled worker terminal alone does not prove the worktree is safe to remove.
