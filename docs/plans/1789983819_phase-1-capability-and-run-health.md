# Phase 1: Capability and Run Health Foundation

## Objective

Establish the truthful capability, model-variant, Run-ownership and health read models required by every later operations feature.

## Scope

- Recognize Orca 1.4.206 canonical orchestration capability identifiers while retaining safe compatibility aliases.
- Extend OpenCode model validation from `provider/model` to bounded `provider/model#variant` syntax.
- Add a read-only runtime capability projection for the UI.
- Add a selected-Run health projection using `run-show`, scoped task/gate/worker/message reads, and current viewer coordinator state.
- Render a compact Run ownership/health indicator near the Run selector or execution controls.
- Explain empty-but-historical Runs and coordinator ownership without implying mutation authority.

## Required behavior

Run ownership must distinguish at least:

- viewer coordinator owns this Run;
- another/external coordinator is bound;
- no coordinator is bound;
- viewer coordinator belongs to a different Run;
- ownership cannot be verified.

Health warnings must be evidence-based and include useful combinations such as messages-without-tasks, dispatched-task-without-worker, reclaimable resources, or gates blocking work. Do not label a coordinator stale merely because its handle is not in a local terminal list.

## Likely files

- `server/src/orca.ts`
- `server/src/app.ts`
- `server/src/security.ts`
- corresponding server tests
- `web/src/types.ts`
- `web/src/api.ts`
- `web/src/App.tsx`
- `web/src/components/RunPicker.tsx` or a focused new health component
- `web/src/styles.css`

## Constraints

- Do not add new mutations.
- Preserve the 1.4.205 execution floor.
- Unknown and absent capability fields gate features off.
- `#variant` support must not permit spaces, quotes, shell operators or additional path separators.
- Do not expose a Run from another workspace through workspace filtering.

## Tests and acceptance

- Unit tests cover every canonical capability above, legacy aliases, absent capabilities and unknown capabilities.
- Security tests accept `zai-coding-plan/glm-5.3-flash#high` and reject malformed variants and shell-shaped input.
- API tests cover viewer-owned, externally-owned, unbound and empty-with-history Run health.
- UI compiles and displays a readable status without raw JSON.
- `npm run check` passes.

