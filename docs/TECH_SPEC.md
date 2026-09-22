# Technical Specification: Orca-Native Worktree Orchestration Expansion

## Design source and boundaries

This specification operationalizes `docs/PRD.md`. The completed implementation plans are intentionally not shipped; live acceptance evidence remains at `docs/plans/1790067675_phase-6-acceptance-evidence.md`. The installed Orca 1.4.206 orchestration guide and CLI help are authoritative for command syntax and lifecycle evidence.

The implementation preserves these boundaries:

- `server/src/orca.ts` is the only subprocess adapter layer.
- All Orca calls use the process-wide resolved executable, `shell: false`, and the resolved workspace cwd.
- `.orca-dag.config.json` stores launch intent, never runtime authority.
- Orca receipts and structured reads decide what exists and which selector is reusable.
- Generated and runtime artifacts remain unedited and uncommitted.

## Configuration model

```ts
type SetupPolicy = "run" | "skip" | "inherit";

interface CreationOptions {
  name?: string;
  setup: SetupPolicy;
  baseBranch?: string;
  displayName?: string;
  comment?: string;
}

type NewChildPlacement = CreationOptions & {
  kind: "new-child";
};

type NewTopLevelPlacement = CreationOptions & {
  kind: "new-top-level";
  repo: string;
};

type PlacementSpec =
  | { kind: "current" }
  | { kind: "existing"; selector: string }
  | NewChildPlacement
  | NewTopLevelPlacement;

interface WorktreeLaneSpec {
  placement:
    | { kind: "existing"; selector: string }
    | NewChildPlacement
    | NewTopLevelPlacement;
}

interface ViewerConfig {
  placementByTask?: Record<string, PlacementSpec>;
  worktreeLanes?: Record<string, WorktreeLaneSpec>;
  laneByTask?: Record<string, string>;
}
```

Rules:

- Absent placement means local `current`.
- A task cannot have both `placementByTask` and `laneByTask`.
- A task with a saved environment can use only exact existing or `new-top-level`.
- Current/existing reject `repo`, `name`, `baseBranch`, `displayName`, `comment`, and `setup` creation fields.
- New top-level requires an exact Orca-discovered repository selector.
- Runtime worktree IDs, paths, terminal handles, Dispatch IDs, and capability grants never enter config.

## Runtime projections

```ts
interface WorktreeLaneRuntimeView {
  laneId: string;
  taskIds: string[];
  state:
    | "planned"
    | "creating"
    | "active"
    | "integration_required"
    | "settled"
    | "unverifiable"
    | "removal_blocked"
    | "removed";
  selector: string | null;
  worktreeId: string | null;
  path: string | null;
  branch: string | null;
  head: string | null;
  creationDispatchId: string | null;
  activeDispatchIds: string[];
  source:
    | "worker_start_receipt"
    | "worker_list"
    | "worker_show"
    | "worktree_show"
    | null;
  warnings: string[];
}
```

Missing identity produces `unverifiable`; it never produces a guessed selector or a replacement worktree.

## Placement adapter

`WorkerStartRequest` gains optional creation fields and maps placement as follows:

```text
current       -> --worktree current
existing      -> --worktree <exact-selector>
new-child     -> --worktree new-child --name ... [creation flags]
new-top-level -> --worktree new-top-level --repo <exact-repo> --name ... [creation flags]
```

Only the two new-worktree modes emit `--base-branch`, `--display-name`, `--comment`, or `--setup`. If name is absent, the server derives a deterministic bounded name from the Run and Task/lane IDs before calling Orca.

Local discovery interfaces:

- `GET /api/worktrees` returns Orca-discovered local workspaces.
- `GET /api/repos` returns Orca-discovered local repositories.
- Before start, exact workspace/repository identity is revalidated through Orca.

## Lane scheduling

Before coordinator mutation:

1. Validate placement/environment compatibility.
2. Validate that all tasks sharing a lane are totally ordered by dependency reachability.
3. Reject a lane containing parallel-ready tasks.
4. Reject non-current legacy harness placement before creating a terminal or Dispatch.

At dispatch:

```text
if task is in current lane:
  start in current
else if lane has positively recovered selector:
  start on exact selector with no creation flags
else if lane seed is existing:
  revalidate and start on exact selector
else:
  create through worker-start using lane seed metadata
  retain exact identity from positive Orca evidence
```

One lane may own at most one unsettled Dispatch. Different lanes may consume separate global concurrency slots.

## Integration gates

A task crosses lanes when any direct dependency ran in another lane or its direct dependencies span multiple lanes. Before worker start, the coordinator creates one idempotent Orca task gate with a stable viewer marker and only the `integrated` resolution.

Restart recovery uses Run-scoped gate reads plus the stable marker. Gate IDs and resolutions are not persisted as launch preferences. Resolution records a human assertion; it is not presented as a verified Git merge.

## Operator APIs

- `POST /api/workers/:dispatchId/stop`
- `POST /api/workers/:dispatchId/abandon`
- `POST /api/workers/:dispatchId/focus`
- `GET /api/runs?cursor=<opaque>&limit=<n>`
- `GET /api/runs/:runId`
- `GET /api/worktree-lanes?run=<id>`
- `POST /api/worktree-lanes/:laneId/open-changed`
- `POST /api/worktree-lanes/:laneId/remove`

All mutation routes are loopback-only and token-protected. Stop requires positive active evidence. Abandon requires positive exit/outcome-unknown evidence or Orca's literal next action. Focus requires a fresh local exact `agentWait` observation. Removal requires settled ownership, explicit confirmation, and `orca worktree rm`.

## Module ownership for DAG execution

The implementation Run avoids same-file parallel edits:

- Foundation task owns `server/src/config.ts`, `server/src/security.ts`, `server/src/orca.ts`, and their focused tests.
- Scheduling task owns `server/src/coordinator.ts`, `server/src/coordinator.test.ts`, and DAG tests.
- HTTP/operator task owns `server/src/app.ts`, request/activity modules, and their tests.
- Web task owns `web/src/**` only.
- Integration task runs after all parallel tasks and may reconcile cross-module type or contract mismatches.
- Documentation task runs last and owns README, skill guidance, and acceptance evidence.

Workers must preserve edits already present from completed predecessors and must not revert unrelated user changes.

## Verification matrix

### Automated

- Config round trips and malformed-entry handling for all placement shapes.
- Security validation for selectors, creation metadata, local/remote matrix, and conflicting fields.
- Exact `worker-start` argv for all four local placement modes.
- Lane ordering, concurrency, restart adoption, exact-selector retry, and unverifiable refusal.
- Idempotent integration gate creation and recovery.
- Stop/abandon/focus evidence gates and request audit.
- Run pagination, exact ownership checks, file review, and removal preconditions.
- Strict TypeScript, Node tests, skill validation, web build, and `npm run check`.

### Manual

- Browser pass over placement editors, lane state, gates, operator controls, history, review, and cleanup.
- Live Orca IDE pass for current, exact existing, child, and top-level workers.
- Positive visibility of Orca-created worktree lineage and metadata.
- Cleanup only through Orca with every acceptance worktree retained or explicitly removed.

## Rollback and failure behavior

- Config changes are additive; removing new local placement/lane entries returns unstarted local tasks to current-workspace behavior.
- Existing Orca worktrees remain registered after rollback.
- Ambiguous creation, gate, stop, abandon, release, or removal responses remain auditable and are not repeated with a new request ID.
- Absence never authorizes retry, replacement, fallback to current, or cleanup.

## Execution profile

Every DAG task uses harness `opencode` with model `zai-coding-plan/glm-5.3-flash#max`. The viewer currently has no model-fallback field, and the user explicitly chose not to add one for this Run. Maximum concurrency is three.
