# Phase 4 evidence — DAG hierarchy and ready-wave explanation

Plan: `docs/plans/1789983822_phase-4-dag-hierarchy-and-ready-waves.md`, governed by the
operations Epic (`1789983818_orca-orchestration-operations-epic.md`), outcome O5.
Baseline: Phases 1–3 committed (`0ca2b65`, `8e83f6c`); nothing committed or pushed here.

## What changed

### Server (DAG projection + readiness facts)

- `server/src/orca.ts`
  - `DagNode.parentId` — Task `parent_id` preserved verbatim (dangling ids kept on the
    node, so nothing is silently hidden).
  - `DagHierarchyLink` — parent → child links emitted as a SEPARATE structure from
    dependency `edges`; link ids use the `__hier__` namespace (`<parent>__hier__<child>`)
    so they can never collide with or be mistaken for dependency edge ids.
  - `tasksToDag` now returns `{ nodes, edges, hierarchy }` — a parent relation never
    creates a dependency edge and vice versa.
  - `explainReadiness(tasks, gates, occupancy)` — pure projection over Run-scoped
    facts only: `ReadyWaveView` (Orca-`ready` task ids sorted by id — array order
    implies NO scheduling precedence; `freeSlots: null` when no viewer coordinator
    runs the Run — unknown, never zero) plus per-node `DagNodeReadiness`
    (`runnable`, codes `unmet_dependencies | pending_gate | waiting_for_capacity |
    in_flight | already_finished | unknown`, human reasons, and evidence arrays
    `unmetDependencyIds` / `pendingGateIds`). The open-gate predicate matches the
    GatePanel rule exactly (`pending`/`open`/no resolution). A pending/blocked task
    with nothing visible against it is `unknown` — the state the coordinator nudges
    to `ready` — never an invented blocker.
- `server/src/coordinator.ts` — `coordinatorStatus()` now exposes `maxConcurrency`
  (`null` while not running) so capacity can be attributed honestly.
- `server/src/app.ts` — `GET /api/dag` returns
  `{ runId, nodes, edges, hierarchy, gates, readyWave, readiness, generatedAt }`.
  Occupancy is injected ONLY when this viewer's coordinator is running THIS Run
  (busy = unsettled attempts, budget = configured `maxConcurrency`).

### Web (visual grammar + scheduler surface)

- `web/src/types.ts` — mirror types (`DagNode.parentId`, `DagHierarchyLink`,
  `DagBlockCode`, `DagNodeReadiness`, `ReadyWaveView`), extended `DagResponse`,
  `RunStatus.maxConcurrency`.
- `web/src/components/DagView.tsx` — new `hierarchy` edge type: a calm rounded
  bracket (smooth-step), fine dotted graphite, an open ring resting on the child,
  NO animation and NO filter — deliberately still against the boiling pencil
  dependency arrows. Hierarchy edges are merged BELOW dependency edges (paint
  order) and are NEVER passed to `applyLayout`, so layered LR/TB and force
  layouts rank from dependency edges only and behave exactly as before. The
  `showHierarchy` prop removes them outright.
- `web/src/components/SchedulerPanel.tsx` (new) — compact scheduler/ready-queue
  card on the canvas (top-left; separate from Activity/Chat): ready wave with the
  "id order — equally ready tasks are equally dispatchable" caption, capacity line
  (provenance-labeled: viewer-coordinator fact, or "not running this Run —
  capacity unknown"), ready chips (dashed border when parked on capacity), and up
  to seven waiting rows each with the first evidence-backed reason (rest via hint).
  Click-to-select only; read-only by design.
- `web/src/components/NodePanel.tsx` — scheduler section on the node card:
  "Sub-stage of … (ownership only — not a dependency)", "Parent of N sub-stages",
  and the node's readiness reasons with per-code glyphs; "Ready — dispatchable
  now." for runnable nodes.
- `web/src/App.tsx` — relation legend (`⇢ dependency · ┄ parent`) + "Hide/Show
  parent links" toggle in the toolbar; SchedulerPanel mounted on the canvas;
  selected node's parent/child labels and readiness resolved within the Run
  (dangling parent shows the raw id).
- `web/src/styles.css` — hierarchy-edge grammar, scheduler panel, relation legend,
  node-panel scheduler section; `prefers-reduced-motion` unaffected (nothing
  animates on hierarchy edges).

### Docs

- `README.md` / `README_zh.md` kept in sync: two new feature bullets (hierarchy vs
  dependencies; scheduler panel) and the `/api/dag` response shape.

## Acceptance → evidence

| Acceptance criterion | Implementation | Tests / verification |
| --- | --- | --- |
| Server tests distinguish parent links from dependency edges | `tasksToDag` separate `hierarchy` structure | `server/src/dag.test.ts` › "DAG projection: hierarchy is distinct from dependencies" (parent≠dependency, dependency≠parent, dangling parents, id namespaces) |
| Ready-wave tests cover unmet dependencies and gates | `explainReadiness` | `dag.test.ts` › ready wave ordering; unmet dependency (with upstream status in the reason); pending gate (question + gate id as evidence); both at once; resolved/run-level gates ignored; capacity full/free/unknown; in-flight/finished; unknown states |
| UI visibly differentiates both relation types | dotted still bracket vs boiling pencil arrow | headless-browser smoke run against the real server + fake Orca: 3 `react-flow__edge-hierarchy` + 4 `edge--done`/`edge--idle` edges in one graph; screenshots |
| Explains at least one blocked and one ready stage | SchedulerPanel + NodePanel | smoke: "Publish (gated)" shows unmet dep + pending gate reasons; "UI: hierarchy + wave" chip in the ready queue; `GET /api/dag` verified live (`task_gate → [unmet_dependencies, pending_gate]`) |
| Parent links hideable | toolbar toggle | smoke: toggle flips 3 ↔ 0 hierarchy edges; "Show parent links" label state |
| Manual drag, re-layout, communication-panel fit intact | layout effect untouched except hierarchy excluded from layout input; drag map logic unchanged; fit/reorg nonces untouched | code review; smoke: hide/show toggle and layout re-runs do not move untouched nodes |
| `npm run check` passes | — | green: skill frontmatter ok · typecheck both packages · server tests 298/298 (incl. 15 new Phase 4 tests) · vite build |
| Do not infer order among ready tasks | `readyWave.taskIds` sorted by id + explicit UI caption | `dag.test.ts` reversed-input ordering test |
| Parent is not a dependency | links never in `edges`; no readiness effect; no layout effect | `dag.test.ts` first suite |

## Constraints compliance

- Every explanation derives from Run-scoped `task-list`/`gate-list` rows plus this
  viewer coordinator's own occupancy; capacity is `null` (unknown) whenever the
  viewer coordinator isn't running the Run — never guessed zero.
- No Task mutation for presentation metadata; Orca authority untouched.
- Prior phases preserved: their suites run green in the same 298-test pass; the only
  prior-file touch outside Phase 4 scope is the one-field `activity.test.ts` fixture
  update required by the new `coordinatorStatus()` field.
- Nothing committed or pushed; `.orca-dag.config.json` untouched (smoke run used a
  throwaway workspace in /tmp/opencode).
