# Readable orchestration layout

## Goal and decisions

Help an operator answer, in order: what is happening, what needs my decision,
which task or worker is involved, and what evidence supports the state.
Keep the existing paper/crayon identity and canvas. Use existing React state,
native disclosure controls and CSS, with no new dependencies or backend contract.

| Reading level | Surface | Content |
| --- | --- | --- |
| Orientation | Run header and stage overview | Selected objective, completion, six task-state counts, stale-read notice |
| Action | Operations: Decisions & recovery | Attention summary, approvals, interrupted starts and recovery |
| Execution | Operations: Workers & workspaces | Task names, liveness, terminal state, host/model, workspace lanes |
| Evidence | Operations: History & diagnostics | Readable request history, exact identifiers on expansion, runtime capabilities |
| Task result | Stage inspector, before configuration | Report summary/body/files, or arbitrary JSON as named fields and lists |

The minimal implementation groups existing panels instead of adding routes or
duplicating action controls. Attention links select the correct category and
focus the existing control; worker links clear conflicting list filters.
Operations opens from its own toolbar button, outside the Activity/Chat tabs.
Both panels share a resizable rail and preserve the last communication tab.
Category state is local to the page. Existing Run scope, launch locks, permissions,
polling guards and requested-versus-observed distinctions remain authoritative.

## Presentation rules

- Known operation and terminal codes have English/Chinese labels. Unknown codes
  remain verbatim; translation never grants permission or implies completion.
- `absent` requests mean no runtime record, not proof that nothing happened.
- Resolve task names from the current DAG. Keep full task, Dispatch, request and
  Run identifiers in expanded evidence; unknown names fall back to their IDs.
- Structured results preserve `false`, `0`, null, empty collections, unknown
  keys, arrays and nested objects. Native disclosures reveal nested collections.
- Worker report fields are type-checked before formatting. Long bodies expand
  independently of diagnostic data. Original JSON remains available verbatim.
- Preserve paper colors and sketch headings. Use the system reading font for
  factual prose, wrapping long values and using tabular numbers for counts.
- Execution notices occupy their own header row, so they cannot cover navigation.
  Below the existing overlay breakpoint the side panel still uses the app's
  mobile layout; category buttons wrap text within three equal columns.

## Implementation and acceptance

`App.tsx` owns category selection and overview counts. `WorkerPanel` and
`RequestAuditPanel` reuse the DAG label map. `ResultSummary` and `StructuredData`
separate report content from diagnostic evidence. Styling extends the existing
`operations-nav.css` and `compact-header.css`; all new copy is paired in en/zh.

Run the repository gate with `npm run check`. On macOS, the existing socket tests
need a short, canonical temporary directory: `TMPDIR=/private/tmp npm run check`.
This avoids Unix socket path truncation and `/tmp` versus `/private/tmp` mismatch.

The repeatable browser check uses Playwright CLI and intercepts all API traffic:

```sh
npm run dev:web
# In another terminal, with Playwright CLI available:
mkdir -p output/playwright
playwright-cli open http://localhost:5173
playwright-cli run-code "$(cat scripts/check-ui-layout.js)"
```

It checks both locales at 1280, 900, 620, 375 and 320 pixels; task result panels
at desktop and mobile widths; gate/worker attention navigation; filtered-worker
navigation; absent request semantics; nested, falsy and malformed results;
literal text safety; full reports; and page/panel overflow. Screenshots go to
`output/playwright/`. These are presentation fixtures, not evidence of real worker
execution. Live Run data was also inspected without starting or stopping workers.

Rollback is limited to frontend source and this check/documentation. No database,
configuration schema, release, commit or external state migration is required.
