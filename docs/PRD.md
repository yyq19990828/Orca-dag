# PRD: Quiet and Safer DAG Viewer

## Status

- Planning state: approved direction, pending execution gate
- Product: Orca DAG Viewer
- Runtime baseline: Orca 1.4.205 or newer
- Priority: P0 only

## Goal

Make the viewer safer, easier to scan, and materially cheaper to render without losing its warm crayon identity. The first screen must clearly orient the user to the selected Run and its health, the viewer must not expose a misleading global task reset as if it were Run-scoped, and a stable DAG must stop consuming resources for decorative motion.

## Current problems

1. The top bar places the brand, a long subtitle, Run selection, Run health, Orca connectivity, Run creation, and a destructive action in one flex row without a responsive layout contract.
2. `Clear tasks` calls `orca orchestration reset --tasks`, which deletes tasks in every local Run. Orca cannot delete one Task or clear one Run, so the control conflicts with the selected-Run context and the repository's documented safety boundary.
3. The viewer already pauses its main polling while hidden and skips state replacement for byte-identical responses, but the canvas still runs continuous SVG-filter, CSS, timer-driven scribble, and Web Animations API motion.
4. React Flow currently renders off-screen elements, re-derives layout for visual-only changes, and receives a second `/api/run-status` polling stream from `ExecControls`.

## Approved product decisions

1. Remove task reset completely from the viewer UI and HTTP API. A fresh Run is the only supported way to redraw a DAG.
2. Keep the crayon visual language, but make the canvas static by default.
3. Permit one persistent lightweight running indicator outside the canvas. Canvas feedback is limited to short, one-shot state transitions and direct hover or press feedback.
4. Do not add a motion preference setting. The quiet default and `prefers-reduced-motion` are sufficient.
5. Use React Flow's built-in visible-element rendering rather than introducing a custom virtualization layer.

## P0 scope

### P0.1 Remove global task reset

- Remove the top-bar `Clear tasks` action and its confirmation flow.
- Remove the frontend reset API helper.
- Remove `POST /api/reset` and its tests and documentation.
- Keep `Create Run`, relabeled compactly as `New Run`, as the safe restart path.

### P0.2 Recompose the top information bar

- Use three visual regions: brand, flexible Run context, and health/connectivity.
- Keep the full-width header on one line at desktop widths.
- Switch to a two-row layout below 1024 px.
- Give the Run selector a full row below 620 px and prevent page-level horizontal overflow at 375 px.
- Preserve keyboard access and the Run health popover.

### P0.3 Establish a quiet motion budget

- Stop continuous filter-seed switching on task nodes and dependency edges.
- Stop timer-driven scribble remounting and WAAPI edge tracing.
- Remove looping ready/running auras, progress crawl, canvas confetti, and other decorative infinite motion.
- Preserve static hand-drawn texture, state color, status stamps, short state-change feedback, and button interaction feedback.
- Ensure reduced-motion users receive final visual states with no hidden JS animation loop.

### P0.4 Reduce rendering and polling work

- Enable `onlyRenderVisibleElements` on React Flow.
- Recompute graph layout only when topology, layout mode, or the explicit re-layout nonce changes.
- Update status, selection, lead, and actual harness decoration without recomputing positions.
- Make App the single owner of periodic Run-status polling.
- Stop Run picker and Run health polling while the page is hidden.
- Unmount the inactive Operations tab so its polling panels are not kept alive unnecessarily.

## Non-goals

- Per-Run or per-Task deletion, because Orca does not provide it.
- Changing Orca lifecycle authority or scheduler behavior.
- Replacing polling with WebSocket or another transport.
- Removing the crayon theme or redesigning the whole application shell.
- Adding a new frontend test framework or a persistent performance database.
- Adding a user-facing motion setting.

## User-visible outcomes

1. A user can identify the selected Run, create a new Run, and understand Run and Orca health without the header wrapping unpredictably.
2. No viewer action can wipe tasks from unrelated Runs.
3. A stable graph looks hand-drawn but remains visually still.
4. Running work remains clear through color, labels, the toolbar progress state, and one global running indicator.
5. Large graphs pan and zoom with fewer mounted React Flow elements and without layout churn from selection or harness changes.

## Acceptance criteria

1. The UI contains no `Clear tasks` control and no call to `resetTasks`.
2. `POST /api/reset` returns 404, while all other mutation-token protections remain unchanged.
3. The header has no overlap or page-level horizontal overflow at 1440x900, 1024x768, and 375x812.
4. After one-shot entrance feedback settles for two seconds, `document.getAnimations()` reports no running animation whose target is inside `.dag-canvas`.
5. A stable DAG poll does not cause a React Flow commit.
6. Selecting a node or changing its model or harness does not invoke `applyLayout`.
7. `/api/run-status` has one periodic caller, not two.
8. A hidden page produces no periodic viewer API requests after in-flight requests settle.
9. A dense graph mounts only visible React Flow nodes and edges after zooming into a subset.
10. `npm run check` passes.

## Rollback

Every implementation phase is code-only and has no data migration. Reverting a phase restores the prior behavior. The removed reset endpoint must not be restored as rollback for unrelated UI or performance problems.
