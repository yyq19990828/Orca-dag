---
name: orca-dag
description: "Plan software work as an Orca orchestration task DAG. Use when the user wants to break a feature or project into an executable graph of tasks with dependencies and approval gates in Orca, then visualize and fire it. Teaches the exact `orca orchestration` CLI commands to build the DAG, the spec-writing conventions, and how to open the orca-dag viewer so the user can pick a harness per node and fire tasks."
---

# orca-dag

Refine a software requirement through conversation and land it as an **Orca orchestration task DAG** (directed acyclic graph). You own **the project workflow** — requirements, PRD, technical design, and the shape of the graph. **Execution is triggered by the user in the `orca-dag` viewer** — the viewer advances the whole graph automatically, in parallel, along its dependencies. It is not fired node by node.

This skill is deliberately **thin about orchestration commands**. Command flags, JSON shapes, worker lifecycle, recovery, and gate rules belong to the **runtime-matched orchestration guide your resolved CLI prints** — load it (Step 2) and follow it. Copy-pasted command syntax here would silently drift from the installed runtime; this file only adds the project workflow around that guide. If the guide and this file ever disagree, **the guide wins**.

Every planning result **must be written into Orca's orchestration state** (by running orchestration commands), not left as chat text — the viewer polls Orca live and draws whatever is there.

## Tools you may use
- **Bash** to run the resolved Orca CLI and read/write orchestration state.
- **Read / Write / Edit** to write planning docs in the working directory (`docs/PRD.md`, `docs/TECH_SPEC.md`).
- Do not run destructive commands unrelated to this task (`rm`, `git push`, deleting files, …).

## Step 1 — resolve the Orca CLI (once, before anything else)

The wrong binary silently breaks everything: on Linux outside Orca, plain `orca` is usually GNOME's **screen reader** (`/usr/bin/orca` — its `--version` prints a small number like `42.0`), not the Orca IDE. Resolve **one** executable, in this order (the same rules the viewer uses):

1. `ORCA_CLI_COMMAND` from the environment (exact quoted argv, parsed without a shell);
2. `orca-dev`, when `ORCA_DEV_REPO_ROOT` is set;
3. on **Linux outside a managed Orca terminal**, `orca-ide`;
4. otherwise plain `orca`.

Verify before using: `<cli> status --json` must report `result.runtime.appVersion` **≥ 1.4.205** (the execution baseline; on 1.4.160–1.4.204 the viewer stays view-only). Then use this **one literal executable for every command in this session** — never switch mid-run. The runtime guide writes `ORCA` in its examples: that always means the binary you resolved here.

## Step 2 — load the runtime-matched orchestration guide (required)

Before asking planning questions or touching orchestration state, load the guide and follow it for every orchestration command — its flags, JSON shapes, worker lifecycle, completion accounting, and gate rules are the authority:

```bash
<cli> skills get orchestration
```

When you reach decision gates, also read its bundled reference (`<cli> skills get orchestration --reference references/messaging-and-gates.md`; `--references` lists the names). If the CLI rejects `skills get` entirely, stop and report the runtime version — the viewer needs ≥ 1.4.205 to execute anyway.

## Preflight
```bash
<cli> status --json      # result.runtime.state should be "ready"; if not, ask the user to run `orca open` first
                         # result.runtime.appVersion must be >= 1.4.205 for the viewer to execute the DAG
```

## Workflow (three phases, all in conversation)
1. **Requirement clarification (PRD)**: align on the goal, MVP scope, and explicit non-goals with short questions — one key question at a time. If MVP is enough, plan only P0; don't over-design. Once agreed, write `docs/PRD.md`.
2. **Technical design (TECH_SPEC)**: stack, data model (down to fields), module interfaces (pseudocode). Write `docs/TECH_SPEC.md`.
3. **Decompose into a task DAG**: split the design into parallel/serial subtasks and write them into Orca (next section). **This step is the required output.**

## Writing the DAG into Orca (the core)

One Run holds one DAG — Orca only treats a Run as a namespace, so this is a convention, but the viewer renders it that way. The runtime guide owns the exact command syntax; conceptually you will:

- **Open a fresh Run** for this plan (`run-create`) and note the returned `run_*` id — `run-create` binds the **current terminal** as that Run's coordinator, so later calls stay scoped. To replan, open a **new** Run — **never** `reset`.
- **Create tasks one by one**, passing each task's dependencies as a **JSON array** of earlier task ids. Deps may only point at tasks **within the same Run**, and they are what make the viewer execute in the right order — **remember every returned task id**.
- **Self-check the graph after each batch** with a Run-scoped read (`task-list --run <run_id> --json`): verify the dependency arrows, because a wrong edge **cannot be fixed after creation** (see Boundaries).
- **Write self-contained specs** — the guide's *Task-spec contract* is the floor: target, change, constraints, ownership, observable acceptance. The future executing worker must **never have to ask a question or enter plan mode**; use imperative sentences and avoid vague phrasing like "investigate" or "as appropriate".
- **Plan workspace placement through the viewer, not the graph**: by default every task executes in the coordinator's current workspace. Tasks that must not share one working tree can be executed in isolated local workspaces — an exact existing workspace, a stacked child worktree, or an independent top-level one — and a dependency-ordered chain may share one such workspace as a serial lane. Which task goes where is **viewer-side launch configuration**, not Orca task state; when isolation matters, say so in the task spec ("run in your own isolated workspace; do not write outside it") and let the operator pick the placement per node in the viewer.
- **Expect integration checkpoints at converging branches**: work done in different workspaces never merges itself. If two branches of your DAG will converge on a downstream task, say in that task's spec that it builds on **integrated** code — the viewer holds such a join behind an explicit human integration checkpoint before starting it.
- **Add a decision gate** where human approval is needed (e.g. "approve the TECH_SPEC and move to execution?") — the guide's gates reference has the rules; the viewer surfaces approve/reject buttons.

## After the DAG is built: open the viewer and let it execute
Once the graph is right, ask the user to open the viewer and **tell them the Run id**:
```bash
npx orca-dag    # run in the current project directory; serves http://localhost:8787 and opens the browser
```
(If it's already running — likely, since that command also installed this skill — they just reselect the Run.) The user picks your Run in the top bar, chooses a harness (and optionally model/effort and a workspace placement) per node, and clicks **"▶ Run with Orca"**: the viewer's coordinator uses Orca's supervised-worker primitives to execute the whole graph in dependency-parallel order and resolve approval gates as they pop.

**Prefer firing execution from the backend.** When you are asked to start the run yourself, trigger the same call the button makes through the viewer's local HTTP API — do not hand-drive orchestration from your terminal:

```bash
TOKEN=$(curl -s localhost:8787/api/session | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s -X POST localhost:8787/api/run -H "X-Orca-Dag-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"runId":"<run_id>","defaultHarness":"claude","maxConcurrency":2}'
```

The viewer then binds **its own** terminal as the Run's coordinator and runs the whole loop autonomously — parallel waves, inbox consumption with per-pass acknowledgements, retries, gate surfacing, terminal release — and native check receipts stream into its Chat panel. Your terminal is fenced from mutations against that Run (`consumer_fenced`); reads stay open.

Hand-driving workers from your terminal is the **fallback for one-off delegations only**: it re-implements the viewer's loop token by token, never acks unless you remember to (an unacked Delivery deadlocks the worker's mailbox — see Boundaries), and leaves no native records in the viewer.

**Execution is the viewer's job, not yours.** Your responsibility ends at "the DAG is correct" — by default do **not** run `dispatch` / `worker-start` yourself unless the user explicitly asks you to drive from the command line.

⚠️ **You will get fenced — this is normal.** Starting execution binds the viewer's own terminal as the Run's coordinator, so your subsequent mutations against that Run fail with `consumer_fenced`. Reads (`task-list --run <id>` / `gate-list --run <id>`) are unaffected. To take the binding back, re-bind yourself as coordinator (`run-use`), following the runtime guide's authority rules.

## Boundaries and known constraints
- Focus on **planning + graph building**. Execution belongs to the viewer's coordinator.
- **Created tasks cannot be edited or deleted**: `task-update` only changes `--status` / `--result` — there is no interface to change spec/title/deps, and no command to delete a single task. You can still **add** new tasks or gates to a Run that hasn't finished (additions are creates), but to **change** an existing task or dependency, open a **new Run and redraw** the whole DAG; the old Run stays as history.
- **Never `reset`.** `orchestration reset --tasks` has **no `--run` scope**: it wipes the entire local orchestration DB, deleting every Run's tasks at once. The only correct "redo" is a fresh Run.
- **Unacked deliveries deadlock a mailbox (worker-side).** Orca's inbox is FIFO: the oldest unacknowledged Delivery replays on every check until it is acked, and messages behind it stay invisible. A worker that answers mail but never acks goes permanently deaf while looking alive — coordinator follow-ups, including the completion signal, never surface (observed live on 1.4.205: the worker even armed its own inbox watcher, which the replaying old batch starved forever). The viewer's coordinator cannot hit this — it processes and acknowledges every delivery on every pass. If you ever drive workers by hand: ack each delivery after processing it, and when a provably-live worker goes silent, suspect this deadlock (the receipt names the delivery id) before assuming anything worse.
- The retired scheduler commands (`orchestration run` / `run-stop` / `coordinator-start` / `coordinator-stop`) are no-ops — don't use them.
- Don't run destructive or off-task system commands.

## Communication style
- Follow the user's language. Concise and direct.
- After each batch of task creation, summarize the DAG's current shape in one sentence (what runs in parallel, what is serial) — the user is watching it appear in the viewer.
