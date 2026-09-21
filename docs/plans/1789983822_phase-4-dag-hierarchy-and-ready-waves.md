# Phase 4: DAG Hierarchy and Ready-Wave Explanation

## Objective

Make parent/child ownership and scheduler readiness understandable without conflating hierarchy with dependency order.

## Scope

- Preserve Task `parent_id` in the server and web DAG models.
- Add a distinct hierarchy representation: grouping, lane, nesting or separately styled parent links.
- Compute and expose the current ready wave.
- Explain why pending or blocked nodes are not runnable: unmet dependencies, pending gate, concurrency occupancy, or unknown state.
- Add a compact scheduler/ready-queue panel that remains separate from Activity/Chat.

## UX requirements

- Dependency arrows keep their current semantic and layout behavior.
- Parent/child relations must use a different visual grammar and be hideable if they reduce readability.
- Every explanation must be derived from Run-scoped task/gate/coordinator facts.
- Re-layout and fit behavior must continue to respect manually dragged nodes.

## Likely files

- `server/src/orca.ts`
- `server/src/app.ts`
- server DAG tests
- `web/src/types.ts`
- `web/src/layout.ts`
- `web/src/components/DagView.tsx`
- `web/src/components/TaskNode.tsx` or related node component
- `web/src/App.tsx`
- `web/src/styles.css`

## Constraints

- Do not infer scheduling order among equally ready Tasks.
- Do not treat a parent relation as a dependency.
- Do not mutate Tasks to store presentation metadata.
- Preserve horizontal, vertical and force layouts.

## Tests and acceptance

- Server tests distinguish parent links from dependency edges.
- Ready-wave tests cover unmet dependencies and gates.
- UI visibly differentiates both relation types and explains at least one blocked and one ready stage.
- Manual drag, re-layout and communication-panel fit behavior remain intact.
- `npm run check` passes.

