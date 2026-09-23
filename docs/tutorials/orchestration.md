# Tutorial: plan and run an Orca task DAG

English | [简体中文](orchestration_zh.md)

This tutorial follows one feature from requirement to completed Run. It describes the `orca-dag` viewer and the Orca 1.4.209 CLI checked while writing it. **Load your installed CLI's guide before using command flags:** `orca skills get orchestration` (or the executable selected by [the project skill](../../skill/SKILL.md)). Your runtime's guide and `--help` take precedence over examples here. Orca 1.4.205 is the viewer's execution floor.

## The objects and the reason for the viewer

| Object | Meaning | Consequence |
| --- | --- | --- |
| Run | Durable namespace and coordinator inbox. | One Run per DAG is this project's convention; Orca does not schedule a Run. |
| Task | Work item with a spec, status, optional `parent`, and `deps`. The viewer calls a Task a **Stage**. | `deps` determine readiness; `parent` describes hierarchy and does not order work. |
| Dispatch | One authoritative attempt to run a Task, identified by a `ctx_*` ID. | A retry creates another Dispatch for the same Task; inspect the exact attempt before acting. |
| Gate | Decision attached to a Task. | The Task waits for the gate's resolution, even if its dependencies finished. |
| Delivery | A batch of coordinator mailbox messages. | The coordinator processes and acknowledges it; an unacknowledged batch replays and hides later mail. |

Orca provides these records and worker lifecycle operations, but deliberately does not pick the next ready Task, placement, or parallelism. The viewer's coordinator loop makes those choices and calls the resolved Orca CLI. Its terminal is bound to the Run for mutation authority; other terminals can read the Run, but a competing mutation is fenced. The viewer asks for confirmation when it takes this binding.

## Worked example: CSV export

Ask the planning agent to define the CSV format first, then let API and UI work proceed in parallel:

```text
A  CSV contract
├─ B  API export ──┐
└─ C  UI action ───┴─ D  Final verification
```

| Task | Dependencies | Scope and acceptance |
| --- | --- | --- |
| A | None | Define columns, quoting, encoding, and error behavior; publish a contract B and C can implement. |
| B | A | Implement the export endpoint in its owned server files; show a representative CSV response. |
| C | A | Add the download action in its owned web files; show the expected request and download behavior. |
| D | B and C | Verify that the changes already integrated into its target workspace work end to end, and report the result. |

One Task spec should stand on its own. For example:

> **Target:** report export endpoint and its CSV serializer. **Change:** implement the agreed columns and escaping. **Constraints:** keep the current authorization and pagination contracts. **Ownership:** edit the server export files in the workspace assigned to this Dispatch; do not edit UI files or integrate another branch. **Acceptance:** report a representative CSV output, the check performed, changed files, and any uncommitted work.

Give the planner a request such as: “Use the `orca-dag` skill to write a PRD and technical design for CSV export, create a new Run with Tasks A–D and these dependencies, verify the stored graph, and return the Run ID. Leave execution to the viewer.” The skill writes the planning documents in the **target project**, not this repository's historical plan files.

## Planning parameters in Orca

The current CLI exposes these parameters. Let the agent obtain the exact syntax from `skills get orchestration` and the relevant command's `--help` before mutating a Run.

| Operation | Key parameters | What to check |
| --- | --- | --- |
| `run-create` | `--objective <text>`; `--from <handle>` when calling outside the bound Orca terminal; `--json` for a receipt. | Save the returned `run_*` ID and the coordinator binding. A Run does not launch workers. |
| `task-create` | `--spec <text>`, optional `--task-title` and worker `--display-name`, `--deps <json_array>`, `--parent <task_id>`, `--run <run_id>`. | `--deps` receives JSON text such as `["task_A"]`, using existing Task IDs in the same Run. `--parent` is only a hierarchy link. |
| `task-list` | `--run <run_id>`, optionally `--ready`, `--brief`, or `--status`; `--json`. | Read back IDs, full specs, statuses, and dependency arrows. `--brief` truncates echoed specs to 160 characters, so omit it when auditing a spec. |
| `gate-create` | `--task <task_id>`, `--question <text>`, `--options <json_array>`. | Use a gate for an actual coordinator decision, not for an ordinary worker question. |
| `gate-list` / `gate-resolve` | List with `--run <run_id>`; resolve with `--id <gate_id>` and `--resolution <choice>` from the bound coordinator. | Resolution uses the binding rather than a `--run` flag. The viewer also offers gate controls. |

Mutations accept `--retry-request <id>` for exact recovery when a response is lost. It identifies the **same** requested operation; it is not a general “try again” switch. Inspect `request-show` and the affected records before replaying anything. For a worker's blocking question, use Orca's `ask`/`reply` flow instead of creating a gate. The runtime guide covers those message parameters.

Create the Tasks in dependency order, recording each returned ID before using it in a later `--deps` array. Read the Task list after each batch. A stored Task's spec, title, and dependencies cannot be edited or individually deleted; if the graph is wrong, create a fresh Run and redraw it. **Never** use `orchestration reset --tasks` to redo one DAG: that command clears Tasks across the local orchestration database.

### Worker and mailbox parameters you will see

The viewer handles this lifecycle during a normal Run. These parameters matter when reading receipts or deliberately coordinating from a CLI:

| Operation | Key parameters | Rule |
| --- | --- | --- |
| `worker-start` | `--task <task_id>`, `--agent <agent>`, placement `--worktree`, optional `--model` and `--effort`. | Starts one supervised Dispatch; `--spec` would create a new Task. A failed start's receipt names its stage and residual resources. |
| `send` with `--type worker_done` | Exact `--task-id`, `--dispatch-id`, `--outcome succeeded\|failed`; optional real `--files-modified` and `--report-path`. | Only the active dispatched worker can settle its Task. It sends this once, then stops acting under those IDs. |
| `check` | `--terminal <handle>` outside the caller's Orca terminal; `--wait`, `--types`, `--timeout-ms`, `--ack <delivery_id>`. | `--types` changes when a wait wakes, not which messages are delivered. Process the whole oldest batch before acknowledging it. `check` does **not** use `--from`. |
| `reply` / `send` | Reply with `--id <message_id>` and `--body`; send guidance to `dispatch:<id>`. | A successful send proves durable enqueue, not that the worker read it. A worker question uses `ask`/`reply`, not a decision gate. |
| `worker-list`, `worker-show`, `worker-read` | Scope the fleet with `--run`, use `--include-remote` for remote workers; inspect one attempt with `--dispatch`. | Fleet liveness and terminal liveness differ. `unverifiable` is missing evidence, not proof of exit. |

The coordinator starts the independent ready wave, consumes questions and completions, chooses reuse/retain/release for each settled worker, acknowledges the Delivery, then checks for newly ready Tasks. A wait timeout is only a checkpoint. Direct CLI coordination requires following the runtime guide's completion accounting and recovery rules; the viewer performs that loop automatically.

## Configure and execute in the viewer

Start `npx orca-orchestration-launcher` from the Orca-managed project root (see [startup parameters](viewer-operations.md#startup-parameters)). Pick the returned Run ID, inspect the DAG, set the default harness and **Max parallel**, then override individual Stage launch choices as needed. These choices live in the viewer's workspace configuration; they are not Orca Task fields.

On **Run with Orca**, the viewer binds its coordinator terminal, snapshots launch choices, and repeatedly starts ready Tasks up to the parallel limit. Dependencies, gates, workspace lanes, and available worker slots can lower the actual concurrency. A successful `worker_done` settles the Task and Dispatch; the coordinator accounts for the terminal by immediate reuse, explicit retention, or release. It also processes and acknowledges every inbox Delivery. A settled Task is not enough to prove its terminal has been cleaned up.

If B and C belong to different **workspace lanes**, D will also wait behind an automatic integration gate. Separate per-Stage worktrees without lane membership do not trigger that gate; plan an explicit checkpoint in that case. The [isolation tutorial](worktree-isolation.md) explains why dependency completion does not move code between worktrees and when to resolve `integrated`.

## Observe completion and change the plan

Use the Scheduler card for readiness reasons, Chat for questions and durable messages, Activity for coordinator actions, and Workers for each Dispatch's liveness and terminal ownership. “Sent” proves enqueue, not reading; a timeout or disconnected host does not prove exit. The [viewer operations tutorial](viewer-operations.md#handle-a-blocked-or-uncertain-stage) gives the recovery path.

Finish by checking each Task's outcome, changed files, integration evidence, and remaining worker ownership. To revise a Task or an edge, ask the agent to create a **new Run**; keep the old Run as history. Planning, executing, integrating branches, and approving gates are distinct steps with distinct owners.
